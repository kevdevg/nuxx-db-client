---
name: nuxx-baas
description: >-
  Integra, construye, audita y despliega aplicaciones web cliente (React/Vite PWAs)
  conectadas a Nuxx BaaS usando nuxx.json, @nuxx-brandly/db-client, autenticación
  Magic Link (useAuthSession), sincronización Offline-First (IndexedDB/Outbox/useSyncStatus),
  S3, Email, Sockets, IA y @brandly/sdk. Activar SIEMPRE que el proyecto consuma
  @nuxx-brandly/db-client, tenga un archivo nuxx.json o el usuario pida conectar una
  app con Nuxx BaaS / Nuxx DB. NO usar para modificar el motor interno NestJS en
  services/core-api (para eso existe nuxx-baas-engine).
---

# Integración de Aplicaciones Cliente con Nuxx BaaS

Esta skill guía la arquitectura e integración de aplicaciones cliente sobre **Nuxx BaaS** (`@nuxx-brandly/db-client` v0.7+) mediante **carga progresiva**. Lee **únicamente** los archivos en `references/` que correspondan a la tarea actual para proteger la ventana de contexto.

---

## 1. Setup Base Estándar (`src/lib/nuxx-constants.ts`)

1. Instala el SDK oficial desde npm público:
   ```bash
   npm install @nuxx-brandly/db-client@latest
   ```
2. Centraliza **toda** conexión en `src/lib/nuxx-constants.ts` leyendo variables `VITE_*` (nunca hardcodees `ndb_live_...` en componentes):
   ```typescript
   /// <reference types="vite/client" />
   import { createClient } from '@nuxx-brandly/db-client';

   export const NUXX_DB_API_URL =
     import.meta.env.VITE_API_URL || 'https://api.nuxx.app/api/nuxx-db';
   export const NUXX_APP_ID =
     import.meta.env.VITE_APP_ID ||
     import.meta.env.VITE_PROJECT_ID ||
     'my-app-slug';
   export const NUXX_DB_API_KEY = import.meta.env.VITE_NUXX_DB_API_KEY || '';

   export const db = createClient(
     `${NUXX_DB_API_URL}/${NUXX_APP_ID}`,
     NUXX_DB_API_KEY
   );
   ```

---

## 2. Las 6 Reglas Innegociables de Contrato (Evitan Errores `tsc -b` y `400`)

1. **Tipos estrictos en `nuxx.json`:** Solo existen `'string' | 'number' | 'boolean' | 'date' | 'objectId' | 'array' | 'object'`. Están **prohibidos** `int`, `float`, `json`, `text`, `uuid` y `timestamp`.
2. **Tabla `users` reservada:** **NUNCA** declares `"tableName": "users"` en `tables` de `nuxx.json` (el motor gestiona usuarios en `nuxx_db_users`). **SÍ** puedes apuntar un `foreignKey` hacia `"foreignTable": "users", "foreignColumn": "_id"`, siempre que `localColumn` sea de tipo `'objectId'`.
3. **Firma real de `useAuthSession(db)`:** Retorna exactamente `{ session, user, isLoading, signOut }` (`ready` y `error` **no existen** en el hook; en `db.auth` usa `db.auth.ready()`, nunca `waitForInitialAuth()`).
4. **Firma real de `useSyncStatus(db)`:** Retorna `{ isOnline, isSyncing, pendingCount, lastSyncedAt, syncError, flushSync }` (`lastError` y `syncNow()` **no existen**).
5. **Inserción por lotes (Batch Insert):** **NO existe** `.bulkInsert()`. Pasa un array directamente a `.insert(recordsArray)` (idempotente con `_id` pre-asignado). Para actualizar/borrar en lote sí existen `.bulkUpdate([{ id, data }])` (máx. 500) y `.bulkDelete(ids)`.
6. **Configuración Offline y PWA:** En `createClient(url, key, { offline })`, `offline` recibe un objeto `{ enabled?: boolean, dbName?: string, autoSync?: boolean }` (nunca un booleano suelto). En `nuxx.json`, la lista de precarga offline se llama `"preloadTables"` (nunca `"offlineTables"`).

---

## 3. Índice de Carga Progresiva (`references/`)

Lee bajo demanda **solo** los módulos requeridos por tu tarea:

| Si necesitas implementar o depurar... | Lee este archivo de referencia |
| :--- | :--- |
| Diseño o edición de `nuxx.json`, `foreignKeys`, `roles`, `requiresAuth` o `agentHints` para Hermes | [01-schema-and-hermes.md](./references/01-schema-and-hermes.md) |
| Consultas `.from()`, joins relacionales, paginación `.range` + `count: 'exact'`, `insert`, `update`, `bulkUpdate`/`bulkDelete` | [02-crud-and-queries.md](./references/02-crud-and-queries.md) |
| Login/registro, Magic Links (`?nuxx_magic=`), `useAuthSession`, gestión de usuarios y permisos RBAC | [03-auth-and-rbac.md](./references/03-auth-and-rbac.md) |
| Modo PWA Offline-First, `preloadTables`, compactación Outbox, `useSyncStatus` y archivos offline `offline-blob://` | [04-pwa-offline-sync.md](./references/04-pwa-offline-sync.md) |
| Subida S3 (`db.files`), correos (`db.email`), Sockets (`useSocket`), IA (`useAI`), `@brandly/sdk` y `Dockerfile` Coolify | [05-platform-brand-and-deploy.md](./references/05-platform-brand-and-deploy.md) |
| Exportación/importación de paquetes `.nuxx.zip` o JSON, bloque `archive`, `columns[].enum`, plantillas y Kit de Prompts IA (`db.archive`) | [06-archive-and-ai-kit.md](./references/06-archive-and-ai-kit.md) |

---

## 4. Verificación Obligatoria Antes de Entregar o Hacer Push

1. **Valida `nuxx.json`**: si el proyecto tiene instalado `@nuxx-brandly/db-client`, ejecuta directamente el CLI incluido:
   ```bash
   npx nuxx-baas validate ./nuxx.json
   ```
   *(Alternativamente, ejecuta el script en ruta relativa respecto a la carpeta de este `SKILL.md`: `node ./scripts/validate-nuxx-json.mjs ./nuxx.json`, o desde el plugin global `~/.gemini/config/plugins/nuxx-baas-plugin/skills/nuxx-baas/scripts/validate-nuxx-json.mjs`).*
2. **(Opcional) Genera interfaces TypeScript** sincronizadas con `nuxx.json`:
   ```bash
   npx nuxx-baas gen-types ./nuxx.json ./src/lib/database.types.ts
   ```
   *(O usando la ruta relativa respecto a esta carpeta `SKILL.md`: `node ./scripts/gen-nuxx-types.mjs ./nuxx.json ./src/lib/database.types.ts`).*
3. **Compila la aplicación** (`npm run build` / `tsc -b && vite build`) y recuerda al usuario sincronizar el esquema en la consola de Nuxx tras hacer `git push` a Gitea si cambió `nuxx.json`.
