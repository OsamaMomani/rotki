import { Severity } from '@rotki/common/lib/messages';
import { type MaybeRef } from '@vueuse/core';
import { api } from '@/services/rotkehlchen-api';
import { SYNC_DOWNLOAD, type SyncAction } from '@/services/types-api';
import { type TaskMeta } from '@/types/task';
import { TaskType } from '@/types/task-type';

export const useSyncStore = defineStore('syncStore', () => {
  const { isTaskRunning, awaitTask } = useTaskStore();
  const { notify } = useNotificationsStore();
  const { tc } = useI18n();

  const forceSync = async (
    action: MaybeRef<SyncAction>,
    logout: () => Promise<void>
  ): Promise<void> => {
    const taskType = TaskType.FORCE_SYNC;
    if (get(isTaskRunning(taskType))) {
      return;
    }

    function notifyFailure(error: string): void {
      const title = tc('actions.session.force_sync.error.title');
      const message = tc('actions.session.force_sync.error.message', 0, {
        error
      });

      notify({
        title,
        message,
        display: true
      });
    }

    try {
      api.cancel();
      const { taskId } = await api.forceSync(get(action));
      const { result, message } = await awaitTask<boolean, TaskMeta>(
        taskId,
        taskType,
        {
          title: tc('actions.session.force_sync.task.title')
        }
      );

      if (result) {
        const title = tc('actions.session.force_sync.success.title');
        const message = tc('actions.session.force_sync.success.message');

        notify({
          title,
          message,
          severity: Severity.INFO,
          display: true
        });

        if (get(action) === SYNC_DOWNLOAD) {
          await logout();
        }
      } else {
        notifyFailure(message ?? '');
      }
    } catch (e: any) {
      notifyFailure(e.message);
    }
  };

  return {
    forceSync
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSyncStore, import.meta.hot));
}
