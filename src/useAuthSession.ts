import { useCallback, useEffect, useState } from 'react';
import type { NuxxDbAuthSession, NuxxDbAuthUser, NuxxDbClient } from './index';

export interface UseAuthSessionReturn {
  session: NuxxDbAuthSession | null;
  user: NuxxDbAuthUser | null;
  /** True while an automatic `?nuxx_magic=<token>` URL handshake is in progress on boot. */
  isLoading: boolean;
  signOut: () => Promise<void>;
}

/**
 * React hook that tracks the active end-user session on `db.auth` (including automatic
 * permanent Magic Link `?nuxx_magic=` URL handshakes).
 */
export function useAuthSession(client: NuxxDbClient): UseAuthSessionReturn {
  const [session, setSession] = useState<NuxxDbAuthSession | null>(() => client.auth.getSession());
  const [isLoading, setIsLoading] = useState<boolean>(() => client.auth.isExchangingMagicLink());

  useEffect(() => {
    let mounted = true;
    const unsubscribe = client.auth.onAuthStateChange((nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setIsLoading(client.auth.isExchangingMagicLink());
    });

    void client.auth.ready().then((resolvedSession) => {
      if (!mounted) return;
      setSession(resolvedSession);
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [client]);

  const signOut = useCallback(async () => {
    await client.auth.signOut();
  }, [client]);

  return {
    session,
    user: session?.user ?? null,
    isLoading,
    signOut,
  };
}
