import groupBy from 'lodash/groupBy';
import { type MaybeRef } from '@vueuse/core';
import { type Blockchain } from '@rotki/common/lib/blockchain';
import omit from 'lodash/omit';
import { type Collection, type CollectionResponse } from '@/types/collection';
import { type EntryWithMeta } from '@/types/history/meta';
import {
  type AddTransactionHashPayload,
  type AddressesAndEvmChainPayload,
  type EthTransaction,
  type EvmChainAddress,
  type EvmChainAndTxHash,
  type HistoryEvent,
  type HistoryEventEntry,
  type HistoryEventEntryWithMeta,
  type HistoryEventRequestPayload,
  type HistoryEventsCollectionResponse,
  type NewHistoryEvent,
  type TransactionHashAndEvmChainPayload,
  type TransactionRequestPayload
} from '@/types/history/tx';
import { Section, Status } from '@/types/status';
import {
  BackendCancelledTaskError,
  type PendingTask,
  type TaskMeta
} from '@/types/task';
import { TaskType } from '@/types/task-type';
import { mapCollectionResponse } from '@/utils/collection';
import { logger } from '@/utils/logging';
import { getEthAddressesFromText } from '@/utils/history';
import { startPromise } from '@/utils';
import { type ActionStatus } from '@/types/action';
import { ApiValidationError, type ValidationErrors } from '@/types/api/errors';

export const useHistoryEvents = () => {
  const { t, tc } = useI18n();
  const { notify } = useNotificationsStore();

  const {
    fetchEthTransactionsTask,
    deleteTransactionEvent: deleteTransactionEventCaller,
    decodeHistoryEvents,
    reDecodeMissingTransactionEvents,
    addTransactionEvent: addTransactionEventCaller,
    editTransactionEvent: editTransactionEventCaller,
    addTransactionHash: addTransactionHashCaller,
    fetchHistoryEvents: fetchHistoryEventsCaller
  } = useHistoryEventsApi();

  const { awaitTask, isTaskRunning } = useTaskStore();

  const { removeQueryStatus, resetQueryStatus } = useTxQueryStatusStore();

  const { txEvmChains, getEvmChainName, supportsTransactions } =
    useSupportedChains();
  const { accounts } = useAccountBalances();

  const syncTransactionTask = async (
    account: EvmChainAddress
  ): Promise<boolean> => {
    const taskType = TaskType.TX;
    const { setStatus } = useStatusUpdater(Section.TX);
    const defaults: TransactionRequestPayload = {
      limit: 0,
      offset: 0,
      ascending: [false],
      orderByAttributes: ['timestamp'],
      onlyCache: false,
      accounts: [account]
    };

    const { taskId } = await fetchEthTransactionsTask(defaults);
    const taskMeta = {
      title: t('actions.transactions.task.title').toString(),
      description: t('actions.transactions.task.description', {
        address: account.address,
        chain: account.evmChain
      }).toString()
    };

    const { pause, resume } = useIntervalFn(() => {
      startPromise(reDecodeMissingTransactionEventsTask(account));
    }, 10000);

    try {
      resume();
      await awaitTask<
        CollectionResponse<EntryWithMeta<EthTransaction>>,
        TaskMeta
      >(taskId, taskType, taskMeta, true);
      pause();
      startPromise(reDecodeMissingTransactionEventsTask(account));
      return true;
    } catch (e: any) {
      if (e instanceof BackendCancelledTaskError) {
        logger.debug(e);
        removeQueryStatus(account);
      } else {
        notify({
          title: t('actions.transactions.error.title').toString(),
          message: t('actions.transactions.error.description', {
            error: e,
            address: account.address,
            chain: account.evmChain
          }).toString(),
          display: true
        });
      }
    } finally {
      setStatus(
        get(isTaskRunning(taskType)) ? Status.REFRESHING : Status.LOADED
      );
      pause();
    }
    return false;
  };

  const refreshTransactions = async (
    chains: Blockchain[],
    userInitiated = false
  ): Promise<void> => {
    const { setStatus, resetStatus, fetchDisabled } = useStatusUpdater(
      Section.TX
    );

    if (fetchDisabled(userInitiated)) {
      logger.info('skipping transaction refresh');
      return;
    }

    const txAccounts: EvmChainAddress[] = get(accounts)
      .filter(
        ({ chain }) =>
          supportsTransactions(chain) &&
          (chains.length === 0 || chains.includes(chain))
      )
      .map(({ address, chain }) => ({
        address,
        evmChain: getEvmChainName(chain)!
      }));

    setStatus(Status.REFRESHING);
    resetQueryStatus();

    try {
      await Promise.all(txAccounts.map(syncTransactionTask));
      setStatus(
        get(isTaskRunning(TaskType.TX)) ? Status.REFRESHING : Status.LOADED
      );
    } catch (e) {
      logger.error(e);
      resetStatus();
    }
  };

  const reDecodeMissingTransactionEventsTask = async (
    account: EvmChainAddress
  ) => {
    const taskType = TaskType.TX_EVENTS;

    const payload: AddressesAndEvmChainPayload = {
      evmChain: account.evmChain,
      addresses: [account.address]
    };

    if (get(isTaskRunning(taskType, payload))) {
      return;
    }

    try {
      const { taskId } = await reDecodeMissingTransactionEvents<PendingTask>([
        payload
      ]);

      const taskMeta = {
        title: t('actions.transactions_events.task.title').toString(),
        description: tc(
          'actions.transactions_events.task.description',
          2,
          account
        ),
        ...payload
      };

      await awaitTask(taskId, taskType, taskMeta, true);
    } catch (e) {
      logger.error(e);
    }
  };

  const { fetchEnsNames } = useAddressesNamesStore();
  const fetchHistoryEvents = async (
    payload: MaybeRef<HistoryEventRequestPayload>
  ): Promise<Collection<HistoryEventEntry>> => {
    const result = await fetchHistoryEventsCaller(
      omit(get(payload), 'accounts')
    );

    const { data, ...other } = mapCollectionResponse<
      HistoryEventEntryWithMeta,
      HistoryEventsCollectionResponse
    >(result);

    const notesList: string[] = [];

    const mappedData = data.map((event: HistoryEventEntryWithMeta) => {
      const { entry, ...entriesMeta } = event;

      if (entry.notes) {
        notesList.push(entry.notes);
      }

      return {
        ...entry,
        ...entriesMeta
      };
    });

    startPromise(fetchEnsNames(getEthAddressesFromText(notesList)));

    return {
      ...other,
      data: mappedData
    };
  };

  const addTransactionEvent = async (
    event: NewHistoryEvent
  ): Promise<ActionStatus<ValidationErrors | string>> => {
    let success = false;
    let message: ValidationErrors | string = '';
    try {
      await addTransactionEventCaller(event);
      success = true;
    } catch (e: any) {
      message = e.message;
      if (e instanceof ApiValidationError) {
        message = e.getValidationErrors(event);
      }
    }

    return { success, message };
  };

  const editTransactionEvent = async (
    event: HistoryEvent
  ): Promise<ActionStatus<ValidationErrors | string>> => {
    let success = false;
    let message: ValidationErrors | string = '';
    try {
      await editTransactionEventCaller(event);
      success = true;
    } catch (e: any) {
      message = e.message;
      if (e instanceof ApiValidationError) {
        message = e.getValidationErrors(event);
      }
    }

    return { success, message };
  };

  const deleteTransactionEvent = async (
    eventId: number
  ): Promise<ActionStatus> => {
    let success = false;
    let message = '';
    try {
      success = await deleteTransactionEventCaller([eventId]);
    } catch (e: any) {
      message = e.message;
    }

    return { success, message };
  };

  const fetchTransactionEvents = async (
    transactions: EvmChainAndTxHash[] | null,
    ignoreCache = false
  ): Promise<void> => {
    const isFetchAll = transactions === null;

    let payloads: TransactionHashAndEvmChainPayload[] = [];

    if (isFetchAll) {
      payloads = get(txEvmChains).map(chain => ({
        evmChain: chain.evmChainName
      }));
    } else {
      if (transactions.length === 0) {
        return;
      }

      payloads = Object.entries(groupBy(transactions, 'evmChain')).map(
        ([evmChain, item]) => ({
          evmChain,
          txHashes: item.map(({ txHash }) => txHash)
        })
      );
    }

    const taskType = TaskType.TX_EVENTS;
    const { taskId } = await decodeHistoryEvents({
      data: payloads,
      ignoreCache
    });
    const taskMeta = {
      title: t('actions.transactions_events.task.title').toString(),
      description: tc('actions.transactions_events.task.description', 1)
    };

    await awaitTask(taskId, taskType, taskMeta, true);
  };

  const addTransactionHash = async (
    payload: AddTransactionHashPayload
  ): Promise<ActionStatus<ValidationErrors | string>> => {
    let success = false;
    let message: ValidationErrors | string = '';
    try {
      await addTransactionHashCaller(payload);
      success = true;
    } catch (e: any) {
      message = e.message;
      if (e instanceof ApiValidationError) {
        message = e.getValidationErrors(payload);
      }
    }

    return { success, message };
  };

  return {
    refreshTransactions,
    fetchTransactionEvents,
    addTransactionEvent,
    editTransactionEvent,
    deleteTransactionEvent,
    addTransactionHash,
    fetchHistoryEvents
  };
};