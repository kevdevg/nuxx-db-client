# 03. Autenticación, Magic Links y Permisos RBAC

Nuxx BaaS incluye gestión completa de usuarios finales aislados por aplicación (`nuxx_db_users`), tanto con contraseña tradicional como **passwordless mediante Magic Links permanentes**.

---

## 1. Hook React Oficial `useAuthSession(db)`

```typescript
import { useAuthSession } from '@nuxx-brandly/db-client';
import { db } from '../lib/nuxx-constants';

export function AppShell() {
  // Firma EXACTA: { session, user, isLoading, signOut }
  // (NO existen `ready` ni `error` en este retorno)
  const { session, user, isLoading, signOut } = useAuthSession(db);

  if (isLoading) {
    // True mientras el SDK canjea automáticamente un ?nuxx_magic= detectado en la URL
    return <div>Verificando acceso...</div>;
  }

  if (!session || !user) {
    return <LoginView />;
  }

  return (
    <div>
      <span>Hola, {user.name} ({user.role?.name ?? 'user'})</span>
      <button onClick={() => void signOut()}>Cerrar sesión</button>
    </div>
  );
}
```

### Estructura de `user` (`NuxxDbAuthUser`)
```typescript
interface NuxxDbAuthUser {
  _id: string;
  name: string;
  email: string;
  status?: string;         // 'active' | 'suspended'
  roles: string[];         // Default ['user']
  roleId?: string;
  role?: {                 // Poblado automáticamente desde nuxx_${appId}_roles
    _id: string;
    name: string;
    permissions?: Record<string, any>;
  };
  magicLinkToken?: string; // Token permanente de 64 chars hex
}
```

---

## 2. Registro, Login con Contraseña y Magic Links

### Registro y Login Clásico
```typescript
// Registro con contraseña (password es opcional: si se omite, crea usuario passwordless)
const { data, error } = await db.auth.signUp({
  name: 'Ana Gómez',
  email: 'ana@empresa.com',
  password: 'MiPasswordSegura123',
});

// Inicio de sesión con email + password
const { data: loginData, error: loginError } = await db.auth.signIn({
  email: 'ana@empresa.com',
  password: 'MiPasswordSegura123',
});
```

### Flujo de Magic Links (`?nuxx_magic=`)
1. **Auto-canje al abrir la app:** Cuando se instancia `createClient(...)` en el navegador, `db.auth` inspecciona `window.location.search` buscando `nuxx_magic` (o `magic_token` / `nuxx_token`). Si lo encuentra:
   - Limpia inmediatamente el parámetro de la barra de direcciones con `history.replaceState` para no exponer el token.
   - Canjea el token contra `POST /auth/magic` y persiste la sesión JWT (`365d`) en `localStorage`.
   - Mientras dura este canje inicial, `useAuthSession(db).isLoading` es `true` y `db.auth.isExchangingMagicLink()` devuelve `true`.
2. **Esperar hidratación fuera de React (ej. loaders de router):**
   ```typescript
   const session = await db.auth.ready(); // NUNCA uses waitForInitialAuth() (no existe)
   ```
3. **Generar, compartir o rotar un Magic Link desde un panel de administración de la app:**
   ```typescript
   // Crear invitado sin contraseña y obtener su link directo de acceso:
   const { data, error } = await db.auth.signUp({
     name: 'Invitado VIP',
     email: 'vip@cliente.com',
     roleId: guestRoleId,
   });

   if (data?.user.magicLinkToken) {
     // Construye `${window.location.origin}/?nuxx_magic=${token}`
     const inviteUrl = db.auth.buildMagicLinkUrl(data.user.magicLinkToken);
   }

   // Invalidar el link anterior generando un nuevo magicLinkToken (requiere sesión activa):
   const { data: updatedUser } = await db.auth.regenerateMagicLink(targetUserId);
   ```

---

## 3. Control de Acceso Basado en Roles (RBAC) y Administración de Usuarios

Si tu app tiene pantallas administrativas internas:
```typescript
const canManageUsers = Boolean(
  user?.role?.name === 'admin' || user?.role?.permissions?.canManageUsers
);

// Métodos de administración disponibles en db.auth (requieren sesión JWT activa):
const { data: allUsers } = await db.auth.listUsers();

await db.auth.updateUser(targetUserId, {
  roleId: newRoleId,        // o null para quitar rol
  status: 'active',         // 'active' | 'suspended' (un usuario 'suspended' es bloqueado en servidor)
});

await db.auth.deleteUser(targetUserId);
```

> **Comportamiento Offline de la Sesión:** `db.auth.getUser()` refresca los datos desde `GET /auth/me` cuando hay red, pero si el dispositivo está sin conexión conserva intacta la sesión cacheada en `localStorage` sin cerrar la sesión del usuario.
