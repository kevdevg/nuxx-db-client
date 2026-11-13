import type {
  BulkUpdateItemResult,
  BulkUpdateResult,
  NuxxDbResponse,
  QueryFilter,
  QueryPayload,
} from '../index';
import type { NuxxOfflineStore } from './indexedDbStore';
import { generateObjectId } from './objectId';

function normalizeComparable(val: any): any {
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
    const parsed = Date.parse(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return val;
}

function matchesSingleFilter(doc: Record<string, any>, filter: QueryFilter): boolean {
  const rawDocVal = doc[filter.column];
  const docVal = normalizeComparable(rawDocVal);
  const targetVal = normalizeComparable(filter.value);

  switch (filter.operator) {
    case 'eq':
      return String(rawDocVal ?? '') === String(filter.value ?? '') || docVal === targetVal;
    case 'neq':
      return String(rawDocVal ?? '') !== String(filter.value ?? '') && docVal !== targetVal;
    case 'gt':
      return docVal > targetVal;
    case 'gte':
      return docVal >= targetVal;
    case 'lt':
      return docVal < targetVal;
    case 'lte':
      return docVal <= targetVal;
    case 'in': {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      return list.some(
        (item) =>
          String(rawDocVal ?? '') === String(item ?? '') || normalizeComparable(item) === docVal
      );
    }
    case 'contains':
      return String(rawDocVal ?? '')
        .toLowerCase()
        .includes(String(filter.value ?? '').toLowerCase());
    default:
      return true;
  }
}

export function matchesFilters(
  doc: Record<string, any>,
  filters: QueryFilter[],
  combinator: 'and' | 'or' = 'and'
): boolean {
  if (!filters || filters.length === 0) return true;
  if (combinator === 'or') {
    return filters.some((f) => matchesSingleFilter(doc, f));
  }
  return filters.every((f) => matchesSingleFilter(doc, f));
}

export async function executeLocalQuery<T = any>(
  store: NuxxOfflineStore,
  payload: QueryPayload
): Promise<NuxxDbResponse<T>> {
  const {
    collection,
    operation,
    select,
    filters = [],
    combinator = 'and',
    order,
    limit,
    offset,
    data,
    count,
    updates,
  } = payload;

  const allDocs = await store.getCollectionDocs(collection);

  switch (operation) {
    case 'select': {
      const matched = allDocs.filter((doc) => matchesFilters(doc, filters, combinator));
      const totalCount = matched.length;

      if (order?.column) {
        const col = order.column;
        const dir = order.ascending ? 1 : -1;
        matched.sort((a, b) => {
          const va = normalizeComparable(a[col]);
          const vb = normalizeComparable(b[col]);
          if (va < vb) return -1 * dir;
          if (va > vb) return 1 * dir;
          return 0;
        });
      }

      const start = offset ? Number(offset) : 0;
      const sliced = limit ? matched.slice(start, start + Number(limit)) : matched.slice(start);

      let projected = sliced;
      if (select && select !== '*') {
        projected = await applyLocalSelectProjection(store, collection, sliced, select);
      }

      return {
        data: projected as unknown as T,
        error: null,
        count: count === 'exact' ? totalCount : null,
      };
    }

    case 'insert': {
      const inputArray = Array.isArray(data) ? data : [data];
      const nowIso = new Date().toISOString();
      const insertedIds: Record<number, string> = {};

      const docsToInsert = inputArray.map((item, idx) => {
        const id = String(item?._id || item?.id || generateObjectId());
        insertedIds[idx] = id;
        return {
          ...item,
          _id: id,
          createdAt: item?.createdAt || nowIso,
          updatedAt: nowIso,
        };
      });

      await store.upsertDocs(collection, docsToInsert);
      await store.enqueueMutation({
        collection,
        operation: 'insert',
        data: Array.isArray(data) ? docsToInsert : docsToInsert[0],
        filters: [],
      });

      return {
        data: {
          acknowledged: true,
          insertedCount: docsToInsert.length,
          insertedIds,
        } as unknown as T,
        error: null,
      };
    }

    case 'update': {
      const matched = allDocs.filter((doc) => matchesFilters(doc, filters, combinator));
      const nowIso = new Date().toISOString();
      const updatedDocs = matched.map((doc) => ({
        ...doc,
        ...(data || {}),
        _id: doc._id,
        updatedAt: nowIso,
      }));

      if (updatedDocs.length > 0) {
        await store.upsertDocs(collection, updatedDocs);
      }

      await store.enqueueMutation({
        collection,
        operation: 'update',
        data,
        filters,
        combinator,
      });

      return {
        data: {
          acknowledged: true,
          matchedCount: matched.length,
          modifiedCount: updatedDocs.length,
        } as unknown as T,
        error: null,
      };
    }

    case 'delete': {
      const matched = allDocs.filter((doc) => matchesFilters(doc, filters, combinator));
      const idsToDelete = matched.map((d) => String(d._id)).filter(Boolean);

      if (idsToDelete.length > 0) {
        await store.deleteDocsByIds(collection, idsToDelete);
      }

      await store.enqueueMutation({
        collection,
        operation: 'delete',
        filters,
        combinator,
      });

      return {
        data: {
          acknowledged: true,
          deletedCount: idsToDelete.length,
        } as unknown as T,
        error: null,
      };
    }

    case 'bulkUpdate': {
      const records = updates || [];
      const docMap = new Map(allDocs.map((d) => [String(d._id), d]));
      const nowIso = new Date().toISOString();
      const docsToUpsert: Record<string, any>[] = [];
      const results: BulkUpdateItemResult[] = [];
      let matchedCount = 0;
      let modifiedCount = 0;

      for (const rec of records) {
        const existing = docMap.get(String(rec.id));
        if (!existing) {
          results.push({ id: rec.id, success: false, error: 'not found' });
          continue;
        }
        matchedCount++;
        modifiedCount++;
        const updated = {
          ...existing,
          ...rec.data,
          _id: existing._id,
          updatedAt: nowIso,
        };
        docsToUpsert.push(updated);
        results.push({ id: rec.id, success: true });
      }

      if (docsToUpsert.length > 0) {
        await store.upsertDocs(collection, docsToUpsert);
      }

      await store.enqueueMutation({
        collection,
        operation: 'bulkUpdate',
        updates: records,
        filters: [],
      });

      return {
        data: {
          matchedCount,
          modifiedCount,
          results,
        } as unknown as BulkUpdateResult as unknown as T,
        error: null,
      };
    }

    default:
      return {
        data: null,
        error: { message: `Unsupported operation: ${String(operation)}` },
      };
  }
}

async function applyLocalSelectProjection(
  store: NuxxOfflineStore,
  collection: string,
  docs: Record<string, any>[],
  select: string
): Promise<Record<string, any>[]> {
  const matches = select.match(/([a-zA-Z0-9_]+)\(([^)]+)\)|([a-zA-Z0-9_]+)/g);
  if (!matches) return docs;

  const schema = await store.getSchema(collection);
  const foreignCache = new Map<string, Record<string, any>[]>();

  const result: Record<string, any>[] = [];
  for (const doc of docs) {
    const projected: Record<string, any> = { _id: doc._id };

    for (const token of matches) {
      if (token.includes('(')) {
        const [relNameRaw, relFieldsRaw] = token.split('(');
        const relName = relNameRaw.trim();
        const relFields = relFieldsRaw
          .replace(')', '')
          .split(',')
          .map((f) => f.trim());

        const fk = schema?.foreignKeys?.find((k) => k.as === relName);
        if (fk) {
          if (!foreignCache.has(fk.foreignTable)) {
            foreignCache.set(fk.foreignTable, await store.getCollectionDocs(fk.foreignTable));
          }
          const foreignDocs = foreignCache.get(fk.foreignTable) || [];
          const localVal = doc[fk.localColumn];
          const joined = foreignDocs.find(
            (fd) => String(fd[fk.foreignColumn]) === String(localVal)
          );

          if (!joined) {
            projected[fk.as] = null;
          } else if (relFields.includes('*')) {
            projected[fk.as] = { ...joined };
          } else {
            const sub: Record<string, any> = {};
            for (const f of relFields) {
              if (f in joined) sub[f] = joined[f];
            }
            projected[fk.as] = sub;
          }
        } else if (relName in doc) {
          projected[relName] = doc[relName];
        }
      } else {
        const field = token.trim();
        if (field in doc) {
          projected[field] = doc[field];
        }
      }
    }

    result.push(projected);
  }

  return result;
}
