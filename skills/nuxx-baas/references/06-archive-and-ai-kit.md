# 06. Motor Universal `Archive` (`.nuxx.zip`, JSON & Kit IA con `db.archive`)

A partir de `@nuxx-brandly/db-client` **v0.7.0**, toda aplicación conectada a Nuxx BaaS dispone de un motor universal de empaquetado relacional (`db.archive`) que permite:
1. **Exportar** grafos completos o sub-grafos por entidad raíz (`rootTable` + `rootId`) junto con sus binarios S3 en un archivo portable `.nuxx.zip`.
2. **Importar** paquetes `.nuxx.zip` o payloads JSON puros remapeando automáticamente **IDs simbólicos** (ej. `"course_1"`, `"module_intro"`) a `ObjectId` reales de MongoDB respetando todas las relaciones `foreignKeys`, subiendo archivos de `assets/*` (o `inlineAssets` SVG) a S3/MinIO y sincronizando los deltas en IndexedDB.
3. **Generar Kits IA (`getAiKit`) y Plantillas (`downloadTemplate`)** para que usuarios finales o LLMs externos (ChatGPT, Claude, Gemini) creen paquetes válidos para la app sin conocer IDs internos de base de datos.

---

## 1. Declaración de `archive` y `columns[].enum` en `nuxx.json`

En la raíz de `nuxx.json` puedes configurar opcionalmente el bloque `archive`, y en cualquier columna puedes declarar `enum` (arreglo no vacío de `string` o `number`) para restringir valores válidos y guiar al generador de prompts IA:

```json
{
  "description": "Academia interactiva de cursos, módulos y lecciones multimedia.",
  "archive": {
    "rootTables": ["courses"],
    "fileExtension": ".course.nuxx.zip",
    "aiContext": "Cada curso debe incluir al menos 2 módulos ordenados por `position` y lecciones con ejercicios prácticos."
  },
  "tables": [
    {
      "tableName": "courses",
      "requiresAuth": true,
      "columns": [
        { "name": "title", "type": "string", "required": true },
        {
          "name": "level",
          "type": "string",
          "required": true,
          "enum": ["beginner", "intermediate", "advanced"]
        },
        { "name": "coverUrl", "type": "string", "description": "Ruta en assets/covers/ o URL S3" }
      ]
    },
    {
      "tableName": "lessons",
      "requiresAuth": true,
      "columns": [
        { "name": "courseId", "type": "objectId", "required": true },
        { "name": "title", "type": "string", "required": true },
        { "name": "diagramUrl", "type": "string" }
      ],
      "foreignKeys": [
        {
          "localColumn": "courseId",
          "foreignTable": "courses",
          "foreignColumn": "_id",
          "as": "course"
        }
      ]
    }
  ]
}
```

### Reglas de Validación (`npx nuxx-baas validate ./nuxx.json`)
- `archive.rootTables`: `string[]` opcional; cada nombre **debe** existir en `tables`.
- `archive.fileExtension`: `string` no vacío opcional (ej. `".nuxx.zip"` o `".deck.nuxx.zip"`).
- `archive.aiContext`: `string` opcional con instrucciones de dominio inyectadas en `db.archive.getAiKit()`.
- `columns[].enum`: arreglo no vacío cuyos elementos sean `string` o `number` finitos (`npx nuxx-baas gen-types` genera uniones literales TypeScript automáticamente).

---

## 2. Anatomía del Paquete `.nuxx.zip` y Payloads JSON

Un paquete `.nuxx.zip` (o el objeto pasado a `db.archive.importJson`) desacopla los IDs físicos y las URLs de almacenamiento:

```text
mi-curso.nuxx.zip
├── manifest.json          # Metadatos opcionales (rootTable, version, exportedAt)
├── data.json              # { "tables": { "courses": [...], "lessons": [...] }, "inlineAssets"?: {...} }
└── assets/
    ├── covers/
    │   └── portada.png
    └── diagrams/
        └── flujo.svg
```

1. **IDs Simbólicos y Remapeo Topológico:**
   - En `data.json` (o `tables/*.json`), cada fila puede usar un `_id` simbólico legible (ej. `"_id": "course_ts_101"`), y las columnas `objectId` hijas apuntan a ese mismo string (`"courseId": "course_ts_101"`).
   - Al importar, el servidor ordena las tablas según sus `foreignKeys`, genera nuevos `ObjectId` reales de 24 hexadecimales para cada registro, reescribe todas las claves foráneas y devuelve el diccionario `idMap` (`{ "course_ts_101": "6734..." }`).
2. **Referencias de Archivos (`assets/*` y `inlineAssets` / SVG):**
   - Si cualquier campo string de una fila contiene `"assets/covers/portada.png"`, el motor sube ese archivo del ZIP a S3/MinIO y sustituye automáticamente el campo por la URL `https://...` definitiva antes de insertar en MongoDB.
   - En modo JSON puro (`importJson`), `inlineAssets` permite mapear rutas virtuales (ej. `"assets/diagrams/flujo.svg": "<svg ...>...</svg>"` o Data URLs) sin crear un archivo binario `.zip`; el servidor las sube como assets reales y reescribe las URLs.
   - Si el ZIP incluye archivos dentro de `assets/<carpeta>/<archivo>` que ninguna fila referenció explícitamente, el motor igual los sube y los reporta en `result.unreferencedAssets` (`{ zipPath, folder, fileName, url }`).

---

## 3. Contratos y Uso de `db.archive` en React / TypeScript

`db.archive` hereda automáticamente `x-ephemeral-api-key` y el `Authorization: Bearer <token>` activo de `db.auth`, y refresca en segundo plano las colecciones afectadas en IndexedDB (`pullCollectionDeltas`) tras cada importación exitosa.

### 3.1 Exportar o Descargar Paquetes (`.nuxx.zip`)

```typescript
// A) Descarga directa en el navegador (usa filename, Content-Disposition o 'export.nuxx.zip')
const { error } = await db.archive.downloadExport({
  rootTable: 'courses',
  rootId: course._id,     // Opcional: exporta solo este curso y sus tablas hijas relacionadas
  includeAssets: true,    // Default en servidor: empaqueta también los binarios S3 en assets/
  filename: `${course.slug}.course.nuxx.zip`,
});

// B) Obtener el Blob crudo (ej. para previsualizar tamaño, subir a otro destino o compartir con Web Share API)
const { data: zipBlob, error: zipErr } = await db.archive.exportZip({
  rootTable: 'courses',
  rootId: course._id,
  includeAssets: true,
});
```

### 3.2 Importar un Archivo `.nuxx.zip` (`importPackage`)

```tsx
async function handleZipSelect(file: File) {
  // NUNCA construyas FormData ni Content-Type a mano; importPackage lo gestiona y sincroniza IndexedDB
  const { data, error } = await db.archive.importPackage(file, {
    rootTable: 'courses',
  });

  if (error || !data) {
    console.error('Error al importar paquete:', error);
    return;
  }

  console.log('Filas importadas por tabla:', data.importedCounts);
  console.log('Nuevos IDs raíz:', data.rootIds);
  console.log('Mapa simbólico -> ObjectId:', data.idMap);
  console.log('Assets subidos a S3:', data.assetsUploaded, data.unreferencedAssets);
}
```

### 3.3 Importar JSON Generado por IA (`importJson`)

Ideal para flujos "Pegar JSON de ChatGPT/Claude" sin obligar al usuario a comprimir un `.zip`:

```typescript
const { data, error } = await db.archive.importJson(
  {
    tables: {
      courses: [
        {
          _id: 'course_1',
          title: 'Arquitectura Offline-First',
          level: 'intermediate',
          coverUrl: 'assets/covers/hero.svg',
        },
      ],
      lessons: [
        {
          _id: 'lesson_1',
          courseId: 'course_1',
          title: 'IndexedDB y Outbox Compaction',
        },
      ],
    },
    inlineAssets: {
      'assets/covers/hero.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#111827"/></svg>',
    },
  },
  { rootTable: 'courses' }
);
// También acepta un string JSON crudo: await db.archive.importJson(rawJsonString, { rootTable: 'courses' })
```

### 3.4 Obtener el Kit de Prompt IA (`getAiKit`) y Plantilla Base (`downloadTemplate`)

```typescript
// 1. Generar prompt listo para copiar a un LLM externo con el esquema real, enums y relaciones
const { data: kit, error: kitErr } = await db.archive.getAiKit({
  rootTable: 'courses',
  mode: 'json', // 'zip' | 'json'
  brief: 'Curso práctico de TypeScript estricto con 3 módulos y ejemplos reales',
});

if (kit) {
  await navigator.clipboard.writeText(kit.prompt);
  // kit.fileExtension -> ej. ".course.nuxx.zip"
  // kit.schemaSummary -> resumen estructurado de tablas, columnas y foreignKeys
}

// 2. Descargar un .nuxx.zip plantilla con README, estructura de carpetas assets/ y ejemplo válido
await db.archive.downloadTemplate({
  rootTable: 'courses',
  filename: 'plantilla-curso.nuxx.zip',
});
```
