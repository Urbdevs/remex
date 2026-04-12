// ── TYPES ─────────────────────────────────────────────

export interface UserProfile {
  id:               string;
  wallet_address:   string;
  kyc_status:       'none' | 'pending' | 'submitted' | 'approved' | 'declined' | 'under_review';
  transaction_tier: 'unverified' | 'standard' | 'enhanced';
  full_name:        string | null;
  kyc_approved_at:  string | null;
  created_at:       string;
}

export interface Transfer {
  remittance_id:  string;
  sender:         string;
  amount_usdc:    string;   // micro-USDC (6 decimals)
  fee_usdc:       string;
  status:         'pending' | 'processing' | 'delivered' | 'refunded';
  fx_rate:        string | null;
  mxn_amount:     string | null;
  spei_reference: string | null;
  error_message:  string | null;
  tx_hash:        string;
  block_number:   string | null;
  created_at:     string;
  resolved_at:    string | null;
  updated_at:     string;
}

export interface TransferStatus {
  remittance_id:  string;
  status:         Transfer['status'];
  spei_reference: string | null;
  mxn_amount:     string | null;
  fx_rate:        string | null;
  resolved_at:    string | null;
}

export interface CheckLimitResponse {
  allowed:      boolean;
  amountUsd:    number;
  dailySentUsd: number;
  dailyLimit:   number;
  remaining:    number;
  tier:         string;
}

export interface FxRateResponse {
  rate:       number;
  updatedAt:  string;
  fallback?:  boolean;
}

// ── JWT STORAGE ───────────────────────────────────────

const JWT_KEY = 'remex_jwt';

export function getJwt(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(JWT_KEY);
}

export function setJwt(jwt: string): void {
  localStorage.setItem(JWT_KEY, jwt);
}

export function clearJwt(): void {
  localStorage.removeItem(JWT_KEY);
}

// ── FETCH WRAPPER ─────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const jwt = getJwt();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new ApiError(res.status, body.error ?? body.message ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ── API CLIENT ────────────────────────────────────────

export const api = {
  // ── Auth ────────────────────────────────────────────
  getNonce: (address: string) =>
    request<{ nonce: string; message: string }>(`/v1/auth/nonce?address=${address}`),

  verify: (body: { address: string; signature: string; message: string }) =>
    request<{ token: string; user: UserProfile }>('/v1/auth/verify', {
      method: 'POST',
      body:   JSON.stringify(body),
    }),

  getMe: () => request<{ data: UserProfile }>('/v1/auth/me'),

  // ── Transfers ────────────────────────────────────────
  getTransfers: (params?: { status?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit  != null) qs.set('limit',  String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return request<{ data: Transfer[]; limit: number; offset: number }>(
      `/v1/transfers${q ? `?${q}` : ''}`,
    );
  },

  getTransferStatus: (id: string) =>
    request<{ data: TransferStatus }>(`/v1/transfers/${id}/status`),

  saveRecipientInfo: (body: { clabeHash: string; recipientPhone: string }) =>
    request<{ registered: boolean }>('/v1/transfers/recipient-info', {
      method: 'POST',
      body:   JSON.stringify(body),
    }),

  checkLimit: (amountUsd: number) =>
    request<CheckLimitResponse>('/v1/transfers/check-limit', {
      method: 'POST',
      body:   JSON.stringify({ amountUsd }),
    }),
};

export { ApiError };
