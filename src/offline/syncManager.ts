import type { NuxxOfflineStore } from './indexedDbStore';

export interface NuxxSyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncedAt: string | null;
  syncError: string | null;
}

export class NuxxSyncManager {
  private state: NuxxSyncState = {
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
    isSyncing: false,
    pendingCount: 0,
    lastSyncedAt: null,
    syncError: null,
  };

  private listeners = new Set<(state: NuxxSyncState) => void>();
  private syncInFlight: Promise<void> | null = null;
  private schemaManifestFetched = false;

  constructor(
    private readonly url: string,
    private readonly apiBaseUrl: string,
    private readonly headers: Record<string, string>,
    public readonly store: NuxxOfflineStore,
    private readonly autoSync: boolean = true
  ) {
    this.initBrowserListeners();
    void this.refreshPendingCount();
  }

  private initBrowserListeners(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', () => {
      this.updateState({ isOnline: true, syncError: null });
      if (this.autoSync) {
        void this.flushSync();
      }
    });

    window.addEventListener('offline', () => {
      this.updateState({ isOnline: false });
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.state.isOnline && this.autoSync) {
          void this.flushSync();
        }
      });
    }
  }

  getState(): NuxxSyncState {
    return this.state;
  }

  markOffline(): void {
    if (this.state.isOnline) {
      this.updateState({ isOnline: false });
    }
  }

  markOnline(): void {
    if (!this.state.isOnline) {
      this.updateState({ isOnline: true });
      if (this.autoSync) {
        void this.flushSync();
      }
    }
  }

  subscribe(listener: (state: NuxxSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateState(patch: Partial<NuxxSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  async refreshPendingCount(): Promise<number> {
    const [mutations, blobs] = await Promise.all([
      this.store.getOutboxMutations(),
      this.store.getOfflineBlobs(),
    ]);
    const total = mutations.length + blobs.length;
    this.updateState({ pendingCount: total });
    return total;
  }

  async ensureSchemaManifest(): Promise<void> {
    if (this.schemaManifestFetched || !this.state.isOnline) return;
    try {
      const response = await fetch(`${this.url}/schema/manifest`, {
        headers: this.headers,
      });
      if (response.ok) {
        const json = await response.json();
        if (Array.isArray(json?.data)) {
          await this.store.saveSchemas(json.data);
          this.schemaManifestFetched = true;
        }
      }
    } catch {
      // Non-fatal; offline joins will use whatever schema is already cached
    }
  }

  /**
   * Synchronizes only the missing delta (`updatedAt > lastSyncedAt` + `deletedIds`)
   * for one or more collections.
   */
  async pullCollectionDeltas(collections: string[]): Promise<boolean> {
    if (!collections.length || !this.state.isOnline) return false;

    const cursors: Record<string, string | null> = {};
    for (const col of collections) {
      cursors[col] = await this.store.getLastSyncedAt(col);
    }

    try {
      const response = await fetch(`${this.url}/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify({ cursors }),
      });

      if (response.ok) {
        const envelope = await response.json();
        const payload = envelope?.data ?? envelope;
        const serverTime: string = payload?.serverTime || new Date().toISOString();
        const deltas = payload?.collections || {};

        for (const col of collections) {
          const delta = deltas[col];
          if (!delta) continue;
          if (Array.isArray(delta.upserted) && delta.upserted.length > 0) {
            await this.store.upsertDocs(col, delta.upserted);
          }
          if (Array.isArray(delta.deletedIds) && delta.deletedIds.length > 0) {
            await this.store.deleteDocsByIds(col, delta.deletedIds);
          }
          await this.store.setLastSyncedAt(col, serverTime);
        }

        this.updateState({ isOnline: true, lastSyncedAt: serverTime, syncError: null });
        return true;
      }

      // Fallback if talking to an older backend that only has `/query`:
      // perform delta query via `updatedAt > cursor`
      if (response.status === 404) {
        const fallbackTime = new Date().toISOString();
        for (const col of collections) {
          const cursor = cursors[col];
          const filters = cursor ? [{ column: 'updatedAt', operator: 'gt', value: cursor }] : [];
          const qRes = await fetch(`${this.url}/query`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...this.headers,
            },
            body: JSON.stringify({
              collection: col,
              operation: 'select',
              filters,
            }),
          });
          if (!qRes.ok) return false;
          const qJson = await qRes.json();
          if (Array.isArray(qJson?.data) && qJson.data.length > 0) {
            await this.store.upsertDocs(col, qJson.data);
          }
          await this.store.setLastSyncedAt(col, fallbackTime);
        }
        this.updateState({ isOnline: true, lastSyncedAt: fallbackTime, syncError: null });
        return true;
      }

      return false;
    } catch {
      this.markOffline();
      return false;
    }
  }

  /**
   * Flushes all pending offline file uploads and compacted outbox mutations to the server,
   * then pulls any delta changes for all tracked collections.
   */
  async flushSync(): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.runFlushSync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runFlushSync(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.markOffline();
      return;
    }

    this.updateState({ isSyncing: true, syncError: null });

    try {
      await this.ensureSchemaManifest();

      // Step 1: Upload any pending offline blobs first and rewrite temporary URLs
      const blobs = await this.store.getOfflineBlobs();
      for (const item of blobs) {
        const formData = new FormData();
        formData.append('file', item.blob, item.fileName);
        const uploadRes = await fetch(`${this.apiBaseUrl}/assets/upload`, {
          method: 'POST',
          headers: this.headers,
          body: formData,
        });
        if (!uploadRes.ok) {
          throw new Error(`Failed to upload offline file ${item.fileName}`);
        }
        const uploadJson = await uploadRes.json();
        const realUrl = uploadJson?.data?.url;
        if (realUrl) {
          await this.store.replaceBlobUrlEverywhere(`offline-blob://${item.blobId}`, realUrl);
          await this.store.removeOfflineBlob(item.blobId);
        }
      }

      // Step 2: Push compacted outbox mutations
      const mutations = await this.store.getOutboxMutations();
      if (mutations.length > 0) {
        const pushRes = await fetch(`${this.url}/sync/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
          },
          body: JSON.stringify({ mutations }),
        });

        if (pushRes.ok) {
          const pushEnvelope = await pushRes.json();
          const pushData = pushEnvelope?.data ?? pushEnvelope;
          const results: Array<{ mutationId: string; success: boolean; error?: string }> =
            pushData?.results || [];
          const succeededIds = results.filter((r) => r.success).map((r) => r.mutationId);
          await this.store.removeOutboxMutations(succeededIds);

          const failed = results.find((r) => !r.success);
          if (failed?.error) {
            this.updateState({ syncError: failed.error });
          }
        } else if (pushRes.status === 404) {
          // Fallback for older backend: replay each mutation against `/query`
          const succeededIds: string[] = [];
          for (const m of mutations) {
            const qRes = await fetch(`${this.url}/query`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...this.headers,
              },
              body: JSON.stringify({
                collection: m.collection,
                operation: m.operation,
                data: m.data,
                filters: m.filters ?? [],
                combinator: m.combinator,
                updates: m.updates,
              }),
            });
            if (qRes.ok) {
              succeededIds.push(m.mutationId);
            }
          }
          await this.store.removeOutboxMutations(succeededIds);
        } else {
          throw new Error(`Sync push failed with status ${pushRes.status}`);
        }
      }

      // Step 3: Pull delta changes for all tracked collections
      const meta = await this.store.getAllSyncMeta();
      const trackedCollections = Object.keys(meta);
      if (trackedCollections.length > 0) {
        await this.pullCollectionDeltas(trackedCollections);
      }

      await this.refreshPendingCount();
      this.updateState({
        isOnline: true,
        isSyncing: false,
        lastSyncedAt: this.state.lastSyncedAt || new Date().toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error during sync';
      await this.refreshPendingCount();
      this.updateState({
        isSyncing: false,
        syncError: message,
      });
      if (err instanceof TypeError) {
        this.markOffline();
      }
    }
  }
}
