import { useCallback, useEffect, useState } from 'react';
import type { NuxxDbClient } from './index';
import type { NuxxSyncState } from './offline/syncManager';

export interface UseSyncStatusReturn extends NuxxSyncState {
  flushSync: () => Promise<void>;
}

/**
 * React hook that subscribes to a `NuxxDbClient`'s offline/online synchronization engine.
 * Exposes `isOnline`, `isSyncing`, `pendingCount`, `lastSyncedAt`, `syncError`, and `flushSync()`.
 */
export function useSyncStatus(client: NuxxDbClient): UseSyncStatusReturn {
  const [state, setState] = useState<NuxxSyncState>(() => client.sync.getState());

  useEffect(() => {
    const unsubscribe = client.sync.subscribe((nextState) => {
      setState(nextState);
    });
    return unsubscribe;
  }, [client]);

  const flushSync = useCallback(async () => {
    await client.sync.flushSync();
  }, [client]);

  return {
    ...state,
    flushSync,
  };
}
