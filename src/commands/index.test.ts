import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCommand, type CommandContext } from './index'
import { initialState, type SessionState } from '../state/session'
import type { ChatLog } from '../hooks/useChatLog'
import type { PeerController } from '../hooks/usePeer'
import { createSessionKey, encryptWithSession } from '../lib/crypto'

const makePeer = (): PeerController => ({
  login: vi.fn(),
  logout: vi.fn(),
  connectTo: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  disconnect: vi.fn(),
  listPeers: vi.fn(() => []),
  send: vi.fn(async () => {}),
  ping: vi.fn(async () => null),
  sendFile: vi.fn(async () => {}),
  acceptIncomingFile: vi.fn(),
  saveReceivedFile: vi.fn(async () => {}),
  cancelTransfer: vi.fn(),
})

const makeChatLog = (): ChatLog => ({
  append: vi.fn(),
  read: vi.fn().mockReturnValue(null),
  list: vi.fn().mockReturnValue([]),
  remove: vi.fn().mockReturnValue(false),
  clear: vi.fn(),
  todayKey: vi.fn().mockReturnValue('2026-04-19'),
})

const makeCtx = (overrides: Partial<SessionState> = {}): CommandContext => ({
  peer: makePeer(),
  chatLog: makeChatLog(),
  state: { ...initialState, ...overrides },
  print: vi.fn(),
})

describe('runCommand — gating', () => {
  it('rejects /login when not online', async () => {
    const ctx = makeCtx({ status: 'logged_in', peerId: 'alice' })
    await runCommand('/login bob', ctx)
    expect(ctx.peer.login).not.toHaveBeenCalled()
    expect(ctx.print).toHaveBeenCalledWith(
      'CLI-CHAT',
      'Command not allowed in the current status.',
    )
  })

  it('allows /login when online', async () => {
    const ctx = makeCtx({ status: 'online' })
    await runCommand('/login alice', ctx)
    expect(ctx.peer.login).toHaveBeenCalledWith('alice')
  })

  it('rejects /connect without a destination ID', async () => {
    const ctx = makeCtx({ status: 'logged_in', peerId: 'alice' })
    await runCommand('/connect', ctx)
    expect(ctx.peer.connectTo).not.toHaveBeenCalled()
    expect(ctx.print).toHaveBeenCalledWith('CLI-CHAT', 'Need a destination ID.')
  })

  it('reports unknown /commands', async () => {
    const ctx = makeCtx({ status: 'online' })
    await runCommand('/wat', ctx)
    expect(ctx.print).toHaveBeenCalledWith(
      'CLI-CHAT',
      expect.stringContaining('Unknown command'),
    )
  })

  it('treats free-form input outside connecting/connected as a hint', async () => {
    const ctx = makeCtx({ status: 'online' })
    await runCommand('login alice', ctx)
    expect(ctx.peer.login).not.toHaveBeenCalled()
    expect(ctx.print).toHaveBeenCalledWith(
      'CLI-CHAT',
      expect.stringContaining('/help'),
    )
  })
})

describe('runCommand — connecting state response', () => {
  let ctx: CommandContext
  beforeEach(() => {
    ctx = makeCtx({
      status: 'connecting',
      peerId: 'alice',
      pendingPeerId: 'bob',
      pendingEncrypted: false,
    })
  })

  it("'y' accepts plain request", async () => {
    await runCommand('y', ctx)
    expect(ctx.peer.accept).toHaveBeenCalledWith()
  })

  it("'n' rejects request", async () => {
    await runCommand('n', ctx)
    expect(ctx.peer.reject).toHaveBeenCalled()
  })

  it("'y <key>' is required for encrypted requests", async () => {
    const encCtx = makeCtx({
      status: 'connecting',
      peerId: 'alice',
      pendingPeerId: 'bob',
      pendingEncrypted: true,
    })
    await runCommand('y secret', encCtx)
    expect(encCtx.peer.accept).toHaveBeenCalledWith('secret')

    const encCtx2 = makeCtx({
      status: 'connecting',
      pendingEncrypted: true,
      pendingPeerId: 'bob',
    })
    await runCommand('y', encCtx2)
    expect(encCtx2.peer.accept).not.toHaveBeenCalled()
  })
})

describe('runCommand — log decryption', () => {
  it('decrypts AES-GCM payloads when key is provided', async () => {
    const session = await createSessionKey('pw')
    const payload = await encryptWithSession('hello', session)
    const ctx = makeCtx()
    ;(ctx.chatLog.read as ReturnType<typeof vi.fn>).mockReturnValue(
      `bob> ${payload}\n`,
    )
    await runCommand('/log 2026-04-19 pw', ctx)
    expect(ctx.print).toHaveBeenCalledWith('bob', 'hello')
  })

  it('reports failure on wrong key', async () => {
    const session = await createSessionKey('right')
    const payload = await encryptWithSession('hello', session)
    const ctx = makeCtx()
    ;(ctx.chatLog.read as ReturnType<typeof vi.fn>).mockReturnValue(
      `bob> ${payload}\n`,
    )
    await runCommand('/log 2026-04-19 wrong', ctx)
    expect(ctx.print).toHaveBeenCalledWith(
      'CLI-CHAT',
      expect.stringContaining('Failed to decrypt'),
    )
  })
})

describe('runCommand — connected free-form input', () => {
  it('routes plain input to peer.send', async () => {
    const ctx = makeCtx({ status: 'connected', peerId: 'alice', peers: ['bob'] })
    await runCommand('hello there', ctx)
    expect(ctx.peer.send).toHaveBeenCalledWith('hello there')
  })

  it('treats unknown /-prefixed input as chat content in connected state', async () => {
    const ctx = makeCtx({ status: 'connected', peerId: 'alice', peers: ['bob'] })
    await runCommand('/shrug', ctx)
    expect(ctx.peer.send).toHaveBeenCalledWith('/shrug')
  })

  it('still dispatches known /commands while connected', async () => {
    const ctx = makeCtx({ status: 'connected', peerId: 'alice', peers: ['bob'] })
    await runCommand('/disconnect', ctx)
    expect(ctx.peer.disconnect).toHaveBeenCalled()
    expect(ctx.peer.send).not.toHaveBeenCalled()
  })
})
