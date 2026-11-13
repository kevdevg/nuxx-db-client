# 01. Especificación Exacta de `nuxx.json` y Metadatos para Hermes

El archivo `nuxx.json` en la raíz del proyecto define declarativamente las colecciones MongoDB aisladas (`nuxx_${appId}_${tableName}`), relaciones `$lookup`, permisos RBAC, configuración PWA y metadatos de descubrimiento para Hermes.

---

## 1. Esquema Zod Real en el Servidor

El backend (`NuxxSchemaSyncService`) valida todo `nuxx.json` contra este contrato estricto. Si **una sola** propiedad usa un enum inválido, rechaza todo el manifiesto con `400 BadRequestException`:

- **Raíz de `nuxx.json`:**
  - `description` (`string`, opcional): Propósito general de la app para agentes de plataforma (Hermes).
  - `agentHints` (`object`, opcional):
    - `summary` (`string`, opcional): Cómo opera el modelo de datos.
    - `workflows` (`string[]`, opcional): Flujos de negocio clave que un agente puede ejecutar o consultar.
    - `readOnlyTables` (`string[]`, opcional): Tablas que agentes externos no deben mutar directamente.
  - `archive` (`object`, opcional): Configuración del motor de exportación/importación `.nuxx.zip` y Kit IA (`rootTables`, `fileExtension`, `aiContext` — ver `06-archive-and-ai-kit.md`).
  - `pwa` (`object`, opcional): Configuración PWA Offline-First (ver `04-pwa-offline-sync.md`).
  - `tables` (`array`, **obligatorio**, mín. 1 tabla): Definición de colecciones (cada columna soporta opcionalmente `enum: (string | number)[]`).
  - `roles` (`array`, opcional, default `[]`): Semilla inicial de roles `{ name: string, permissions?: Record<string, any> }`.

---

## 2. Tipos de Columna Permitidos y Columnas Automáticas

### Tipos Válidos (`NUXX_DB_COLUMN_TYPES`)
Solo existen estos **7 tipos exactos**:
- `'string'` — Textos, slugs, URLs, enums, UUIDs.
- `'number'` — Enteros y decimales (no existen `'int'` ni `'float'`).
- `'boolean'` — Flags verdaderos/falsos.
- `'date'` — Fechas ISO-8601 / `Date` BSON.
- `'objectId'` — Referencia de 24 caracteres hexadecimales a `_id` de otra tabla o de `users`. **Obligatorio** en cualquier columna usada como `localColumn` en `foreignKeys`.
- `'array'` — Listas (`string[]`, objetos embebidos, tags).
- `'object'` — Subdocumentos JSON arbitrarios (no existe `'json'`).

### Columnas Implícitas del Motor (NO las declares `required: true`)
- `_id`: MongoDB `ObjectId` (24-hex). El cliente y servidor lo generan automáticamente. **No** lo declares en `columns` (si lo declaras `required: true`, `assertRequiredColumns` fallará cuando un `insert` no envíe `_id`).
- `createdAt` y `updatedAt`: El motor los inyecta como `Date` en cada `insert` y actualiza `updatedAt` en cada `update`/`bulkUpdate`. Puedes ordenar o filtrar por ellos (`gt`, `gte`, `lt`, `lte`, `eq`) pasando strings ISO sin declararlos en `columns`.

---

## 3. Tablas Reservadas, Relaciones (`foreignKeys`) y Roles

1. **Nombres de tabla prohibidos en `tables`:**
   - `users`, `workspaces`, `brands`, `__tombstones`.
   - **Caso especial `users`:** Nunca declares `"tableName": "users"` en `tables`, pero **SÍ puedes** referenciar `"foreignTable": "users"` dentro de `foreignKeys` para poblar al autor/propietario:
     ```json
     {
       "localColumn": "ownerId",
       "foreignTable": "users",
       "foreignColumn": "_id",
       "as": "owner"
     }
     ```
     El servidor ejecuta automáticamente un `$lookup` seguro sobre `nuxx_db_users` filtrando por `appId` y ocultando `password` y `magicLinkToken`.
2. **Reglas de oro en `foreignKeys`:**
   - `localColumn` **debe** estar declarada en `columns` con `"type": "objectId"`. Si la declaras como `"string"`, el `$lookup` en MongoDB devolverá `null` silenciosamente porque `castObjectIdFields` solo convierte columnas `'objectId'`.
   - `as` define el alias donde vendrá el objeto poblado al hacer `.select('*, owner(name, email)')`. Evita que `as` se llame exactamente igual que `localColumn` (usa `ownerId` → `as: "owner"` o `projectId` → `as: "project"`).
3. **Tabla `roles` + Semilla `roles`:**
   - Si tu app usa `user.role` / `roleId`, incluye una tabla `"tableName": "roles"` en `tables` (columnas `name` de tipo `string` y `permissions` de tipo `object`) **y** define los roles iniciales en el arreglo raíz `"roles"`. Al sincronizar el esquema, el backend hace upsert automático por `name`.
4. **Seguridad `requiresAuth` (`boolean`, default `false`):**
   - `VITE_NUXX_DB_API_KEY` es una llave pública de cliente (limitada por Throttler a `120 req/min`).
   - Con `"requiresAuth": true`, toda operación (`select`, `insert`, `update`, `delete`, `bulkUpdate`, `sync/pull`, `sync/push`) exige un JWT válido (`Authorization: Bearer <token>`) de un usuario con `status === 'active'` en esa app.
   - Usa `"requiresAuth": false` únicamente en tablas intencionalmente públicas (catálogos abiertos, RSVP de eventos públicos, etc.).

---

## 4. Plantilla Completa de Referencia (`nuxx.json`)

```json
{
  "description": "Plataforma colaborativa de gestión de proyectos y tareas por cliente.",
  "agentHints": {
    "summary": "Los proyectos pertenecen a un usuario (ownerId) y agrupan tareas priorizadas.",
    "workflows": [
      "Listar proyectos activos y contar tareas pendientes por proyecto",
      "Crear tareas asignadas a miembros activos del equipo"
    ],
    "readOnlyTables": ["roles"]
  },
  "pwa": {
    "enabled": true,
    "name": "Project Pulse",
    "shortName": "Pulse",
    "description": "Gestión de proyectos offline-first",
    "themeColor": "#0f172a",
    "backgroundColor": "#ffffff",
    "preloadTables": ["projects", "tasks"]
  },
  "roles": [
    {
      "name": "admin",
      "permissions": { "canManageUsers": true, "canDeleteProjects": true }
    },
    {
      "name": "member",
      "permissions": { "canManageUsers": false, "canDeleteProjects": false }
    }
  ],
  "tables": [
    {
      "tableName": "roles",
      "description": "Roles RBAC de la aplicación",
      "requiresAuth": true,
      "columns": [
        { "name": "name", "type": "string", "required": true },
        { "name": "permissions", "type": "object", "required": false }
      ]
    },
    {
      "tableName": "projects",
      "description": "Proyectos principales",
      "requiresAuth": true,
      "columns": [
        { "name": "title", "type": "string", "required": true },
        { "name": "status", "type": "string", "required": true },
        { "name": "budget", "type": "number", "required": false },
        { "name": "ownerId", "type": "objectId", "required": true }
      ],
      "foreignKeys": [
        {
          "localColumn": "ownerId",
          "foreignTable": "users",
          "foreignColumn": "_id",
          "as": "owner"
        }
      ]
    },
    {
      "tableName": "tasks",
      "description": "Tareas vinculadas a un proyecto",
      "requiresAuth": true,
      "columns": [
        { "name": "projectId", "type": "objectId", "required": true },
        { "name": "title", "type": "string", "required": true },
        { "name": "completed", "type": "boolean", "required": false },
        { "name": "dueDate", "type": "date", "required": false },
        { "name": "tags", "type": "array", "required": false }
      ],
      "foreignKeys": [
        {
          "localColumn": "projectId",
          "foreignTable": "projects",
          "foreignColumn": "_id",
          "as": "project"
        }
      ]
    }
  ]
}
```

## 5. Sincronización Instantánea de `nuxx.json` (Sin Redeploy ni Pasos Manuales)

1. **En desarrollo local (`npm run dev`, antes de hacer commit/push):**
   Ejecuta directamente:
   ```bash
   npx nuxx-baas sync ./nuxx.json
   ```
   El CLI valida `nuxx.json` localmente, lee `VITE_API_URL`, `VITE_APP_ID` (o `VITE_PROJECT_ID`) y `VITE_NUXX_DB_API_KEY` desde `.env.local` / `.env`, y aplica en caliente (<1 segundo) tablas, columnas, `enum`, `description`, `foreignKeys`, `roles`, `agentHints` y `archive` contra Nuxx BaaS (`POST /api/nuxx-db/:appId/schema/sync`).
   - *Restricción de seguridad:* Por protección anti-downgrade, cambiar una tabla existente de `"requiresAuth": true` a `false` usando la llave pública es rechazado (`403`); ese cambio exige `git push` al repositorio Gitea o intervención desde la consola administrativa.
2. **Al hacer `git push` a Gitea:**
   El backend detecta automáticamente cambios en `nuxx.json` (mediante webhook de Gitea + verificación SHA perezosa) y sincroniza el esquema en MongoDB en caliente **sin necesidad de relanzar el despliegue en Coolify ni entrar manualmente a Nuxx UI**.
   - Solo necesitas redesplegar el contenedor en Coolify cuando cambia código frontend (`src/*`, `package.json`) o la configuración de build `nuxx.json -> pwa`.
