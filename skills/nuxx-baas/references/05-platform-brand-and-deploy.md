# 05. S3 Storage, Email, Sockets, IA Gemini, `@brandly/sdk` y Deploy en Coolify

---

## 1. Subida de Archivos a S3/MinIO (`db.files.upload`)

Deriva automáticamente la ruta `/api/nuxx-api/:appId/assets/upload` a partir de la URL configurada en `createClient`:

```typescript
const handleUpload = async (file: File) => {
  const { data, error } = await db.files.upload(file);
  if (error || !data) throw new Error(error?.message || 'Error al subir archivo');
  return data.url; // URL pública CDN/S3 (o 'offline-blob://...' si está sin red)
};
```
- **Límites del servidor:** Máximo **100 MB** por archivo, *rate limit* de **20 subidas/min**.
- **MIME types permitidos:** `image/{png,jpeg,gif,webp,svg+xml}`, `application/pdf`, `application/msword`, `.docx`, `video/{mp4,webm,quicktime}`, `audio/{mp4,webm,mpeg}`.

---

## 2. Notificaciones por Correo a la Marca (`db.email.send`)

Envía correos transaccionales (ej. formularios de contacto, alertas de pedidos/reservas) al correo oficial configurado en la identidad de la marca (`brand.contactInfo.email` en Nuxx):

```typescript
const { data, error } = await db.email.send({
  html: `<h2>Nueva reserva</h2><p>Cliente: <strong>${customerName}</strong></p>`,
  text: `Nueva reserva de ${customerName}`,
});
```
- **Límites y requisitos:** *Rate limit* de **10 correos/min**. El HTML es sanitizado en servidor (`sanitize-html`). Si la marca asociada a la app aún no tiene `contactInfo.email` configurado en Nuxx UI, el endpoint devuelve `400`.

---

## 3. Eventos en Tiempo Real (`useSocket`) e IA Gemini (`useAI`)

### Socket.IO (`useSocket`)
```typescript
import { useSocket } from '@nuxx-brandly/db-client';

const { isConnected, emit, sendMsg } = useSocket({
  url: 'https://api.nuxx.app',
  namespace: '/events',
  query: { appId: NUXX_APP_ID },
  onMessage: (payload) => console.log('Mensaje recibido:', payload),
});
```

### Proxy Seguro de IA Generativa (`useAI(db)`)
Ejecuta generaciones con `gemini-2.5-flash` a través del backend de Nuxx sin exponer API keys de Google en el navegador:
```typescript
import { useAI } from '@nuxx-brandly/db-client';
import { db } from '../lib/nuxx-constants';

const { generate, data: aiText, loading, error } = useAI(db);

// Importante: Cooldown estricto de 1 petición cada 20 segundos por IP (en cliente y servidor)
await generate(
  'Redacta 3 puntos clave para este proyecto',
  'Eres un director de operaciones conciso.'
);
```

---

## 4. Identidad Visual Dinámica de Marca (`@brandly/sdk`)

Cuando la aplicación debe hidratar dinámicamente logo, paleta de colores, redes sociales y datos de contacto de la marca en Nuxx:

```tsx
import { BrandProvider, useBrand } from '@brandly/sdk/react';

export function Root() {
  return (
    <BrandProvider
      brandToken={import.meta.env.VITE_BRAND_TOKEN || ''}
      apiUrl={import.meta.env.VITE_BRAND_API_URL || 'https://api.nuxx.app'}
    >
      <Header />
    </BrandProvider>
  );
}

function Header() {
  const { data: brand, loading } = useBrand();
  if (loading) return null;
  return (
    <header style={{ backgroundColor: brand?.design?.primaryColor ?? '#0f172a' }}>
      {brand?.design?.logoUrl && <img src={brand.design.logoUrl} alt={brand.name} />}
      <h1>{brand?.name}</h1>
    </header>
  );
}
```
> **⚠️ Nota crítica de registro npm para `@brandly/sdk`:** A diferencia de `@nuxx-brandly/db-client` (que vive en npmjs público), `@brandly/sdk` se publica en el registro privado de Gitea (`https://gitea.nuxx.app/api/packages/brandly/npm/`). Si agregas `@brandly/sdk` al `package.json` de una app desplegada en Coolify, incluye un archivo `.npmrc` en la raíz con:
> ```ini
> @brandly:registry=https://gitea.nuxx.app/api/packages/brandly/npm/
> ```

---

## 5. Reglas de Despliegue en Gitea + Coolify (`Dockerfile`)

1. **Despliegue desde Nuxx UI (`IdeController`):** Si el repositorio **no** tiene `Dockerfile`, al desplegar desde Nuxx UI el sistema genera automáticamente un `Dockerfile` Multi-Stage (`node:22-alpine` + `nginx:alpine` en puerto `80`) que inyecta el Service Worker PWA desde `nuxx.json` y el fallback SPA `try_files $uri $uri/ /index.html`.
2. **Despliegue por `git push` con `Dockerfile` propio en el repo:**
   Vite incrusta las variables `import.meta.env.VITE_*` **en tiempo de compilación** (`npm run build`). Si tu repositorio incluye un `Dockerfile` propio, el stage `builder` **DEBE** declarar `ARG` y `ENV` para todas las variables `VITE_*` antes de correr `npm run build`, o el bundle quedará vacío en producción:
   ```dockerfile
   FROM node:22-alpine AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .

   ARG VITE_API_URL
   ARG VITE_APP_ID
   ARG VITE_PROJECT_ID
   ARG VITE_NUXX_DB_API_KEY
   ARG VITE_BRAND_TOKEN
   ENV VITE_API_URL=$VITE_API_URL
   ENV VITE_APP_ID=$VITE_APP_ID
   ENV VITE_PROJECT_ID=$VITE_PROJECT_ID
   ENV VITE_NUXX_DB_API_KEY=$VITE_NUXX_DB_API_KEY
   ENV VITE_BRAND_TOKEN=$VITE_BRAND_TOKEN

   RUN npm run build
   ```
