import { describe, it, expect } from 'vitest'
import {
  initialState,
  sessionReducer,
  type SessionState,
} from './session'

const advance = (state: SessionState, ...actions: Parameters<typeof sessionReducer>[1][]) =>
  actions.reduce(sessionReducer, state)

describe('sessionReducer', () => {
  it('moves offline → online once', () => {
    const next = sessionReducer(initialState, { type: 'set_online' })
    expect(next.status).toBe('online')
    const noop = sessionReducer(next, { type: 'set_online' })
    expect(noop).toBe(next)
  })

  it('records peerId on logged_in', () => {
    const next = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
    )
    expect(next.status).toBe('logged_in')
    expect(next.peerId).toBe('alice')
  })

  it('captures pending request and clears it on peer_joined', () => {
    const after = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
      { type: 'incoming_request', peerId: 'bob', encrypted: true },
    )
    expect(after.status).toBe('connecting')
    expect(after.pendingPeerId).toBe('bob')
    expect(after.pendingEncrypted).toBe(true)

    const joined = sessionReducer(after, {
      type: 'peer_joined',
      peerId: 'bob',
      key: 'secret',
    })
    expect(joined.status).toBe('connected')
    expect(joined.pendingPeerId).toBeNull()
    expect(joined.encryptionKey).toBe('secret')
    expect(joined.peers).toEqual(['bob'])
  })

  it('keeps the room key when one peer leaves but others remain', () => {
    const after = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
      { type: 'peer_joined', peerId: 'bob', key: 'secret' },
      { type: 'peer_joined', peerId: 'carol', key: 'secret' },
    )
    expect(after.peers).toEqual(['bob', 'carol'])
    const next = sessionReducer(after, { type: 'peer_left', peerId: 'bob' })
    expect(next.peers).toEqual(['carol'])
    expect(next.status).toBe('connected')
    expect(next.encryptionKey).toBe('secret')
  })

  it('falls back to logged_in when the last peer leaves', () => {
    const connected = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
      { type: 'peer_joined', peerId: 'bob', key: null },
    )
    const next = sessionReducer(connected, { type: 'peer_left', peerId: 'bob' })
    expect(next.status).toBe('logged_in')
    expect(next.peers).toEqual([])
    expect(next.encryptionKey).toBeNull()
  })

  it('reuses the existing room key when later peers join', () => {
    const after = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
      { type: 'peer_joined', peerId: 'bob', key: 'secret' },
      { type: 'peer_joined', peerId: 'carol', key: null },
    )
    // Even though carol joined with key=null, the room key set by bob persists.
    expect(after.encryptionKey).toBe('secret')
  })

  it('logged_out wipes peerId and returns to online', () => {
    const connected = advance(
      initialState,
      { type: 'set_online' },
      { type: 'logged_in', peerId: 'alice' },
    )
    const out = sessionReducer(connected, { type: 'logged_out' })
    expect(out.status).toBe('online')
    expect(out.peerId).toBe('')
  })

  it('append adds an immutable copy of messages', () => {
    const next = sessionReducer(initialState, {
      type: 'append',
      line: { sender: 'CLI-CHAT', text: 'hi' },
    })
    expect(next.messages).toHaveLength(1)
    expect(initialState.messages).toHaveLength(0)
  })
})

