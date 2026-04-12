import crypto from 'crypto';

// ── AES-256-GCM ───────────────────────────────────────
// Formato almacenado: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
// IV: 12 bytes aleatorio por cifrado (no reutilizar nunca)
// Tag: 16 bytes GCM authentication tag
// Key: 32 bytes desde NOTIFICATION_ENCRYPTION_KEY (64 hex chars)

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12;
const TAG_BYTES  = 16;

function getKey(): Buffer {
  const hex = process.env.NOTIFICATION_ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) {
    throw new Error(
      'NOTIFICATION_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
      'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key    = getKey();
  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }
  const [ivHex, tagHex, ciphertextHex] = parts;
  const key        = getKey();
  const iv         = Buffer.from(ivHex,        'hex');
  const tag        = Buffer.from(tagHex,        'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted value: wrong IV or tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

// ── MASK para logs (nunca loguear datos sensibles) ────
export function maskPhone(phone: string): string {
  if (phone.length < 7) return '***';
  return phone.slice(0, 3) + '****' + phone.slice(-3);
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return user.slice(0, 2) + '***@' + domain;
}
