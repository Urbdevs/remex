'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAccount, useSignMessage } from 'wagmi';
import { wagmiConfig } from '@/lib/wagmi';
import { api, clearJwt, getJwt, setJwt, type UserProfile } from '@/lib/api';

// ── AUTH CONTEXT ──────────────────────────────────────

interface AuthContextValue {
  jwt:     string | null;
  user:    UserProfile | null;
  loading: boolean;
  login:   (address: `0x${string}`) => Promise<void>;
  logout:  () => void;
}

const AuthContext = createContext<AuthContextValue>({
  jwt:     null,
  user:    null,
  loading: false,
  login:   async () => {},
  logout:  () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── INNER AUTH PROVIDER (needs wagmi hooks) ───────────

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [jwt,     setJwtState] = useState<string | null>(null);
  const [user,    setUser]     = useState<UserProfile | null>(null);
  const [loading, setLoading]  = useState(false);

  const { address, isConnected } = useAccount();
  const { signMessageAsync }     = useSignMessage();

  // Restore session from localStorage on mount
  useEffect(() => {
    const stored = getJwt();
    if (!stored) return;
    setJwtState(stored);
    api.getMe()
      .then(({ data }) => setUser(data))
      .catch(() => { clearJwt(); setJwtState(null); });
  }, []);

  // Auto-SIWE when wallet connects (no existing JWT)
  useEffect(() => {
    if (isConnected && address && !jwt && !loading) {
      login(address).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  const login = useCallback(async (addr: `0x${string}`) => {
    setLoading(true);
    try {
      const { message } = await api.getNonce(addr);
      const signature   = await signMessageAsync({ message });
      const { token, user: u } = await api.verify({ address: addr, signature, message });
      setJwt(token);
      setJwtState(token);
      setUser(u);
    } finally {
      setLoading(false);
    }
  }, [signMessageAsync]);

  const logout = useCallback(() => {
    clearJwt();
    setJwtState(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ jwt, user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── ROOT PROVIDERS ────────────────────────────────────

export function Providers({ children }: { children: React.ReactNode }) {
  // useState ensures QueryClient is created once per mount (avoids hydration mismatch)
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1 },
    },
  }));

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
