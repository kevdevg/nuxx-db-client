# @nuxx-brandly/db-client

Client SDK & Official **Antigravity AI Plugin** for **Nuxx BaaS** — a lightweight, Offline-First backend-as-a-service. Every dynamic app gets its own isolated collections (declared via a `nuxx.json` manifest), built-in passwordless Magic Link authentication, IndexedDB Outbox + Delta Sync, S3 uploads, transactional email, real-time sockets, and Gemini AI helpers.

---

## Install SDK

```bash
npm install @nuxx-brandly/db-client@latest
```

---

## AI Skill & Antigravity Plugin (Auto-Updating)

This repository doubles as the official **Nuxx BaaS Plugin (`nuxx-baas-plugin`)** with **Progressive Disclosure** (`skills/nuxx-baas/SKILL.md` + `references/01..05-*.md`) and zero-dependency schema/type CLI validators. Choose either auto-updating installation path:

### Way 1: Global Plugin in Antigravity (Recommended — OTA Auto-Update)

Clone directly into your Antigravity global plugins directory. Thanks to `hooks.json` (`SessionStart` -> `./scripts/auto-update-hook.mjs`), Antigravity checks GitHub automatically once every 12 hours in the background and fast-forwards new versions OTA without manual intervention:

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/kevdevg/nuxx-db-client.git ~/.gemini/config/plugins/nuxx-baas-plugin
```

### Way 2: Per-Project via npm (`npx nuxx-baas init`)

When `@nuxx-brandly/db-client` is installed in your app's `node_modules`, register its bundled `skills/` directory in `.agents/skills.json` so any AI coding agent discovers the exact skill version matching your installed SDK:

```bash
npx nuxx-baas init
```

### Included CLI Helpers (`nuxx-baas`)

```bash
# 1. Link node_modules/@nuxx-brandly/db-client/skills into .agents/skills.json
npx nuxx-baas init

# 2. Validate ./nuxx.json (column types, reserved tables, FK objectId integrity, archive, preloadTables)
npx nuxx-baas validate ./nuxx.json

# 3. Hot-sync ./nuxx.json to Nuxx BaaS in <1s using .env / .env.local (zero container redeploy!)
npx nuxx-baas sync ./nuxx.json

# 4. Generate TypeScript interfaces from ./nuxx.json into ./src/lib/database.types.ts
npx nuxx-baas gen-types ./nuxx.json ./src/lib/database.types.ts
```

---

## Quick Start

Centralize your client instance in `src/lib/nuxx-constants.ts` reading `VITE_*` environment variables:

```typescript
/// <reference types="vite/client" />
import { createClient } from '@nuxx-brandly/db-client';

// url = `${API_URL}/${APP_ID}` — API_URL is your Nuxx DB base (e.g. https://api.nuxx.app/api/nuxx-db),
// APP_ID is your app slug / Gitea repo name, and API_KEY is the per-app key from Nuxx DB console.
export const NUXX_DB_API_URL =
  import.meta.env.VITE_API_URL || 'https://api.nuxx.app/api/nuxx-db';
export const NUXX_APP_ID =
  import.meta.env.VITE_APP_ID || import.meta.env.VITE_PROJECT_ID || 'my-app-slug';
export const NUXX_DB_API_KEY = import.meta.env.VITE_NUXX_DB_API_KEY || '';

export const db = createClient(
  `${NUXX_DB_API_URL}/${NUXX_APP_ID}`,
  NUXX_DB_API_KEY
);
```

## Querying Data

Every table is queried through the same fluent builder:

```typescript
// Select all rows
const { data, error } = await db.from('posts').select('*');

// Select specific columns, including a joined relation (declared as a foreignKey in nuxx.json)
const { data, error } = await db.from('posts').select('title, author(name)');

// Filter, sort, paginate
const { data, error } = await db
  .from('posts')
  .select('*')
  .eq('published', true)
  .gte('createdAt', '2026-01-01')
  .order('createdAt', { ascending: false })
  .limit(20)
  .offset(0);

// Insert single row or batch array (idempotent when _id is provided; note: .bulkInsert() does NOT exist)
const { data, error } = await db.from('posts').insert({ title: 'Hello', authorId: userId });
const { data: batchResult } = await db.from('posts').insert([
  { title: 'Post A', authorId: userId },
  { title: 'Post B', authorId: userId },
]);

// Update — always scope it with a filter, or it updates every row in the table
const { data, error } = await db.from('posts').update({ title: 'Edited' }).eq('_id', postId);

// Delete — same rule, always scope it
const { data, error } = await db.from('posts').delete().eq('_id', postId);
```

Every call resolves to `{ data, error }` — `data` is `null` and `error` is populated on failure. The builder is directly `await`-able (`.then()`), so you don't need to call `.execute()` explicitly.

**Filter operators**: `.eq()`, `.neq()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.in()`, `.contains()` (case-insensitive substring match on strings).

## Security: Tables Requiring an Authenticated End-User

Any table declared with `"requiresAuth": true` in `nuxx.json` rejects operations (`select`/`insert`/`update`/`delete`/`bulkUpdate`/`bulkDelete`/`sync`) unless the caller has an active end-user session. Once `db.auth.signIn()`, `signUp()`, or `signInWithMagicLink()` succeeds, the SDK automatically attaches that JWT session to every subsequent `db.from(...)` call.

## Pagination & Exact Counts

```typescript
// Inclusive range: rows 0-9 (10 rows), equivalent to .offset(0).limit(10)
const { data, error, count } = await db
  .from('posts')
  .select('*', { count: 'exact' })
  .range(0, 9);
// count = total rows matching filters (not limited by range/limit).
```

## Bulk Update & Bulk Delete

```typescript
const { data, error } = await db.from('posts').bulkUpdate([
  { id: post1Id, data: { title: 'New title 1' } },
  { id: post2Id, data: { title: 'New title 2', published: true } },
]);
// data: { matchedCount, modifiedCount, results: [{ id, success, error? }, ...] } (max 500 records)

const { data: deleted } = await db.from('posts').bulkDelete([post1Id, post2Id]);
```

## Authenticating End-Users & Permanent Magic Links

Use `db.auth` and `useAuthSession(db)` for built-in end-user auth:

```typescript
// Register (password and roleId are optional — omit password for passwordless/magic-link-only users)
const { data, error } = await db.auth.signUp({ name: 'Jane', email: 'jane@x.com', password: 'secret123' });

// Log in with email + password
const { data, error } = await db.auth.signIn({ email: 'jane@x.com', password: 'secret123' });

// Log in with a permanent magic link token (note: opening https://your-app.com/?nuxx_magic=<token>
// automatically exchanges the token on startup, persists the session, and cleans the URL bar).
const { data, error } = await db.auth.signInWithMagicLink(magicToken);

// Wait imperatively for any initial ?nuxx_magic=... URL handshake to settle:
const initialSession = await db.auth.ready();

// Build a shareable Magic Link URL for a user:
const magicUrl = db.auth.buildMagicLinkUrl(user.magicLinkToken);

// Rotate/revoke a user's Magic Link token (requires active session):
const { data: rotated } = await db.auth.regenerateMagicLink(userId);

// Recommended in React: use `useAuthSession(db)` -> { session, user, isLoading, signOut }
// const { session, user, isLoading, signOut } = useAuthSession(db);

// Check synchronously whether someone is logged in:
const session = db.auth.getSession(); // { user, token } | null

// Re-fetch current user from server:
const { data, error } = await db.auth.getUser(); // { data: { user } | null, error }

// Log out:
await db.auth.signOut();
```

The returned `user` has the shape `{ _id, name, email, status, roles, roleId, role, magicLinkToken }`, where `role` is `{ name, permissions }` resolved automatically when `roleId` is set.

**`users` is a reserved table name.** Never declare `"tableName": "users"` in `nuxx.json` — end-user accounts live in `db.auth`. Point any `objectId` column to `"foreignTable": "users", "foreignColumn": "_id"` to populate user references safely via `.select('*, author(name)')`.

## PWA Offline-First & Incremental Delta Sync

By default in browsers with `IndexedDB`, `createClient` enables an **Offline-First** store and an **Outbox + Delta Sync (`sync/pull` & `sync/push`)** engine:
- When online, reads hydrate IndexedDB and incremental pulls fetch only records modified since `lastSyncTimestamp` (`updatedAt > since`) plus deletion tombstones.
- When offline, `.select()`, `.insert()`, `.update()`, `.delete()`, `.bulkUpdate()`, `.bulkDelete()`, and `db.files.upload()` (`offline-blob://` queue) execute locally against IndexedDB and compact pending mutations in the Outbox.
- Use `useSyncStatus(db)` in React to display connectivity, sync errors, and manual flush controls:

```tsx
import { useSyncStatus } from '@nuxx-brandly/db-client';
import { db } from './lib/nuxx-constants';

function SyncIndicator() {
  const { isOnline, isSyncing, pendingCount, lastSyncedAt, syncError, flushSync } = useSyncStatus(db);
  return (
    <div>
      <span>{isOnline ? 'Online' : 'Offline'}</span>
      {syncError && <span>Sync warning: {syncError}</span>}
      {pendingCount > 0 && (
        <button disabled={isSyncing} onClick={() => void flushSync()}>
          Sync ({pendingCount})
        </button>
      )}
    </div>
  );
}
```

## Uploading Files, Sending Emails, Sockets & AI Assistant

```typescript
// Upload a file to S3/MinIO (queues locally as offline-blob:// when offline and rewrites on flushSync)
const { data, error } = await db.files.upload(fileObject); // data: { url: "https://..." }

// Send brand-scoped HTML email
const { data, error } = await db.email.send({ html: '<p>Hello</p>' }); // data: { id: "..." }
```

```tsx
import { useAI, useSocket } from '@nuxx-brandly/db-client';
import { db } from './lib/nuxx-constants';

function AssistantWidget() {
  const { generate, loading, error, data } = useAI(db);
  const { isConnected } = useSocket({ url: 'https://api.nuxx.app', appId: 'my-app-slug' });

  return (
    <div>
      <small>{isConnected ? 'Live' : 'Connecting...'}</small>
      <button onClick={() => void generate('Summarize today tasks', 'You are a concise ops assistant.')}>
        Ask AI
      </button>
      {loading && <p>Generating...</p>}
      {error && <p>Error: {error.message}</p>}
      {data && <p>{data}</p>}
    </div>
  );
}
```

## Paso 8: Importación/Exportación de Paquetes (`.zip`) y Kit IA (`db.archive`)

`db.archive` permite exportar e importar paquetes relacionales completos (`.nuxx.zip` con binarios S3 incluidos o JSON puro generado por IA) remapeando IDs simbólicos a `ObjectId` reales, subiendo archivos de `assets/*` a S3 y refrescando automáticamente las tablas afectadas en IndexedDB:

```typescript
// 1. Descargar paquete .nuxx.zip en el navegador (toda la app o un sub-grafo por entidad raíz)
const { error: dlErr } = await db.archive.downloadExport({
  rootTable: 'courses',
  rootId: courseId,
  includeAssets: true,
  filename: 'curso-completo.nuxx.zip',
});

// 2. Obtener el Blob del .nuxx.zip programáticamente sin disparar descarga
const { data: zipBlob, error: zipErr } = await db.archive.exportZip({
  rootTable: 'courses',
  rootId: courseId,
  includeAssets: true,
});

// 3. Importar un paquete .nuxx.zip desde un <input type="file" />
const { data: importedZip, error: impErr } = await db.archive.importPackage(selectedZipFile, {
  rootTable: 'courses',
});
// importedZip -> { rootTable, rootIds, idMap, importedCounts, assetsUploaded, unreferencedAssets }

// 4. Importar un payload JSON directo (objeto o string JSON con IDs simbólicos e inlineAssets opcionales)
const { data: importedJson, error: jsonErr } = await db.archive.importJson(
  {
    tables: {
      courses: [{ _id: 'course_1', title: 'Intro a Nuxx', coverUrl: 'assets/covers/banner.svg' }],
      lessons: [{ _id: 'lesson_1', courseId: 'course_1', title: ' Setup inicial' }],
    },
    inlineAssets: {
      'assets/covers/banner.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"></svg>',
    },
  },
  { rootTable: 'courses' }
);

// 5. Generar Kit de Prompt IA (para ChatGPT, Claude o Gemini) adaptado al esquema y enums de nuxx.json
const { data: aiKit } = await db.archive.getAiKit({
  rootTable: 'courses',
  mode: 'json', // 'zip' | 'json'
  brief: 'Curso de onboarding técnico en 4 lecciones',
});
// aiKit -> { prompt, fileExtension, schemaSummary }

// 6. Descargar plantilla .nuxx.zip de ejemplo lista para rellenar
await db.archive.downloadTemplate({
  rootTable: 'courses',
  filename: 'plantilla-curso.nuxx.zip',
});
```

## API Reference

`createClient(url: string, apiKey: string, options?: { auth?: { token?: string }; offline?: { enabled?: boolean; dbName?: string; autoSync?: boolean } })` → `NuxxDbClient`

- `db.from(table)` → `{ select, insert, update, delete, bulkUpdate, bulkDelete }`
- `db.auth` → `{ signUp, signIn, signInWithMagicLink, buildMagicLinkUrl, regenerateMagicLink, signOut, getUser, getSession, ready, onAuthStateChange }`
- `db.archive` → `{ exportZip, downloadExport, importPackage, importJson, getAiKit, downloadTemplate }`
- `db.sync` → `{ getState, subscribe, flushSync, pullCollectionDeltas }`
- `db.files` → `{ upload }`
- `db.email` → `{ send }`
- React Hooks: `useAuthSession(db)`, `useSyncStatus(db)`, `useAI(db)`, `useSocket(options)`
