import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── MOCK IOREDIS ──────────────────────────────────────
// No necesitamos Redis real para testear la lógica de nonces

const store = new Map<string, string>();

vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    set:    vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    on: vi.fn(),
  }));
  return { default: MockRedis };
});

describe('Nonce store/consume', () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it('stores and consumes a valid nonce', async () => {
    const { storeNonce, consumeNonce } = await import('./redis');
    await storeNonce('0xabc', 'nonce123');
    const result = await consumeNonce('0xabc', 'nonce123');
    expect(result).toBe(true);
  });

  it('returns false for wrong nonce', async () => {
    const { storeNonce, consumeNonce } = await import('./redis');
    await storeNonce('0xabc', 'nonce123');
    const result = await consumeNonce('0xabc', 'wrongnonce');
    expect(result).toBe(false);
  });

  it('returns false for non-existent address', async () => {
    const { consumeNonce } = await import('./redis');
    const result = await consumeNonce('0xdeadbeef', 'anynonce');
    expect(result).toBe(false);
  });

  it('nonce is consumed after first use (replay protection)', async () => {
    const { storeNonce, consumeNonce } = await import('./redis');
    await storeNonce('0xabc', 'nonce123');
    await consumeNonce('0xabc', 'nonce123');       // First use — valid
    const second = await consumeNonce('0xabc', 'nonce123'); // Replay attempt
    expect(second).toBe(false);
  });

  it('normalizes address to lowercase before storing', async () => {
    const { storeNonce, consumeNonce } = await import('./redis');
    await storeNonce('0xABC', 'nonce123');           // uppercase
    const result = await consumeNonce('0xabc', 'nonce123'); // lowercase lookup
    expect(result).toBe(true);
  });
});
