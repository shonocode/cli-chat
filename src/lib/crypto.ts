// Wire format: version(1) | salt(16) | iv(12) | ciphertext+tag, all base64.
// Version byte lets us upgrade KDF parameters without breaking older payloads.
const VERSION_V1 = 0x01 // PBKDF2-SHA256 200_000 iterations (legacy, read-only)
const VERSION_V2 = 0x02 // PBKDF2-SHA256 600_000 iterations (current default)
const CURRENT_VERSION = VERSION_V2

const ITERATIONS: Record<number, number> = {
  [VERSION_V1]: 200_000,
  [VERSION_V2]: 600_000,
}

const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BITS = 256

const subtle = (): SubtleCrypto => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API is not available in this environment')
  }
  return crypto.subtle
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> => {
  const baseKey = await subtle().importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// SessionKey amortizes PBKDF2 (600k iterations, ~1s on phones) over the
// lifetime of a room: derive once when the room is established, then reuse
// the CryptoKey for every message and every file chunk. The sender uses a
// fixed salt for the whole session so the receiver only pays PBKDF2 once
// per distinct sender, cached in `inboundCache` keyed by salt.
//
// Wire format is `version(1) | salt(16) | iv(12) | ct+tag`, base64. Salt
// is read from each incoming payload, so peers with different ownSalts
// can interoperate transparently.

export type SessionKey = {
  // Kept in memory so we can derive new keys for incoming messages whose
  // salt we haven't seen yet (e.g. legacy log entries decrypted via /log).
  passphrase: string
  // Salt used on the outgoing path. Random per-session (not per-message)
  // so the receiver only pays PBKDF2 once for our messages.
  ownSalt: Uint8Array
  ownKey: CryptoKey
  // Cached derived keys keyed by `version:saltHex` for the incoming path.
  // Capped via Map insertion order — in practice ≤ N peers in a room.
  inboundCache: Map<string, CryptoKey>
}

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

export const createSessionKey = async (
  passphrase: string,
): Promise<SessionKey> => {
  const ownSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const ownKey = await deriveKey(
    passphrase,
    ownSalt,
    ITERATIONS[CURRENT_VERSION],
  )
  return {
    passphrase,
    ownSalt,
    ownKey,
    inboundCache: new Map(),
  }
}

export const encryptWithSession = async (
  plaintext: string,
  session: SessionKey,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      session.ownKey,
      encoder.encode(plaintext),
    ),
  )
  return toBase64(
    concat(
      new Uint8Array([CURRENT_VERSION]),
      session.ownSalt,
      iv,
      ciphertext,
    ),
  )
}

export const decryptWithSession = async (
  payload: string,
  session: SessionKey,
): Promise<string> => {
  const bytes = fromBase64(payload)
  if (bytes.byteLength <= 1 + SALT_BYTES + IV_BYTES) {
    throw new Error('Ciphertext payload is too short')
  }
  const version = bytes[0]
  const iterations = ITERATIONS[version]
  if (!iterations) {
    throw new Error(`Unknown crypto payload version: 0x${version.toString(16)}`)
  }
  const salt = bytes.slice(1, 1 + SALT_BYTES)
  const iv = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES)
  const ciphertext = bytes.slice(1 + SALT_BYTES + IV_BYTES)
  const cacheKey = `${version}:${toHex(salt)}`
  let key = session.inboundCache.get(cacheKey)
  if (!key) {
    key = await deriveKey(session.passphrase, salt, iterations)
    session.inboundCache.set(cacheKey, key)
  }
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )
  return decoder.decode(plaintext)
}

// Encrypt an ArrayBuffer (file chunk) directly, avoiding the
// base64 → text round-trip that the string-based path would force.
// Wire format is identical — version | salt | iv | ct — but kept binary.
export const encryptBufferWithSession = async (
  buffer: ArrayBuffer,
  session: SessionKey,
): Promise<ArrayBuffer> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      session.ownKey,
      buffer,
    ),
  )
  const out = concat(
    new Uint8Array([CURRENT_VERSION]),
    session.ownSalt,
    iv,
    ciphertext,
  )
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer
}

export const decryptBufferWithSession = async (
  buffer: ArrayBuffer,
  session: SessionKey,
): Promise<ArrayBuffer> => {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength <= 1 + SALT_BYTES + IV_BYTES) {
    throw new Error('Ciphertext payload is too short')
  }
  const version = bytes[0]
  const iterations = ITERATIONS[version]
  if (!iterations) {
    throw new Error(`Unknown crypto payload version: 0x${version.toString(16)}`)
  }
  const salt = bytes.slice(1, 1 + SALT_BYTES)
  const iv = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES)
  const ciphertext = bytes.slice(1 + SALT_BYTES + IV_BYTES)
  const cacheKey = `${version}:${toHex(salt)}`
  let key = session.inboundCache.get(cacheKey)
  if (!key) {
    key = await deriveKey(session.passphrase, salt, iterations)
    session.inboundCache.set(cacheKey, key)
  }
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )
  return plaintext
}
