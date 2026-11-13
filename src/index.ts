import { NuxxDbArchive } from './archive';
import { NuxxOfflineStore } from './offline/indexedDbStore';
import { executeLocalQuery, matchesFilters } from './offline/localQueryEngine';
import { generateObjectId } from './offline/objectId';
import { NuxxSyncManager } from './offline/syncManager';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

export interface QueryFilter {
  column: string;
  operator: FilterOperator;
  value: any;
}

export interface QueryOrder {
  column: string;
  ascending: boolean;
}

export interface SelectOptions {
  /** Requests an exact total-row count alongside `data`. Counts base rows matching
   *  `filters`, independent of joined/unwound relation cardinality. Opt-in only —
   *  omitting this leaves existing behavior/perf completely unchanged. */
  count?: 'exact';
}

export interface BulkUpdateRecord<T = any> {
  /** The document's `_id`, as a string. */
  id: string;
  /** Partial fields to $set on this specific record. Different records may have entirely different data. */
  data: Partial<T>;
}

export interface BulkUpdateItemResult {
  id: string;
  success: boolean;
  /** Present only when success === false, e.g. "not found", "invalid id format", or a validation/Mongo error message. */
  error?: string;
}

export interface BulkUpdateResult {
  matchedCount: number;
  modifiedCount: number;
  /** Per-record outcome — always present, same length/order as the input `updates` array. */
  results: BulkUpdateItemResult[];
}

export interface QueryPayload {
  collection: string;
  operation: 'select' | 'insert' | 'update' | 'delete' | 'bulkUpdate';
  select?: string;
  filters: QueryFilter[];
  combinator?: 'and' | 'or';
  order?: QueryOrder;
  limit?: number;
  offset?: number;
  data?: any; // For insert/update
  count?: 'exact'; // For select
  updates?: BulkUpdateRecord[]; // For bulkUpdate
}

export interface NuxxDbResponse<T = any> {
  data: T | null;
  error: any;
  /** Only populated for select operations issued with { count: 'exact' }; undefined/null otherwise. */
  count?: number | null;
}

export class NuxxDbFilterBuilder<T = any> {
  private payload: QueryPayload;
  private url: string;
  private headers: Record<string, string>;
  private sync?: NuxxSyncManager;
  private offlineEnabled: boolean;

  constructor(
    url: string,
    headers: Record<string, string>,
    collection: string,
    operation: QueryPayload['operation'],
    data?: any,
    updates?: BulkUpdateRecord[],
    sync?: NuxxSyncManager,
    offlineEnabled: boolean = true
  ) {
    this.url = url;
    this.headers = headers;
    this.sync = sync;
    this.offlineEnabled = offlineEnabled;
    this.payload = {
      collection,
      operation,
      filters: [],
      data,
      updates,
    };
  }

  private requireDefinedValue(method: string, value: any) {
    if (value === undefined) {
      throw new Error(
        `NuxxDb: .${method}() received 'undefined' for the value. If you intended to query for null, pass 'null' explicitly.`
      );
    }
  }

  select(columns: string = '*', options?: SelectOptions): this {
    this.payload.select = columns;
    if (options?.count) this.payload.count = options.count;
    return this;
  }

  eq(column: string, value: any): this {
    this.requireDefinedValue('eq', value);
    this.payload.filters.push({ column, operator: 'eq', value });
    return this;
  }

  neq(column: string, value: any): this {
    this.requireDefinedValue('neq', value);
    this.payload.filters.push({ column, operator: 'neq', value });
    return this;
  }

  gt(column: string, value: any): this {
    this.requireDefinedValue('gt', value);
    this.payload.filters.push({ column, operator: 'gt', value });
    return this;
  }

  gte(column: string, value: any): this {
    this.requireDefinedValue('gte', value);
    this.payload.filters.push({ column, operator: 'gte', value });
    return this;
  }

  lt(column: string, value: any): this {
    this.requireDefinedValue('lt', value);
    this.payload.filters.push({ column, operator: 'lt', value });
    return this;
  }

  lte(column: string, value: any): this {
    this.requireDefinedValue('lte', value);
    this.payload.filters.push({ column, operator: 'lte', value });
    return this;
  }

  in(column: string, value: any[]): this {
    this.requireDefinedValue('in', value);
    this.payload.filters.push({ column, operator: 'in', value });
    return this;
  }

  contains(column: string, value: any): this {
    this.requireDefinedValue('contains', value);
    this.payload.filters.push({ column, operator: 'contains', value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = { ascending: true }): this {
    this.payload.order = { column, ascending: options.ascending ?? true };
    return this;
  }

  limit(count: number): this {
    this.payload.limit = count;
    return this;
  }

  offset(count: number): this {
    this.payload.offset = count;
    return this;
  }

  /** Inclusive range, Supabase-style — sugar over .limit()/.offset() (whichever was set last, by either API, wins). */
  range(from: number, to: number): this {
    if (to < from) {
      // Fail fast client-side: a limit <= 0 is falsy and the backend today skips
      // the $limit stage entirely when limit is falsy, silently returning ALL rows
      // for an invalid range — throwing here is safer than that surprise.
      throw new Error(`NuxxDb: range(${from}, ${to}) is invalid — 'to' must be >= 'from'`);
    }
    this.payload.offset = from;
    this.payload.limit = to - from + 1;
    return this;
  }

  async execute(): Promise<NuxxDbResponse<T>> {
    const isBrowserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

    // 1. Offline-First execution when browser is disconnected
    if (this.offlineEnabled && this.sync && (isBrowserOffline || !this.sync.getState().isOnline)) {
      this.sync.markOffline();
      const localResult = await executeLocalQuery<T>(this.sync.store, this.payload);
      await this.sync.refreshPendingCount();
      return localResult;
    }

    // 2. Pre-assign deterministic 24-hex ObjectId on `insert` so online & offline mirrors match
    if (this.payload.operation === 'insert' && this.payload.data) {
      if (Array.isArray(this.payload.data)) {
        this.payload.data = this.payload.data.map((doc) => ({
          ...doc,
          _id: doc?._id || generateObjectId(),
        }));
      } else if (typeof this.payload.data === 'object') {
        this.payload.data = {
          ...this.payload.data,
          _id: this.payload.data._id || generateObjectId(),
        };
      }
    }

    // 3. Online execution with Delta Sync + Local IndexedDB Mirroring
    try {
      // If we are selecting and already have a local cursor, pull only the missing delta first
      if (this.offlineEnabled && this.sync && this.payload.operation === 'select') {
        const hasRelations = Boolean(this.payload.select && this.payload.select.includes('('));
        const existingCursor = await this.sync.store.getLastSyncedAt(this.payload.collection);

        // When the collection is already hydrated locally and doesn't need server-only joins,
        // pull only the delta (`updatedAt > lastSyncedAt` + `deletedIds`) and evaluate locally!
        if (existingCursor && !hasRelations) {
          const deltaOk = await this.sync.pullCollectionDeltas([this.payload.collection]);
          if (deltaOk) {
            return await executeLocalQuery<T>(this.sync.store, this.payload);
          }
        }
      }

      const response = await fetch(`${this.url}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(this.payload),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        return { data: null, error };
      }

      const result: NuxxDbResponse<T> = await response.json();

      // Mirror online reads & writes into IndexedDB so subsequent offline mode or delta syncs have the latest state
      if (this.offlineEnabled && this.sync && !result.error) {
        this.sync.markOnline();
        await this.mirrorOnlineOperationToLocalStore(result.data);
      }

      return result;
    } catch (error) {
      // Network failure -> seamlessly fall back to local IndexedDB & Outbox queue!
      if (this.offlineEnabled && this.sync) {
        this.sync.markOffline();
        const fallbackResult = await executeLocalQuery<T>(this.sync.store, this.payload);
        await this.sync.refreshPendingCount();
        return fallbackResult;
      }
      return { data: null, error };
    }
  }

  private async mirrorOnlineOperationToLocalStore(responseData: any): Promise<void> {
    if (!this.sync) return;
    const { collection, operation, filters, combinator, data, updates, select } = this.payload;
    const nowIso = new Date().toISOString();

    if (operation === 'select' && Array.isArray(responseData)) {
      const isFullRowSelect = !select || select === '*';
      if (isFullRowSelect) {
        await this.sync.store.upsertDocs(collection, responseData);
        if (filters.length === 0 && !this.payload.limit && !this.payload.offset) {
          await this.sync.store.setLastSyncedAt(collection, nowIso);
        }
      }
    } else if (operation === 'insert' && data) {
      const docs = (Array.isArray(data) ? data : [data]).map((d) => ({
        ...d,
        createdAt: d?.createdAt || nowIso,
        updatedAt: nowIso,
      }));
      await this.sync.store.upsertDocs(collection, docs);
    } else if (operation === 'update' && data) {
      const allDocs = await this.sync.store.getCollectionDocs(collection);
      const matched = allDocs
        .filter((doc) => matchesFilters(doc, filters, combinator))
        .map((doc) => ({ ...doc, ...data, _id: doc._id, updatedAt: nowIso }));
      if (matched.length > 0) {
        await this.sync.store.upsertDocs(collection, matched);
      }
    } else if (operation === 'delete') {
      const allDocs = await this.sync.store.getCollectionDocs(collection);
      const ids = allDocs
        .filter((doc) => matchesFilters(doc, filters, combinator))
        .map((doc) => String(doc._id));
      if (ids.length > 0) {
        await this.sync.store.deleteDocsByIds(collection, ids);
      }
    } else if (operation === 'bulkUpdate' && Array.isArray(updates)) {
      const allDocs = await this.sync.store.getCollectionDocs(collection);
      const docMap = new Map(allDocs.map((d) => [String(d._id), d]));
      const toUpsert: Record<string, any>[] = [];
      for (const u of updates) {
        const existing = docMap.get(String(u.id));
        if (existing) {
          toUpsert.push({ ...existing, ...u.data, _id: existing._id, updatedAt: nowIso });
        }
      }
      if (toUpsert.length > 0) {
        await this.sync.store.upsertDocs(collection, toUpsert);
      }
    }
  }

  then<TResult1 = NuxxDbResponse<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: NuxxDbResponse<T>) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export interface NuxxDbAuthRole {
  _id: string;
  name: string;
  permissions?: Record<string, any>;
}

export interface NuxxDbAuthUser {
  _id: string;
  name: string;
  email: string;
  status?: string;
  roles: string[];
  roleId?: string;
  role?: NuxxDbAuthRole;
  /** Persistent token used to build this user's dedicated permanent Magic Link. */
  magicLinkToken?: string;
}

export interface NuxxDbAuthSession {
  user: NuxxDbAuthUser;
  token: string;
}

const MAGIC_QUERY_KEYS = ['nuxx_magic', 'magic_token', 'nuxx_token'] as const;

/**
 * End-user auth for a Nuxx BaaS app — register/login/session handling for
 * the people who use *your* generated app (never confuse this with the
 * Nuxx IDE's own login). The session is persisted for you (a single
 * localStorage key namespaced to this app's URL); never read or write it
 * yourself.
 */
export class NuxxDbAuth {
  private session: NuxxDbAuthSession | null = null;
  private listeners = new Set<(session: NuxxDbAuthSession | null) => void>();
  private readyPromise: Promise<NuxxDbAuthSession | null>;
  private magicHandshakeInFlight = false;

  constructor(
    private client: NuxxDbClient,
    private url: string,
    private headers: Record<string, string>,
    private storageKey: string
  ) {
    this.restore();
    this.readyPromise = this.detectAndExchangeMagicLinkFromUrl();
  }

  private restore(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as NuxxDbAuthSession;
      this.session = parsed;
      this.client.setAuthToken(parsed.token);
    } catch {
      // Corrupted/blocked storage — just start logged out.
    }
  }

  private persist(session: NuxxDbAuthSession | null): void {
    this.session = session;
    if (typeof localStorage !== 'undefined') {
      try {
        if (session) localStorage.setItem(this.storageKey, JSON.stringify(session));
        else localStorage.removeItem(this.storageKey);
      } catch {
        // Storage unavailable (private mode, quota, SSR) — session still works in-memory for this page load.
      }
    }
    for (const listener of this.listeners) {
      listener(this.session);
    }
  }

  /**
   * Automatically inspects `window.location.search` on boot for `?nuxx_magic=<token>`
   * (or `?magic_token=<token>`). If present, strips the query parameter from the browser
   * URL bar and exchanges the permanent token for a full persisted JWT session.
   */
  private async detectAndExchangeMagicLinkFromUrl(): Promise<NuxxDbAuthSession | null> {
    if (typeof window === 'undefined' || !window.location?.search) {
      return this.session;
    }

    try {
      const currentUrl = new URL(window.location.href);
      let foundToken: string | null = null;

      for (const key of MAGIC_QUERY_KEYS) {
        const val = currentUrl.searchParams.get(key);
        if (val && val.trim()) {
          foundToken = val.trim();
          currentUrl.searchParams.delete(key);
        }
      }

      if (!foundToken) {
        return this.session;
      }

      // Clean the URL bar immediately so the token isn't left visible while navigating
      if (typeof window.history?.replaceState === 'function') {
        const cleanSearch = currentUrl.searchParams.toString();
        const nextUrl =
          currentUrl.pathname + (cleanSearch ? `?${cleanSearch}` : '') + currentUrl.hash;
        window.history.replaceState({}, '', nextUrl);
      }

      this.magicHandshakeInFlight = true;
      const { data } = await this.signInWithMagicLink(foundToken);
      return data ?? this.session;
    } catch {
      return this.session;
    } finally {
      this.magicHandshakeInFlight = false;
      for (const listener of this.listeners) {
        listener(this.session);
      }
    }
  }

  /**
   * Resolves once any initial `?nuxx_magic=` URL handshake has completed.
   * Await this on app boot if you want to avoid flashing a login screen while the
   * permanent Magic Link is being exchanged for a session.
   */
  ready(): Promise<NuxxDbAuthSession | null> {
    return this.readyPromise;
  }

  /** True while an automatic URL Magic Link exchange is currently in flight. */
  isExchangingMagicLink(): boolean {
    return this.magicHandshakeInFlight;
  }

  /** Subscribes to session changes (login, magic-link handshake, logout). Returns an unsubscribe function. */
  onAuthStateChange(listener: (session: NuxxDbAuthSession | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.session);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async post(path: string, body: any): Promise<{ data: any; error: any }> {
    try {
      const response = await fetch(`${this.url}/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: json, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Creates a new end-user of this app. `password` is optional — omit it to create a
   * passwordless user who logs in via their permanent Magic Link (`user.magicLinkToken`).
   */
  async signUp(params: {
    name: string;
    email: string;
    password?: string;
    roleId?: string;
  }): Promise<{ data: NuxxDbAuthSession | null; error: any }> {
    const { data, error } = await this.post('register', params);
    if (error || !data) return { data: null, error };
    const session: NuxxDbAuthSession = { user: data.user, token: data.token };
    this.client.setAuthToken(session.token);
    this.persist(session);
    return { data: session, error: null };
  }

  /** Logs in an existing end-user of this app with email + password. */
  async signIn(params: {
    email: string;
    password: string;
  }): Promise<{ data: NuxxDbAuthSession | null; error: any }> {
    const { data, error } = await this.post('login', params);
    if (error || !data) return { data: null, error };
    const session: NuxxDbAuthSession = { user: data.user, token: data.token };
    this.client.setAuthToken(session.token);
    this.persist(session);
    return { data: session, error: null };
  }

  /**
   * Exchanges a user's permanent `magicLinkToken` for a persisted JWT session.
   * The token is NOT consumed on the server, so the same link continues to work
   * across any device or browser until explicitly rotated or the user is suspended.
   */
  async signInWithMagicLink(
    magicLinkToken: string
  ): Promise<{ data: NuxxDbAuthSession | null; error: any }> {
    const { data, error } = await this.post('magic', { token: magicLinkToken });
    if (error || !data) return { data: null, error };
    const session: NuxxDbAuthSession = { user: data.user, token: data.token };
    this.client.setAuthToken(session.token);
    this.persist(session);
    return { data: session, error: null };
  }

  /**
   * Builds a ready-to-share permanent Magic Link URL (`?nuxx_magic=<token>`) for a user.
   */
  buildMagicLinkUrl(magicLinkToken: string, baseUrl?: string): string {
    const base = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    const separator = base.includes('?') ? '&' : '/?';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}${separator}nuxx_magic=${encodeURIComponent(magicLinkToken)}`;
  }

  /**
   * Rotates a user's permanent `magicLinkToken`, immediately invalidating their previous link.
   * Requires an active session.
   */
  async regenerateMagicLink(userId: string): Promise<{ data: NuxxDbAuthUser | null; error: any }> {
    if (!this.session?.token) {
      return { data: null, error: { message: 'No hay sesión activa' } };
    }
    try {
      const response = await fetch(`${this.url}/auth/users/${userId}/magic-link`, {
        method: 'POST',
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.session.token}`,
        },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: json, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /** Clears the current session (both in-memory and persisted). */
  async signOut(): Promise<{ error: any }> {
    this.client.setAuthToken(null);
    this.persist(null);
    return { error: null };
  }

  /** Re-fetches the current user from the server (also refreshes the cached copy in getSession()). */
  async getUser(): Promise<{ data: { user: NuxxDbAuthUser } | null; error: any }> {
    if (!this.session?.token) {
      return { data: null, error: { message: 'No hay sesión activa' } };
    }
    try {
      const response = await fetch(`${this.url}/auth/me`, {
        headers: { ...this.headers, Authorization: `Bearer ${this.session.token}` },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) return { data: null, error: json };
      this.persist({ user: json.user, token: this.session.token });
      return { data: { user: json.user }, error: null };
    } catch (error) {
      // When offline, keep the cached session active instead of failing the app boot
      if (this.session?.user) {
        return { data: { user: this.session.user }, error: null };
      }
      return { data: null, error };
    }
  }

  /** Synchronous read of the current session (user + token) from memory/localStorage, or null if logged out. Use this on app boot to decide whether to show a login screen. */
  getSession(): NuxxDbAuthSession | null {
    return this.session;
  }

  /** Lists every end-user registered for this app. Requires an active session (any logged-in user — no extra role/permission needed); returns an error if nobody is logged in. */
  async listUsers(): Promise<{ data: NuxxDbAuthUser[] | null; error: any }> {
    if (!this.session?.token) {
      return { data: null, error: { message: 'No hay sesión activa' } };
    }
    try {
      const response = await fetch(`${this.url}/auth/users`, {
        headers: { ...this.headers, Authorization: `Bearer ${this.session.token}` },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: json, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /** Updates the role and/or status of a user of this app. Pass `roleId: null` to clear their role. Requires an active session. */
  async updateUser(
    userId: string,
    updates: { roleId?: string | null; status?: 'active' | 'suspended' }
  ): Promise<{ data: NuxxDbAuthUser | null; error: any }> {
    if (!this.session?.token) {
      return { data: null, error: { message: 'No hay sesión activa' } };
    }
    try {
      const response = await fetch(`${this.url}/auth/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
          Authorization: `Bearer ${this.session.token}`,
        },
        body: JSON.stringify(updates),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: json, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /** Deletes a user of this app. Requires an active session. */
  async deleteUser(userId: string): Promise<{ error: any }> {
    if (!this.session?.token) {
      return { error: { message: 'No hay sesión activa' } };
    }
    try {
      const response = await fetch(`${this.url}/auth/users/${userId}`, {
        method: 'DELETE',
        headers: { ...this.headers, Authorization: `Bearer ${this.session.token}` },
      });
      if (!response.ok) {
        const json = await response.json().catch(() => ({ message: response.statusText }));
        return { error: json };
      }
      return { error: null };
    } catch (error) {
      return { error };
    }
  }
}

/** File uploads for this app — see NuxxDbClient.files. */
export class NuxxDbFiles {
  constructor(
    private apiBaseUrl: string,
    private headers: Record<string, string>,
    private sync?: NuxxSyncManager,
    private offlineEnabled: boolean = true
  ) {}

  /** Uploads a file, returning its public URL. Never sets Content-Type yourself — the browser adds the multipart boundary for you. */
  async upload(file: File | Blob): Promise<{ data: { url: string } | null; error: any }> {
    const isBrowserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

    if (this.offlineEnabled && this.sync && (isBrowserOffline || !this.sync.getState().isOnline)) {
      this.sync.markOffline();
      const { tempUrl } = await this.sync.store.saveOfflineBlob(file);
      await this.sync.refreshPendingCount();
      return { data: { url: tempUrl }, error: null };
    }

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${this.apiBaseUrl}/assets/upload`, {
        method: 'POST',
        headers: this.headers,
        body: formData,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: { url: json.data?.url }, error: null };
    } catch (error) {
      if (this.offlineEnabled && this.sync) {
        this.sync.markOffline();
        const { tempUrl } = await this.sync.store.saveOfflineBlob(file);
        await this.sync.refreshPendingCount();
        return { data: { url: tempUrl }, error: null };
      }
      return { data: null, error };
    }
  }
}

/** Email sending for this app — see NuxxDbClient.email. */
export class NuxxDbEmail {
  constructor(
    private apiBaseUrl: string,
    private headers: Record<string, string>
  ) {}

  /** Sends an email to the app's configured contact address. `to`/`subject`/`from` are bound server-side, not caller-controlled. */
  async send(params: {
    html?: string;
    text?: string;
  }): Promise<{ data: { id: string } | null; error: any }> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(params),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { data: null, error: json?.message ? json : { message: response.statusText } };
      }
      return { data: json.data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }
}

export interface NuxxOfflineOptions {
  /** Enables local IndexedDB storage, Outbox queue compaction, and Delta Sync (default: true). */
  enabled?: boolean;
  /** Custom IndexedDB database name (defaults to `nuxx-offline:<url>`). */
  dbName?: string;
  /** Automatically flush pending mutations and pull deltas on reconnect (default: true). */
  autoSync?: boolean;
}

export interface NuxxClientOptions {
  auth?: { token?: string };
  offline?: NuxxOfflineOptions;
}

export class NuxxDbClient {
  private url: string;
  private headers: Record<string, string>;
  private offlineEnabled: boolean;
  /** Login/register/session management for this app's end-users — see NuxxDbAuth. */
  auth: NuxxDbAuth;
  /** Upload files for this app — see NuxxDbFiles. */
  files: NuxxDbFiles;
  /** Send email from this app — see NuxxDbEmail. */
  email: NuxxDbEmail;
  /** Offline-first storage & incremental delta synchronization engine. */
  sync: NuxxSyncManager;
  /** Universal `.nuxx.zip` / JSON package export, import, template & AI Kit engine. */
  archive: NuxxDbArchive;

  constructor(url: string, apiKey: string, options?: NuxxClientOptions) {
    // Expected URL format: https://api.nuxx.app/api/nuxx-db/repoName
    this.url = url;
    this.headers = {
      'x-ephemeral-api-key': apiKey,
    };
    if (options?.auth?.token) {
      this.headers['Authorization'] = `Bearer ${options.auth.token}`;
    }
    this.offlineEnabled = options?.offline?.enabled ?? true;
    const dbName = options?.offline?.dbName || `nuxx-offline:${url}`;
    const autoSync = options?.offline?.autoSync ?? true;

    this.auth = new NuxxDbAuth(this, url, this.headers, `nuxx-auth:${url}`);
    // assets/upload and email/send live under a sibling `nuxx-api` path, not
    // nested under `nuxx-db` — same appId/API key, different route prefix.
    const apiBaseUrl = url.replace('/nuxx-db/', '/nuxx-api/');
    const store = new NuxxOfflineStore(dbName);
    this.sync = new NuxxSyncManager(url, apiBaseUrl, this.headers, store, autoSync);
    this.files = new NuxxDbFiles(apiBaseUrl, this.headers, this.sync, this.offlineEnabled);
    this.email = new NuxxDbEmail(apiBaseUrl, this.headers);
    this.archive = new NuxxDbArchive(this.url, this.headers, this.sync, this.offlineEnabled);
  }

  /**
   * Updates (or clears, passing null) the Authorization header used by every
   * subsequent query. You normally never call this directly — db.auth.signIn()/
   * signUp()/signOut() do it for you. Mutates the client in place, so you never
   * need to re-run createClient() or reassign the `db` export.
   */
  setAuthToken(token: string | null): void {
    if (token) {
      this.headers['Authorization'] = `Bearer ${token}`;
    } else {
      delete this.headers['Authorization'];
    }
  }

  from(collection: string) {
    return {
      select: (columns: string = '*', options?: SelectOptions) => {
        return new NuxxDbFilterBuilder(
          this.url,
          this.headers,
          collection,
          'select',
          undefined,
          undefined,
          this.sync,
          this.offlineEnabled
        ).select(columns, options);
      },
      insert: (data: any) => {
        return new NuxxDbFilterBuilder(
          this.url,
          this.headers,
          collection,
          'insert',
          data,
          undefined,
          this.sync,
          this.offlineEnabled
        );
      },
      update: (data: any) => {
        return new NuxxDbFilterBuilder(
          this.url,
          this.headers,
          collection,
          'update',
          data,
          undefined,
          this.sync,
          this.offlineEnabled
        );
      },
      delete: () => {
        return new NuxxDbFilterBuilder(
          this.url,
          this.headers,
          collection,
          'delete',
          undefined,
          undefined,
          this.sync,
          this.offlineEnabled
        );
      },
      /** Updates multiple records in one call, each with its own data (unlike .update(), which
       *  applies the same patch to every row matching a filter). Partial failure is normal —
       *  the top-level `error` stays null; check `data.results[i]` for per-record outcomes. */
      bulkUpdate: (updates: BulkUpdateRecord[]) => {
        return new NuxxDbFilterBuilder<BulkUpdateResult>(
          this.url,
          this.headers,
          collection,
          'bulkUpdate',
          undefined,
          updates,
          this.sync,
          this.offlineEnabled
        );
      },
      /** Deletes every row whose `_id` is in `ids`. Pure sugar for .delete().in('_id', ids) — no
       *  distinct backend behavior, since deleteMany-by-filter already deletes every matched row. */
      bulkDelete: (ids: string[]) => {
        return new NuxxDbFilterBuilder(
          this.url,
          this.headers,
          collection,
          'delete',
          undefined,
          undefined,
          this.sync,
          this.offlineEnabled
        ).in('_id', ids);
      },
    };
  }
}

export function createClient(url: string, apiKey: string, options?: NuxxClientOptions) {
  return new NuxxDbClient(url, apiKey, options);
}
export * from './archive';
export * from './useSocket';
export * from './useAI';
export * from './useSyncStatus';
export * from './useAuthSession';
export * from './offline/objectId';
export * from './offline/syncManager';
export * from './offline/indexedDbStore';
