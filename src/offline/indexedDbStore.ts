import type { BulkUpdateRecord, QueryFilter } from '../index';
import { generateObjectId } from './objectId';

export interface NuxxForeignKeyMeta {
  localColumn: string;
  foreignTable: string;
  foreignColumn: string;
  as: string;
}

export interface NuxxTableSchemaMeta {
  tableName: string;
  foreignKeys: NuxxForeignKeyMeta[];
}

export interface NuxxSyncMetaEntry {
  collection: string;
  lastSyncedAt: string | null;
}

export interface NuxxOutboxMutation {
  mutationId: string;
  seq: number;
  collection: string;
  operation: 'insert' | 'update' | 'delete' | 'bulkUpdate';
  data?: any;
  filters?: QueryFilter[];
  combinator?: 'and' | 'or';
  updates?: BulkUpdateRecord[];
  clientTimestamp: string;
}

export interface NuxxOfflineBlobEntry {
  blobId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  createdAt: string;
}

interface StoredRecord {
  key: string;
  collection: string;
  _id: string;
  doc: Record<string, any>;
}

const DB_VERSION = 1;

function replaceDeepString(value: any, target: string, replacement: string): any {
  if (typeof value === 'string') {
    return value === target ? replacement : value.replaceAll(target, replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceDeepString(item, target, replacement));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replaceDeepString(v, target, replacement);
    }
    return out;
  }
  return value;
}

export class NuxxOfflineStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryRecords = new Map<string, StoredRecord>();
  private memoryMeta = new Map<string, NuxxSyncMetaEntry>();
  private memorySchemas = new Map<string, NuxxTableSchemaMeta>();
  private memoryOutbox: NuxxOutboxMutation[] = [];
  private memoryBlobs = new Map<string, NuxxOfflineBlobEntry>();

  constructor(private readonly dbName: string) {}

  private get hasIndexedDB(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'key' });
          store.createIndex('by_collection', 'collection', { unique: false });
        }
        if (!db.objectStoreNames.contains('sync_meta')) {
          db.createObjectStore('sync_meta', { keyPath: 'collection' });
        }
        if (!db.objectStoreNames.contains('schemas')) {
          db.createObjectStore('schemas', { keyPath: 'tableName' });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          const outbox = db.createObjectStore('outbox', { keyPath: 'mutationId' });
          outbox.createIndex('by_seq', 'seq', { unique: false });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'blobId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  async getCollectionDocs(collection: string): Promise<Record<string, any>[]> {
    if (!this.hasIndexedDB) {
      const docs: Record<string, any>[] = [];
      for (const entry of this.memoryRecords.values()) {
        if (entry.collection === collection) docs.push({ ...entry.doc });
      }
      return docs;
    }

    try {
      const db = await this.openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readonly');
        const store = tx.objectStore('records');
        const index = store.index('by_collection');
        const req = index.getAll(IDBKeyRange.only(collection));
        req.onsuccess = () => {
          const rows = (req.result as StoredRecord[]) || [];
          resolve(rows.map((r) => ({ ...r.doc })));
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async upsertDocs(collection: string, docs: Record<string, any>[]): Promise<void> {
    if (!docs.length) return;
    if (!this.hasIndexedDB) {
      for (const doc of docs) {
        const id = String(doc._id || doc.id || generateObjectId());
        const normalized = { ...doc, _id: id };
        this.memoryRecords.set(`${collection}:${id}`, {
          key: `${collection}:${id}`,
          collection,
          _id: id,
          doc: normalized,
        });
      }
      return;
    }

    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        for (const doc of docs) {
          const id = String(doc._id || doc.id || generateObjectId());
          const normalized = { ...doc, _id: id };
          store.put({
            key: `${collection}:${id}`,
            collection,
            _id: id,
            doc: normalized,
          } satisfies StoredRecord);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore quota/storage errors
    }
  }

  async deleteDocsByIds(collection: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    if (!this.hasIndexedDB) {
      for (const id of ids) {
        this.memoryRecords.delete(`${collection}:${id}`);
      }
      return;
    }

    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        for (const id of ids) {
          store.delete(`${collection}:${id}`);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  async getLastSyncedAt(collection: string): Promise<string | null> {
    if (!this.hasIndexedDB) {
      return this.memoryMeta.get(collection)?.lastSyncedAt ?? null;
    }
    try {
      const db = await this.openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction('sync_meta', 'readonly');
        const req = tx.objectStore('sync_meta').get(collection);
        req.onsuccess = () =>
          resolve((req.result as NuxxSyncMetaEntry | undefined)?.lastSyncedAt ?? null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async getAllSyncMeta(): Promise<Record<string, string | null>> {
    if (!this.hasIndexedDB) {
      const out: Record<string, string | null> = {};
      for (const [k, v] of this.memoryMeta.entries()) {
        out[k] = v.lastSyncedAt;
      }
      return out;
    }
    try {
      const db = await this.openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction('sync_meta', 'readonly');
        const req = tx.objectStore('sync_meta').getAll();
        req.onsuccess = () => {
          const rows = (req.result as NuxxSyncMetaEntry[]) || [];
          const out: Record<string, string | null> = {};
          for (const r of rows) out[r.collection] = r.lastSyncedAt;
          resolve(out);
        };
        req.onerror = () => resolve({});
      });
    } catch {
      return {};
    }
  }

  async setLastSyncedAt(collection: string, lastSyncedAt: string): Promise<void> {
    if (!this.hasIndexedDB) {
      this.memoryMeta.set(collection, { collection, lastSyncedAt });
      return;
    }
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sync_meta', 'readwrite');
        tx.objectStore('sync_meta').put({ collection, lastSyncedAt } satisfies NuxxSyncMetaEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  async saveSchemas(schemas: NuxxTableSchemaMeta[]): Promise<void> {
    if (!schemas.length) return;
    for (const s of schemas) {
      this.memorySchemas.set(s.tableName, s);
    }
    if (!this.hasIndexedDB) return;
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('schemas', 'readwrite');
        const store = tx.objectStore('schemas');
        for (const s of schemas) {
          store.put({
            tableName: s.tableName,
            foreignKeys: s.foreignKeys || [],
          } satisfies NuxxTableSchemaMeta);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  async getSchema(tableName: string): Promise<NuxxTableSchemaMeta | null> {
    if (this.memorySchemas.has(tableName)) {
      return this.memorySchemas.get(tableName) ?? null;
    }
    if (!this.hasIndexedDB) return null;
    try {
      const db = await this.openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction('schemas', 'readonly');
        const req = tx.objectStore('schemas').get(tableName);
        req.onsuccess = () => {
          const result = (req.result as NuxxTableSchemaMeta | undefined) ?? null;
          if (result) this.memorySchemas.set(tableName, result);
          resolve(result);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Enqueues an offline mutation and performs automatic outbox compaction:
   * - `insert(id=X)` followed by `update(id=X)` merges the update fields directly into the pending `insert`.
   * - `update(id=X)` followed by `update(id=X)` merges the fields into the existing pending `update`.
   * - `insert(id=X)` followed by `delete(id=X)` cancels both out completely.
   */
  async enqueueMutation(
    mutation: Omit<NuxxOutboxMutation, 'mutationId' | 'seq' | 'clientTimestamp'>
  ): Promise<void> {
    const existing = await this.getOutboxMutations();
    const singleIdFilter =
      mutation.filters?.length === 1 &&
      mutation.filters[0].column === '_id' &&
      mutation.filters[0].operator === 'eq' &&
      typeof mutation.filters[0].value === 'string'
        ? (mutation.filters[0].value as string)
        : null;

    if (singleIdFilter && mutation.operation === 'update' && mutation.data) {
      // Look for an existing single-doc insert or update for the same _id in this collection
      for (const item of existing) {
        if (item.collection !== mutation.collection) continue;
        if (
          item.operation === 'insert' &&
          item.data &&
          !Array.isArray(item.data) &&
          item.data._id === singleIdFilter
        ) {
          item.data = {
            ...item.data,
            ...mutation.data,
            updatedAt: new Date().toISOString(),
          };
          await this.putOutboxMutation(item);
          return;
        }
        if (
          item.operation === 'update' &&
          item.filters?.length === 1 &&
          item.filters[0].column === '_id' &&
          item.filters[0].operator === 'eq' &&
          item.filters[0].value === singleIdFilter
        ) {
          item.data = {
            ...item.data,
            ...mutation.data,
          };
          await this.putOutboxMutation(item);
          return;
        }
      }
    }

    if (singleIdFilter && mutation.operation === 'delete') {
      const pendingInsert = existing.find(
        (item) =>
          item.collection === mutation.collection &&
          item.operation === 'insert' &&
          item.data &&
          !Array.isArray(item.data) &&
          item.data._id === singleIdFilter
      );
      if (pendingInsert) {
        // Cancel both the pending insert and any subsequent updates for this temporary doc
        const toRemove = existing
          .filter(
            (item) =>
              item.collection === mutation.collection &&
              ((item.operation === 'insert' && item.data?._id === singleIdFilter) ||
                (item.filters?.length === 1 &&
                  item.filters[0].column === '_id' &&
                  item.filters[0].value === singleIdFilter))
          )
          .map((i) => i.mutationId);
        await this.removeOutboxMutations(toRemove);
        return;
      }
    }

    const nextSeq = existing.length > 0 ? Math.max(...existing.map((e) => e.seq)) + 1 : 1;
    const entry: NuxxOutboxMutation = {
      ...mutation,
      mutationId: generateObjectId(),
      seq: nextSeq,
      clientTimestamp: new Date().toISOString(),
    };
    await this.putOutboxMutation(entry);
  }

  private async putOutboxMutation(entry: NuxxOutboxMutation): Promise<void> {
    if (!this.hasIndexedDB) {
      const idx = this.memoryOutbox.findIndex((m) => m.mutationId === entry.mutationId);
      if (idx >= 0) this.memoryOutbox[idx] = entry;
      else this.memoryOutbox.push(entry);
      return;
    }
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  async getOutboxMutations(): Promise<NuxxOutboxMutation[]> {
    if (!this.hasIndexedDB) {
      return [...this.memoryOutbox].sort((a, b) => a.seq - b.seq);
    }
    try {
      const db = await this.openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction('outbox', 'readonly');
        const req = tx.objectStore('outbox').getAll();
        req.onsuccess = () => {
          const rows = (req.result as NuxxOutboxMutation[]) || [];
          resolve(rows.sort((a, b) => a.seq - b.seq));
        };
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  async removeOutboxMutations(mutationIds: string[]): Promise<void> {
    if (!mutationIds.length) return;
    if (!this.hasIndexedDB) {
      const idSet = new Set(mutationIds);
      this.memoryOutbox = this.memoryOutbox.filter((m) => !idSet.has(m.mutationId));
      return;
    }
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        for (const id of mutationIds) {
          store.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  async saveOfflineBlob(file: File | Blob): Promise<{ blobId: string; tempUrl: string }> {
    const blobId = generateObjectId();
    const fileName = file instanceof File ? file.name : `blob-${blobId}`;
    const mimeType = file.type || 'application/octet-stream';
    const entry: NuxxOfflineBlobEntry = {
      blobId,
      fileName,
      mimeType,
      blob: file,
      createdAt: new Date().toISOString(),
    };

    if (!this.hasIndexedDB) {
      this.memoryBlobs.set(blobId, entry);
      return { blobId, tempUrl: `offline-blob://${blobId}` };
    }

    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.memoryBlobs.set(blobId, entry);
    }
    return { blobId, tempUrl: `offline-blob://${blobId}` };
  }

  async getOfflineBlobs(): Promise<NuxxOfflineBlobEntry[]> {
    if (!this.hasIndexedDB) {
      return Array.from(this.memoryBlobs.values());
    }
    try {
      const db = await this.openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction('blobs', 'readonly');
        const req = tx.objectStore('blobs').getAll();
        req.onsuccess = () => resolve((req.result as NuxxOfflineBlobEntry[]) || []);
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  async removeOfflineBlob(blobId: string): Promise<void> {
    this.memoryBlobs.delete(blobId);
    if (!this.hasIndexedDB) return;
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').delete(blobId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }

  /**
   * After an offline blob is uploaded to the CDN on reconnect, replaces all occurrences
   * of `offline-blob://<blobId>` in pending outbox mutations and local records with the real URL.
   */
  async replaceBlobUrlEverywhere(tempUrl: string, realUrl: string): Promise<void> {
    const mutations = await this.getOutboxMutations();
    for (const m of mutations) {
      const updatedData = replaceDeepString(m.data, tempUrl, realUrl);
      const updatedUpdates = replaceDeepString(m.updates, tempUrl, realUrl);
      if (
        JSON.stringify(updatedData) !== JSON.stringify(m.data) ||
        JSON.stringify(updatedUpdates) !== JSON.stringify(m.updates)
      ) {
        m.data = updatedData;
        m.updates = updatedUpdates;
        await this.putOutboxMutation(m);
      }
    }

    if (!this.hasIndexedDB) {
      for (const entry of this.memoryRecords.values()) {
        entry.doc = replaceDeepString(entry.doc, tempUrl, realUrl);
      }
      return;
    }

    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        const req = store.getAll();
        req.onsuccess = () => {
          const all = (req.result as StoredRecord[]) || [];
          for (const item of all) {
            const replaced = replaceDeepString(item.doc, tempUrl, realUrl);
            if (JSON.stringify(replaced) !== JSON.stringify(item.doc)) {
              store.put({ ...item, doc: replaced });
            }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }
}
