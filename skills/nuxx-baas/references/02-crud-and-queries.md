# 02. Query Builder, Relaciones y Operaciones en Lote (`@nuxx-brandly/db-client`)

Todas las consultas sobre tablas se construyen con `db.from('<tableName>')`. El builder es *thenable* (`await db.from(...)` ejecuta directamente la consulta sin necesidad de llamar `.execute()`, aunque `.execute()` también existe).

---

## 1. Lecturas (`.select`), Joins (`foreignKeys`) y Paginación

### Lectura con Filtros, Orden y Joins Relacionales
```typescript
// Poblar llaves foráneas usando el alias `as` declarado en nuxx.json:
const { data: tasks, error } = await db
  .from('tasks')
  .select('*, project(title, status)')
  .eq('completed', false)
  .contains('title', searchQuery.trim()) // Búsqueda parcial case-insensitive ($regex 'i')
  .order('createdAt', { ascending: false })
  .limit(50); // Límite máximo permitido por el servidor: 1000
```

### Operadores de Filtro Soportados
- `.eq(col, val)` / `.neq(col, val)`
- `.gt(col, val)` / `.gte(col, val)` / `.lt(col, val)` / `.lte(col, val)`
- `.in(col, arrayVal)`
- `.contains(col, substring)`

> **⚠️ Guardia contra `undefined`:** Todos los métodos de filtro lanzan un `Error` inmediato en cliente si `val === undefined` (para evitar consultas accidentales sin filtro). Si un filtro es opcional, aplícalo condicionalmente (`if (status) query = query.eq('status', status)`) o pasa `null` explícitamente cuando busques valores nulos.

### Paginación Exacta con `.range(from, to)` + `{ count: 'exact' }`
`.range(from, to)` es **inclusivo** (`offset = from`, `limit = to - from + 1`; lanza error si `to < from`):
```typescript
const PAGE_SIZE = 20;
const from = page * PAGE_SIZE;
const to = from + PAGE_SIZE - 1;

const { data: rows, count, error } = await db
  .from('projects')
  .select('*, owner(name, email)', { count: 'exact' })
  .order('createdAt', { ascending: false })
  .range(from, to);

const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);
```

---

## 2. Inserción Individual y por Lotes (`.insert`) + `_id` Pre-asignado

- **NO existe `.bulkInsert()`**. `.insert()` acepta **un objeto único o un array de objetos**.
- Si no envías `_id`, el SDK genera en cliente un ObjectId válido de 24 caracteres hexadecimales (`generateObjectId()`) antes de enviarlo, garantizando idempotencia ante reintentos offline.
- **Forma del retorno:** `insert` retorna metadatos de inserción (`{ acknowledged, insertedCount, insertedIds }`), **no** el documento completo hidratado. Si necesitas el `_id` inmediatamente en la UI (por ejemplo para navegar al detalle o asociar hijos), pre-asígnalo con `generateObjectId()`:

```typescript
import { generateObjectId, isValidObjectId } from '@nuxx-brandly/db-client';

// Inserción individual con _id conocido de inmediato:
const newProjectId = generateObjectId();
const { error } = await db.from('projects').insert({
  _id: newProjectId,
  title: 'Lanzamiento Q4',
  status: 'active',
  ownerId: user._id, // Siempre string ObjectId de 24 hex (nunca el nombre o email)
});

// Inserción por lotes (Batch Insert):
const { data: batchRes, error: batchErr } = await db.from('tasks').insert([
  { projectId: newProjectId, title: 'Definir alcance', completed: false },
  { projectId: newProjectId, title: 'Diseñar UI', completed: false },
]);
```

> **Regla en `<select>` de formularios para Llaves Foráneas:** El `value` de cada `<option>` **siempre** debe ser `item._id` (24-hex ObjectId), nunca `item.name` o `item.title`. Si envías `"Admin"` en una columna `objectId`, la validación o el `$lookup` fallarán; valida con `isValidObjectId(id)` si el valor proviene de URL params.

---

## 3. Actualización, Borrado y Operaciones Masivas (`bulkUpdate` / `bulkDelete`)

### `.update(patch)` y `.delete()`
Encadena **siempre** al menos un filtro (como `.eq('_id', id)`), ya que en el servidor ejecutan `updateMany` / `deleteMany`:
```typescript
await db.from('tasks').update({ completed: true }).eq('_id', taskId);
await db.from('tasks').delete().eq('_id', taskId);
```

### `.bulkUpdate(updates)` (Máximo 500 registros por llamada)
Útil para reordenar tableros Kanban (`order`), cambios masivos de estado o edición en grilla donde cada fila recibe un `data` distinto:
```typescript
const { data, error } = await db.from('tasks').bulkUpdate([
  { id: taskAId, data: { completed: true } },
  { id: taskBId, data: { completed: false, title: 'Revisado' } },
]);

// Falla parcial por ítem: `error` global puede ser null aunque algún id falle
const failedItems = data?.results.filter((r) => !r.success) ?? [];
```

### `.bulkDelete(ids)`
Azúcar sintáctico sobre `.delete().in('_id', ids)` que registra automáticamente los *tombstones* para Delta Sync:
```typescript
await db.from('tasks').bulkDelete(selectedIds);
```

---

## 4. Referencia Rápida de Tipos Exportados

```typescript
import type {
  NuxxDbClient,
  NuxxClientOptions,
  NuxxOfflineOptions,
  NuxxDbFilterBuilder,
  NuxxDbResponse,
  FilterOperator,
  QueryFilter,
  QueryOrder,
  SelectOptions,
  BulkUpdateRecord,
  BulkUpdateItemResult,
  BulkUpdateResult,
} from '@nuxx-brandly/db-client';
```
