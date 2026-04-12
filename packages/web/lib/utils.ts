import { keccak256, toBytes } from 'viem';

// ── FORMATTERS ────────────────────────────────────────

/** Format microUSDC (6 decimals) to human-readable */
export function formatUsdc(microUsdc: string | bigint, decimals = 2): string {
  const n = typeof microUsdc === 'bigint' ? microUsdc : BigInt(microUsdc);
  const whole = n / 1_000_000n;
  const frac  = n % 1_000_000n;
  const full  = Number(whole) + Number(frac) / 1_000_000;
  return full.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format USD number to locale string */
export function formatUsd(amount: number, decimals = 2): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format MXN amount */
export function formatMxn(amount: number | string): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return n.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Shorten an Ethereum address: 0x1234…abcd */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Shorten a tx hash */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Format a date string to locale */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day:    '2-digit',
    month:  'short',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/** Time elapsed since a date */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'ahora';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ── FEE CALCULATOR ────────────────────────────────────

export const FEE_BPS = 140; // 1.4%

/** Compute fee and net amount from total USDC (in micro units) */
export function computeFee(amountUsdc: bigint): { fee: bigint; net: bigint } {
  const fee = (amountUsdc * BigInt(FEE_BPS)) / 10_000n;
  const net = amountUsdc - fee;
  return { fee, net };
}

/** Estimate MXN received from USDC amount */
export function estimateMxn(amountUsd: number, fxRate: number): {
  gross: number;
  fee:   number;
  net:   number;
  mxn:   number;
} {
  const feePct = FEE_BPS / 10_000;
  const fee    = amountUsd * feePct;
  const net    = amountUsd - fee;
  const mxn    = net * fxRate;
  return { gross: amountUsd, fee, net, mxn };
}

// ── CONTRACT HELPERS ──────────────────────────────────

/** Compute keccak256 hash of a string value (for CLABE and recipient name) */
export function hashString(value: string): `0x${string}` {
  return keccak256(toBytes(value));
}

/** Validate a Mexican CLABE number (18 digits with check digit) */
export function isValidClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
  const sum = weights.reduce((acc, w, i) => acc + (parseInt(clabe[i]) * w) % 10, 0);
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(clabe[17]);
}

/** Validate E.164 phone number */
export function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/** Convert USD amount to microUSDC bigint */
export function toMicroUsdc(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 1_000_000));
}
