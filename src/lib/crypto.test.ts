import { describe, it, expect } from 'vitest'
import {
  createSessionKey,
  decryptBufferWithSession,
  decryptWithSession,
  encryptBufferWithSession,
  encryptWithSession,
} from './crypto'

describe('lib/crypto — SessionKey', () => {
  it('round-trips text through a session key', async () => {
    const session = await createSessionKey('hunter2')
    const payload = await encryptWithSession('hello world', session)
    expect(await decryptWithSession(payload, session)).toBe('hello world')
  })

  it('handles unicode plaintext', async () => {
    const session = await createSessionKey('パスフレーズ')
    const text = 'こんにちは🌸 — 安全な通信'
    const payload = await encryptWithSession(text, session)
    expect(await decryptWithSession(payload, session)).toBe(text)
  })

  it('produces a stable salt across messages from the same sender', async () => {
    const session = await createSessionKey('hunter2')
    const a = await encryptWithSession('first', session)
    const b = await encryptWithSession('second', session)
    const saltA = Uint8Array.from(atob(a), (c) => c.charCodeAt(0)).slice(1, 17)
    const saltB = Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).slice(1, 17)
    expect(Array.from(saltA)).toEqual(Array.from(saltB))
  })

  it('produces different ciphertexts for the same plaintext (fresh IV)', async () => {
    const session = await createSessionKey('hunter2')
    const a = await encryptWithSession('same', session)
    const b = await encryptWithSession('same', session)
    expect(a).not.toBe(b)
  })

  it('decrypts payloads from a peer with a different salt (cache miss path)', async () => {
    const sender = await createSessionKey('hunter2')
    const receiver = await createSessionKey('hunter2')
    // Receiver's own salt differs from sender's; the cache miss path
    // derives a fresh key for the sender's salt and stores it.
    const payload = await encryptWithSession('cross-peer', sender)
    expect(await decryptWithSession(payload, receiver)).toBe('cross-peer')
    // Second message from same sender hits the cache (still works).
    const second = await encryptWithSession('again', sender)
    expect(await decryptWithSession(second, receiver)).toBe('again')
  })

  it('rejects when the passphrase is wrong', async () => {
    const sender = await createSessionKey('right')
    const receiver = await createSessionKey('wrong')
    const payload = await encryptWithSession('secret', sender)
    await expect(decryptWithSession(payload, receiver)).rejects.toBeDefined()
  })

  it('rejects payloads that are too short to contain salt+iv', async () => {
    const session = await createSessionKey('pw')
    await expect(decryptWithSession('AAAA', session)).rejects.toThrow(/too short/i)
  })

  it('writes the v2 version byte at the head of the payload', async () => {
    const session = await createSessionKey('pw')
    const payload = await encryptWithSession('hi', session)
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    expect(bytes[0]).toBe(0x02)
  })

  it('rejects payloads with an unknown version byte', async () => {
    const session = await createSessionKey('pw')
    const payload = await encryptWithSession('hi', session)
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    bytes[0] = 0xff
    const tampered = btoa(String.fromCharCode(...bytes))
    await expect(decryptWithSession(tampered, session)).rejects.toThrow(
      /version/i,
    )
  })

  it('round-trips an ArrayBuffer through the session', async () => {
    const session = await createSessionKey('hunter2')
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const ct = await encryptBufferWithSession(source.buffer, session)
    const plain = await decryptBufferWithSession(ct, session)
    expect(Array.from(new Uint8Array(plain))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
