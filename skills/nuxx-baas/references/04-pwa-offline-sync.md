# 04. Arquitectura PWA Offline-First, IndexedDB, Outbox y Delta Sync

Por defecto, `@nuxx-brandly/db-client` activa un motor **Offline-First completo en IndexedDB** con cola transaccional compactada (*Outbox*), sincronización incremental (*Delta Sync* + *Tombstones*) y soporte para subida diferida de archivos binarios.

---

## 1. Configuración `pwa` en `nuxx.json`

Al desplegar una SPA Vite en Nuxx, `IdeController` lee el bloque `pwa` de `nuxx.json` y genera automáticamente `manifest.webmanifest`, `sw.js` (estrategia Network-First para assets estáticos con fallback offline) y las etiquetas en `index.html`:

```json
{
  "pwa": {
    "enabled": true,
    "name": "Inventario de Campo",
    "shortName": "Inventario",
    "description": "Captura de auditorías sin conexión",
    "themeColor": "#0f172a",
    "backgroundColor": "#ffffff",
    "preloadTables": ["warehouses", "products", "audits"]
  }
}
```

> **⚠️ Campos exactos del schema `nuxxPwaConfigSchema`:**
> - Usa **`"preloadTables"`** (array de nombres de tablas existentes en `tables`). **NO** uses `"offlineTables"`, `"display"` ni `"icons"` dentro de `pwa` en `nuxx.json` (Zod los descarta).

---

## 2. Cómo Opera el Motor Local (`IndexedDB` + `Outbox`)

1. **Stores en IndexedDB (`nuxx-offline:${url}`):**
   - `records`: Documentos locales indexados por colección.
   - `sync_meta`: Cursor `lastSyncedAt` por colección para pedir solo cambios nuevos (`POST /sync/pull`) y `deletedIds` desde `__tombstones`.
   - `schemas`: Definiciones `foreignKeys` cacheadas desde `GET /schema/manifest`.
   - `outbox`: Mutaciones pendientes cuando no hay red, con compactación automática por `_id`:
     - `insert(X)` + `update(X)` → fusiona los cambios en el `insert` pendiente.
     - `update(X)` + `update(X)` → fusiona ambos parches `$set`.
     - `insert(X)` + `delete(X)` → se cancelan mutuamente y desaparecen del Outbox sin golpear el servidor.
   - `blobs`: Archivos `File`/`Blob` subidos sin conexión.
2. **Cuándo desactivar la caché IndexedDB:**
   - Si construyes un sistema colaborativo multi-operador en tiempo real donde varios usuarios editan simultáneamente los mismos registros y prefieres lecturas 100% directas al servidor en cada `.select()`, pasa un **objeto** `NuxxOfflineOptions` (nunca un booleano suelto):
   ```typescript
   export const db = createClient(
     `${NUXX_DB_API_URL}/${NUXX_APP_ID}`,
     NUXX_DB_API_KEY,
     {
       offline: {
         enabled: false,
         autoSync: false,
       },
     }
   );
   ```

---

## 3. Indicador Reactivo de Sincronización (`useSyncStatus`)

```tsx
import { useSyncStatus } from '@nuxx-brandly/db-client';
import { db } from '../lib/nuxx-constants';

export function SyncStatusBadge() {
  // Firma EXACTA: { isOnline, isSyncing, pendingCount, lastSyncedAt, syncError, flushSync }
  // (NO existen `lastError` ni `syncNow`)
  const { isOnline, isSyncing, pendingCount, syncError, flushSync } = useSyncStatus(db);

  if (isOnline && pendingCount === 0 && !syncError) return null;

  return (
    <div className="flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium bg-slate-900 text-white">
      <span>
        {!isOnline
          ? `Sin conexión (${pendingCount} pendientes)`
          : isSyncing
            ? 'Sincronizando...'
            : syncError
              ? `Error de sync: ${syncError}`
              : `${pendingCount} cambios por subir`}
      </span>
      {isOnline && !isSyncing && (pendingCount > 0 || syncError) && (
        <button onClick={() => void flushSync()} className="underline">
          Reintentar
        </button>
      )}
    </div>
  );
}
```

---

## 4. Subida Offline de Imágenes y Archivos (`offline-blob://`)

Cuando `offline.enabled !== false` y el usuario llama a `await db.files.upload(file)` **sin conexión**:
1. El SDK almacena el binario en el store `blobs` de IndexedDB y devuelve `{ data: { url: 'offline-blob://<blobId>' }, error: null }`.
2. Puedes guardar esa `url` normalmente en cualquier columna de una tabla (`await db.from('photos').insert({ imageUrl: data.url })`).
3. Al recuperar la conexión, `flushSync()` sube primero los binarios pendientes a S3/MinIO y **reescribe automáticamente** toda referencia `offline-blob://<blobId>` tanto en las mutaciones del Outbox como en los registros locales de IndexedDB por la URL `https://...` definitiva antes de enviar las mutaciones al servidor.
4. Si quieres previsualizar una foto recién tomada mientras sigue offline en la sesión actual, conserva temporalmente un `URL.createObjectURL(file)` en estado de UI si `url.startsWith('offline-blob://')`.
