import { describe, it, expect, beforeEach } from 'vitest';

const VALID_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('encrypt / decrypt roundtrip', () => {
  beforeEach(() => {
    process.env.NOTIFICATION_ENCRYPTION_KEY = VALID_KEY;
  });

  it('encrypts and decrypts a phone number correctly', async () => {
    const { encrypt, decrypt } = await import('./crypto');
    const phone = '+521234567890';
    const enc   = encrypt(phone);
    expect(decrypt(enc)).toBe(phone);
  });

  it('produces different ciphertext each call (random IV)', async () => {
    const { encrypt } = await import('./crypto');
    const a = encrypt('+521234567890');
    const b = encrypt('+521234567890');
    expect(a).not.toBe(b); // IV is random → output differs
  });

  it('stored format is iv:tag:ciphertext (3 colon-separated parts)', async () => {
    const { encrypt } = await import('./crypto');
    const enc = encrypt('hello');
    expect(enc.split(':').length).toBe(3);
  });

  it('encrypts empty string without throwing', async () => {
    const { encrypt, decrypt } = await import('./crypto');
    const enc = encrypt('');
    expect(decrypt(enc)).toBe('');
  });

  it('encrypts Unicode correctly', async () => {
    const { encrypt, decrypt } = await import('./crypto');
    const text = 'número: +52 55 1234 5678 — José';
    expect(decrypt(encrypt(text))).toBe(text);
  });
});

describe('decrypt rejects tampered data', () => {
  beforeEach(() => {
    process.env.NOTIFICATION_ENCRYPTION_KEY = VALID_KEY;
  });

  it('throws on tampered ciphertext (GCM auth tag fails)', async () => {
    const { encrypt, decrypt } = await import('./crypto');
    const enc    = encrypt('+521234567890');
    const parts  = enc.split(':');
    // Flip last byte of ciphertext
    const tampered = parts[2].slice(0, -2) + (parts[2].slice(-2) === 'ff' ? '00' : 'ff');
    expect(() => decrypt(`${parts[0]}:${parts[1]}:${tampered}`)).toThrow();
  });

  it('throws on malformed stored value (wrong number of parts)', async () => {
    const { decrypt } = await import('./crypto');
    expect(() => decrypt('only-two:parts')).toThrow('Invalid encrypted value format');
  });

  it('throws when key is wrong length', async () => {
    const { encrypt } = await import('./crypto');
    process.env.NOTIFICATION_ENCRYPTION_KEY = 'tooshort';
    expect(() => encrypt('test')).toThrow('NOTIFICATION_ENCRYPTION_KEY');
  });

  it('throws when key is missing', async () => {
    const { encrypt } = await import('./crypto');
    delete process.env.NOTIFICATION_ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow('NOTIFICATION_ENCRYPTION_KEY');
  });
});

describe('maskPhone / maskEmail', () => {
  it('masks middle of phone number', async () => {
    const { maskPhone } = await import('./crypto');
    expect(maskPhone('+521234567890')).toBe('+52****890');
  });

  it('masks very short phone safely', async () => {
    const { maskPhone } = await import('./crypto');
    expect(maskPhone('123')).toBe('***');
  });

  it('masks email user portion', async () => {
    const { maskEmail } = await import('./crypto');
    expect(maskEmail('carlos@example.com')).toBe('ca***@example.com');
  });

  it('masks email without @ safely', async () => {
    const { maskEmail } = await import('./crypto');
    expect(maskEmail('notanemail')).toBe('***');
  });
});
