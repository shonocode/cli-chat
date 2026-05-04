import { useCallback, useEffect, useRef } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import {
  createSessionKey,
  decryptBufferWithSession,
  decryptWithSession,
  encryptBufferWithSession,
  encryptWithSession,
  type SessionKey,
} from '../lib/crypto'
import {
  BACKPRESSURE_THRESHOLD,
  CHUNK_SIZE,
  deliverBlob,
  isFileFrameString,
  newTransferId,
  parseFileFrame,
  toArrayBuffer,
  type FileFrame,
} from '../lib/fileTransfer'

export type PeerEvent =
  | { type: 'login'; peerId: string }
  | { type: 'incoming'; peerId: string; encrypted: boolean }
  | { type: 'peer_joined'; peerId: string; key: string | null; auto?: boolean }
  | { type: 'peer_left'; peerId: string }
  | { type: 'incoming_canceled' }
  | { type: 'logout' }
  | { type: 'message'; sender: string; text: string; payload: string }
  | { type: 'sent'; sender: string; payload: string }
  | { type: 'system'; text: string }
  | { type: 'error'; message: string }
  | {
      type: 'file_incoming'
      from: string
      name: string
      size: number
      mime: string
    }
  | {
      type: 'file_progress'
      direction: 'send' | 'recv'
      bytes: number
      total: number
      name: string
    }
  | { type: 'file_ready'; name: string; size: number }
  | { type: 'file_sent'; name: string }
  | { type: 'file_canceled'; reason: string }

export type PeerController = {
  login(id: string): void
  logout(): void
  connectTo(peerId: string, key?: string): void
  accept(key?: string): void
  reject(): void
  disconnect(peerId?: string): void
  listPeers(): ReadonlyArray<string>
  send(text: string): Promise<void>
  ping(peerId?: string): Promise<PingResult | null>
  sendFile(file: File, peerId?: string): Promise<void>
  acceptIncomingFile(): void
  saveReceivedFile(): Promise<void>
  cancelTransfer(): void
}

export type PingResult = { rttMs: number }

type OutgoingTransfer = {
  id: string
  file: File
  peerId: string
  status: 'awaiting-accept' | 'sending' | 'aborted'
}

type IncomingTransfer = {
  id: string
  peerId: string
  name: string
  size: number
  mime: string
  expectedChunks: number
  receivedChunks: ArrayBuffer[]
  receivedBytes: number
  // PeerJS's internal encoding queue can deliver the 'done' control frame
  // before the final binary chunks finish encoding, so we don't treat 'done'
  // as a hard completion signal — we wait for both `doneReceived` and
  // `receivedBytes >= size` before finalizing the Blob.
  doneReceived: boolean
  status: 'pending' | 'receiving' | 'ready'
  blob: Blob | null
}

type ConnectionMetadata = { v: 1; encrypted: boolean; fromRoom?: boolean }

const isConnectionMetadata = (value: unknown): value is ConnectionMetadata => {
  if (!value || typeof value !== 'object') return false
  const v = (value as { v?: unknown }).v
  const e = (value as { encrypted?: unknown }).encrypted
  return v === 1 && typeof e === 'boolean'
}

const isEncryptedHandshake = (connection: DataConnection): boolean =>
  isConnectionMetadata(connection.metadata) && connection.metadata.encrypted

const isFromRoomHandshake = (connection: DataConnection): boolean =>
  isConnectionMetadata(connection.metadata) && !!connection.metadata.fromRoom

// `connection.open` lags reality after a backgrounded mobile tab wakes:
// the underlying ICE transport may already be 'disconnected' or 'failed',
// but `open` stays true until PeerJS gets around to noticing. Combine the
// two signals so a /connect retry isn't told "Already connected" when the
// channel is in fact dead. Wrapped in try/catch because, on iOS Safari
// specifically, accessing peerConnection in some torn-down states throws.
const isConnLikelyAlive = (connection: DataConnection): boolean => {
  try {
    if (!connection.open) return false
    const ice = connection.peerConnection?.iceConnectionState
    return ice !== 'failed' && ice !== 'disconnected' && ice !== 'closed'
  } catch {
    return false
  }
}

// Join-ack frame: PeerJS' DataChannel `'open'` event fires as soon as the
// underlying transport is up — i.e. before the receiver's user has had any
// chance to /accept. Without an application-level ack, the initiator would
// see "joined" before the user on the other end consents, which is both
// confusing and a small consent-violating UX bug. The ack lets us hold the
// initiator in a "waiting" state until the receiver explicitly accepts.
// Distinguished by the `{"_t":"j"` prefix.
type JoinFrame = { _t: 'j'; op: 'ack' | 'reject' }

const JOIN_FRAME_PREFIX = '{"_t":"j"'

const isJoinFrameString = (value: string): boolean =>
  value.startsWith(JOIN_FRAME_PREFIX)

const parseJoinFrame = (value: string): JoinFrame | null => {
  try {
    const parsed = JSON.parse(value) as { _t?: string; op?: string }
    if (
      parsed?._t === 'j' &&
      (parsed.op === 'ack' || parsed.op === 'reject')
    ) {
      return { _t: 'j', op: parsed.op }
    }
    return null
  } catch {
    return null
  }
}

// Roster frame: sent by an existing room member to a new joiner so the
// joiner can mesh with everyone else without manual /connect calls.
// Distinguished from file frames by the `{"_t":"r"` prefix.
type RosterFrame = { _t: 'r'; op: 'roster'; peers: string[] }

const ROSTER_FRAME_PREFIX = '{"_t":"r"'

const isRosterFrameString = (value: string): boolean =>
  value.startsWith(ROSTER_FRAME_PREFIX)

const parseRosterFrame = (value: string): RosterFrame | null => {
  try {
    const parsed = JSON.parse(value) as {
      _t?: string
      op?: string
      peers?: unknown
    }
    if (
      parsed?._t === 'r' &&
      parsed.op === 'roster' &&
      Array.isArray(parsed.peers)
    ) {
      return {
        _t: 'r',
        op: 'roster',
        peers: parsed.peers.filter((p): p is string => typeof p === 'string'),
      }
    }
    return null
  } catch {
    return null
  }
}

const formatPeerError = (err: unknown): string => {
  const type = (err as { type?: string }).type
  const message = err instanceof Error ? err.message : String(err)
  switch (type) {
    case 'peer-unavailable':
      return 'Peer is offline or unreachable.'
    case 'unavailable-id':
      return 'That peer ID is already taken. Try another.'
    case 'invalid-id':
      return 'Invalid peer ID format. Use letters, digits, space, _ or -.'
    case 'invalid-key':
      return 'Broker rejected the API key.'
    case 'browser-incompatible':
      return 'This browser does not support WebRTC.'
    case 'ssl-unavailable':
      return 'Secure connection to the broker failed.'
    case 'network':
    case 'disconnected':
    case 'socket-closed':
      return 'Lost connection to the broker. Will reconnect when online.'
    case 'server-error':
    case 'socket-error':
      return `Broker error: ${message}`
    case 'webrtc':
      return `WebRTC error: ${message}`
    default:
      return message
  }
}

const LAST_CONNECT_STORAGE_KEY = 'cli-chat:last-connect'

// Auto-resume only restores the most recent peer. Mesh restoration would
// need to persist the whole roster, plus it would require a per-peer
// confirmation flow on each cold start; not worth the complexity for now.
type LastConnect = { peerId: string; encrypted: boolean }

const persistLastConnect = (last: LastConnect): void => {
  try {
    sessionStorage.setItem(LAST_CONNECT_STORAGE_KEY, JSON.stringify(last))
  } catch {
    // ignore quota / privacy mode
  }
}

const clearStoredLastConnect = (): void => {
  try {
    sessionStorage.removeItem(LAST_CONNECT_STORAGE_KEY)
  } catch {
    // ignore
  }
}

const loadLastConnect = (): LastConnect | null => {
  try {
    const raw = sessionStorage.getItem(LAST_CONNECT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastConnect>
    if (typeof parsed.peerId !== 'string') return null
    return { peerId: parsed.peerId, encrypted: !!parsed.encrypted }
  } catch {
    return null
  }
}

export const usePeer = (
  onEvent: (event: PeerEvent) => void,
): PeerController => {
  const peerRef = useRef<Peer | null>(null)
  const connsRef = useRef<Map<string, DataConnection>>(new Map())
  const pendingRef = useRef<DataConnection | null>(null)
  // Outbound connections whose underlying DataChannel is open but whose
  // remote user hasn't yet accepted (or auto-accepted). Tracked separately
  // from connsRef so we don't broadcast chat to a peer that hasn't joined,
  // and so we can show a "waiting" message + handle a close-before-ack as
  // a rejection rather than a normal disconnect.
  const awaitingAckRef = useRef<Map<string, DataConnection>>(new Map())
  // Used by wireConnection to recurse into itself when wiring auto-introduced
  // outbound connections opened from a roster frame. Bound just after the
  // useCallback declaration below.
  const wireConnectionRef = useRef<((c: DataConnection) => void) | null>(null)
  // Forward reference to reconnectIfNeeded so peer.on('disconnected') (set
  // up inside login, declared earlier than reconnectIfNeeded) can trigger a
  // reconnect without a circular useCallback dep.
  const reconnectIfNeededRef = useRef<(() => void) | null>(null)
  // Guard against overlapping reconnect attempts (visibilitychange fires
  // alongside the disconnected handler in some edge cases).
  const reconnectingRef = useRef(false)
  // Track in-flight outbound peerIds so simultaneous /connect from both sides
  // doesn't end up with two parallel connections to the same peer.
  // Tracks outbound connections whose `peer.connect()` has been called but
  // whose 'open' (or 'error') has not fired yet. Keyed by peerId, valued by
  // the DataConnection so a /connect retry can forcibly close the in-flight
  // attempt and start fresh rather than hitting "Already connecting".
  const pendingOutboundRef = useRef<Map<string, DataConnection>>(new Map())
  // Holds the room's derived session key once a passphrase has been set.
  // PBKDF2 (~600k iterations) is run once when the key is established and
  // every encrypt/decrypt thereafter reuses it. Without this caching the
  // file-transfer path would PBKDF2 each chunk and stall for minutes.
  const keyRef = useRef<SessionKey | null>(null)
  const outgoingFileRef = useRef<OutgoingTransfer | null>(null)
  const incomingFileRef = useRef<IncomingTransfer | null>(null)
  const lastConnectRef = useRef<LastConnect | null>(loadLastConnect())
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  const emit = useCallback((event: PeerEvent) => {
    onEventRef.current(event)
  }, [])

  const sendRosterTo = useCallback((connection: DataConnection) => {
    const peers = Array.from(connsRef.current.keys()).filter(
      (p) => p !== connection.peer,
    )
    if (peers.length === 0) return
    try {
      connection.send(JSON.stringify({ _t: 'r', op: 'roster', peers }))
    } catch {
      // ignore — roster is best-effort
    }
  }, [])

  const handleChatMessage = useCallback(
    async (connection: DataConnection, payload: string) => {
      const session = keyRef.current
      try {
        const text = session
          ? await decryptWithSession(payload, session)
          : payload
        emit({
          type: 'message',
          sender: connection.peer,
          text,
          payload,
        })
      } catch {
        emit({
          type: 'system',
          text: `Failed to decrypt message from ${connection.peer}`,
        })
      }
    },
    [emit],
  )

  const finalizeIncoming = useCallback(
    (inc: IncomingTransfer) => {
      if (inc.status === 'ready') return
      inc.blob = new Blob(inc.receivedChunks, { type: inc.mime })
      inc.receivedChunks = []
      inc.status = 'ready'
      emit({ type: 'file_ready', name: inc.name, size: inc.size })
    },
    [emit],
  )

  const runOutgoingSend = useCallback(
    async (
      connection: DataConnection,
      out: OutgoingTransfer,
    ): Promise<void> => {
      const dc = connection.dataChannel
      if (!dc) {
        outgoingFileRef.current = null
        emit({
          type: 'file_canceled',
          reason: 'No data channel — transfer aborted.',
        })
        return
      }
      dc.bufferedAmountLowThreshold = Math.floor(BACKPRESSURE_THRESHOLD / 2)
      const total = out.file.size
      let offset = 0
      let lastEmitBytes = 0
      const stepBytes = Math.max(1, Math.floor(total / 20))
      try {
        while (offset < total) {
          if (outgoingFileRef.current !== out) return
          if (dc.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            await new Promise<void>((resolve) => {
              const handler = () => {
                dc.removeEventListener('bufferedamountlow', handler)
                resolve()
              }
              dc.addEventListener('bufferedamountlow', handler)
            })
            continue
          }
          const slice = out.file.slice(offset, offset + CHUNK_SIZE)
          const buf = await slice.arrayBuffer()
          if (outgoingFileRef.current !== out) return
          // The room key is derived once per session, so encrypting each
          // chunk only costs an AES-GCM call (microseconds). PBKDF2 is
          // amortized inside SessionKey and not run per chunk.
          const wireBuf = keyRef.current
            ? await encryptBufferWithSession(buf, keyRef.current)
            : buf
          if (outgoingFileRef.current !== out) return
          connection.send(wireBuf)
          // Count progress in source bytes (not wire bytes) so the bar
          // matches the file's actual size on the receiver too.
          offset += buf.byteLength
          if (offset - lastEmitBytes >= stepBytes || offset === total) {
            lastEmitBytes = offset
            emit({
              type: 'file_progress',
              direction: 'send',
              bytes: offset,
              total,
              name: out.file.name,
            })
          }
        }
        // Drain the dataChannel buffer before sending 'done' so PeerJS's
        // internal encoding queue can't let the small string overtake the
        // last binary chunks.
        while (dc.bufferedAmount > 0) {
          if (outgoingFileRef.current !== out) return
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
        connection.send(JSON.stringify({ _t: 'f', op: 'done', id: out.id }))
        outgoingFileRef.current = null
        emit({ type: 'file_sent', name: out.file.name })
      } catch (err) {
        outgoingFileRef.current = null
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [emit],
  )

  const handleFileFrame = useCallback(
    (connection: DataConnection, frame: FileFrame) => {
      switch (frame.op) {
        case 'init': {
          if (incomingFileRef.current) {
            try {
              connection.send(
                JSON.stringify({
                  _t: 'f',
                  op: 'reject',
                  id: frame.id,
                  reason: 'busy',
                }),
              )
            } catch {
              // ignore
            }
            return
          }
          incomingFileRef.current = {
            id: frame.id,
            peerId: connection.peer,
            name: frame.name,
            size: frame.size,
            mime: frame.mime,
            expectedChunks: frame.chunks,
            receivedChunks: [],
            receivedBytes: 0,
            doneReceived: false,
            status: 'pending',
            blob: null,
          }
          emit({
            type: 'file_incoming',
            from: connection.peer,
            name: frame.name,
            size: frame.size,
            mime: frame.mime,
          })
          return
        }
        case 'accept': {
          const out = outgoingFileRef.current
          if (!out || out.id !== frame.id || out.peerId !== connection.peer)
            return
          out.status = 'sending'
          void runOutgoingSend(connection, out)
          return
        }
        case 'reject': {
          const out = outgoingFileRef.current
          if (!out || out.id !== frame.id || out.peerId !== connection.peer)
            return
          outgoingFileRef.current = null
          emit({
            type: 'file_canceled',
            reason: frame.reason
              ? `Receiver declined: ${frame.reason}.`
              : 'Receiver declined the file.',
          })
          return
        }
        case 'done': {
          const inc = incomingFileRef.current
          if (!inc || inc.id !== frame.id || inc.peerId !== connection.peer)
            return
          if (inc.status === 'ready') return
          if (inc.status !== 'receiving') return
          inc.doneReceived = true
          if (inc.receivedBytes >= inc.size) {
            finalizeIncoming(inc)
            return
          }
          const id = frame.id
          setTimeout(() => {
            const cur = incomingFileRef.current
            if (!cur || cur.id !== id || cur.status !== 'receiving') return
            if (cur.receivedBytes >= cur.size) {
              finalizeIncoming(cur)
            } else {
              const pct = Math.round((cur.receivedBytes / cur.size) * 100)
              incomingFileRef.current = null
              emit({
                type: 'file_canceled',
                reason: `Transfer incomplete (got ${pct}%).`,
              })
            }
          }, 5000)
          return
        }
        case 'abort': {
          const inc = incomingFileRef.current
          if (inc && inc.id === frame.id && inc.peerId === connection.peer) {
            incomingFileRef.current = null
            emit({
              type: 'file_canceled',
              reason: frame.reason
                ? `Sender aborted: ${frame.reason}.`
                : 'Sender aborted the transfer.',
            })
          }
          const out = outgoingFileRef.current
          if (out && out.id === frame.id && out.peerId === connection.peer) {
            outgoingFileRef.current = null
            emit({
              type: 'file_canceled',
              reason: 'Receiver aborted the transfer.',
            })
          }
          return
        }
      }
    },
    [emit, finalizeIncoming, runOutgoingSend],
  )

  const handleIncomingChunk = useCallback(
    async (connection: DataConnection, chunk: ArrayBuffer) => {
      const inc = incomingFileRef.current
      if (!inc || inc.status !== 'receiving') return
      if (inc.peerId !== connection.peer) return
      // If we're in an encrypted room, the wire chunk is itself a
      // version|salt|iv|ciphertext blob — decrypt before counting bytes
      // so the progress bar tracks source bytes, not wire bytes.
      let plain: ArrayBuffer
      if (keyRef.current) {
        try {
          plain = await decryptBufferWithSession(chunk, keyRef.current)
        } catch {
          incomingFileRef.current = null
          emit({
            type: 'file_canceled',
            reason: 'Failed to decrypt file chunk; aborting.',
          })
          return
        }
      } else {
        plain = chunk
      }
      // The transfer may have been canceled while we were awaiting the
      // decrypt; re-check before mutating state.
      const cur = incomingFileRef.current
      if (!cur || cur !== inc || cur.status !== 'receiving') return
      cur.receivedChunks.push(plain)
      cur.receivedBytes = Math.min(
        cur.receivedBytes + plain.byteLength,
        cur.size,
      )
      const expectedMet =
        (cur.doneReceived && cur.receivedBytes >= cur.size) ||
        cur.receivedChunks.length >= cur.expectedChunks ||
        cur.receivedBytes >= cur.size
      const stepBytes = Math.max(1, Math.floor(cur.size / 20))
      if (expectedMet || cur.receivedBytes % stepBytes < plain.byteLength) {
        emit({
          type: 'file_progress',
          direction: 'recv',
          bytes: cur.receivedBytes,
          total: cur.size,
          name: cur.name,
        })
      }
      if (expectedMet) {
        finalizeIncoming(cur)
      }
    },
    [emit, finalizeIncoming],
  )

  const handlePeerLeft = useCallback(
    (peerId: string) => {
      // Cancel transfers tied to this peer.
      if (outgoingFileRef.current?.peerId === peerId) {
        const name = outgoingFileRef.current.file.name
        outgoingFileRef.current.status = 'aborted'
        outgoingFileRef.current = null
        emit({
          type: 'file_canceled',
          reason: `Transfer of ${name} aborted (${peerId} disconnected).`,
        })
      }
      if (incomingFileRef.current?.peerId === peerId) {
        const name = incomingFileRef.current.name
        incomingFileRef.current = null
        emit({
          type: 'file_canceled',
          reason: `Transfer of ${name} aborted (${peerId} disconnected).`,
        })
      }
      emit({ type: 'peer_left', peerId })
      // If the room is now empty, drop the cached key and the auto-resume
      // marker so we don't keep stale state around.
      if (connsRef.current.size === 0) {
        keyRef.current = null
      }
    },
    [emit],
  )

  // Promote a connection from "awaiting ack" to "joined": add it to connsRef,
  // persist auto-resume, emit peer_joined, and send the roster of existing
  // peers so the new joiner can extend the mesh.
  const finalizeJoin = useCallback(
    (connection: DataConnection, opts: { auto: boolean }) => {
      awaitingAckRef.current.delete(connection.peer)
      connsRef.current.set(connection.peer, connection)
      const encrypted = isEncryptedHandshake(connection)
      lastConnectRef.current = { peerId: connection.peer, encrypted }
      persistLastConnect({ peerId: connection.peer, encrypted })
      emit({
        type: 'peer_joined',
        peerId: connection.peer,
        // Pass the passphrase for the chat session's bookkeeping; the actual
        // encrypt/decrypt keys are kept inside the SessionKey on usePeer.
        key: encrypted ? (keyRef.current?.passphrase ?? null) : null,
        auto: opts.auto,
      })
      sendRosterTo(connection)
    },
    [emit, sendRosterTo],
  )

  const wireConnection = useCallback(
    (connection: DataConnection) => {
      connection.on('data', (data) => {
        if (data instanceof ArrayBuffer) {
          void handleIncomingChunk(connection, data)
          return
        }
        if (ArrayBuffer.isView(data)) {
          void handleIncomingChunk(connection, toArrayBuffer(data))
          return
        }
        if (typeof data === 'string') {
          if (isJoinFrameString(data)) {
            const frame = parseJoinFrame(data)
            if (!frame) return
            if (frame.op === 'ack') {
              if (awaitingAckRef.current.get(connection.peer) === connection) {
                // Receiver accepted: this is when the join becomes real for
                // the initiator. The auto flag mirrors what the receiver did
                // — if THEIR side auto-accepted (fromRoom), our outbound was
                // also a fromRoom auto-introduction.
                const auto = isFromRoomHandshake(connection)
                finalizeJoin(connection, { auto })
              }
              return
            }
            if (frame.op === 'reject') {
              // Receiver explicitly rejected. Drop and surface a clear
              // message rather than treating it as a generic disconnect.
              if (awaitingAckRef.current.get(connection.peer) === connection) {
                awaitingAckRef.current.delete(connection.peer)
                emit({
                  type: 'system',
                  text: `${connection.peer} rejected the connection.`,
                })
              }
              try {
                connection.close()
              } catch {
                // ignore
              }
              return
            }
            return
          }
          if (isFileFrameString(data)) {
            const frame = parseFileFrame(data)
            if (frame) handleFileFrame(connection, frame)
            return
          }
          if (isRosterFrameString(data)) {
            const frame = parseRosterFrame(data)
            if (!frame) return
            // Auto-introduce ourselves to peers we don't already know.
            // Inlined here (rather than in a separate handler) to keep the
            // useCallback dep graph acyclic — wireConnection only needs to
            // call itself recursively when wiring auto-introduced conns.
            const peer = peerRef.current
            if (!peer) return
            const myId = peer.id
            for (const targetId of frame.peers) {
              if (
                targetId === myId ||
                connsRef.current.has(targetId) ||
                awaitingAckRef.current.has(targetId) ||
                pendingOutboundRef.current.has(targetId)
              ) {
                continue
              }
              const encrypted = !!keyRef.current
              const meta: ConnectionMetadata = {
                v: 1,
                encrypted,
                fromRoom: true,
              }
              const newConn = peer.connect(targetId, { metadata: meta })
              pendingOutboundRef.current.set(targetId, newConn)
              // Same belt-and-braces timeout as startConnection — peer-level
              // 'peer-unavailable' won't reach this connection's error
              // listener, so we'd otherwise leak pendingOutbound entries
              // for offline rostered peers.
              const autoTimeoutId = setTimeout(() => {
                if (!pendingOutboundRef.current.has(targetId)) return
                if (newConn.open) return
                pendingOutboundRef.current.delete(targetId)
                try {
                  newConn.close()
                } catch {
                  // ignore
                }
              }, 15_000)
              newConn.on('open', () => {
                clearTimeout(autoTimeoutId)
                pendingOutboundRef.current.delete(targetId)
                // Self-reference through a ref so the eslint
                // exhaustive-deps / declaration-order rule is happy. The
                // ref is bound just below to the same function we're inside.
                wireConnectionRef.current?.(newConn)
                // Auto-introduced outbound also waits for an ack frame from
                // the (auto-accepting) other side before considering itself
                // joined; finalizeJoin runs from the join-frame handler.
                awaitingAckRef.current.set(targetId, newConn)
              })
              // Auto-introductions stay silent on failure: the user didn't
              // explicitly ask for them, so a stack of "Peer is offline"
              // lines on every roster reception would just be noise.
              newConn.on('error', () => {
                clearTimeout(autoTimeoutId)
                pendingOutboundRef.current.delete(targetId)
              })
            }
            return
          }
          void handleChatMessage(connection, data)
          return
        }
      })

      connection.on('close', () => {
        const tracked = connsRef.current.get(connection.peer)
        if (tracked === connection) {
          connsRef.current.delete(connection.peer)
          handlePeerLeft(connection.peer)
          return
        }
        // Closed while still awaiting ack — receiver disappeared or rejected
        // (without the courtesy reject frame). Surface a different message.
        if (awaitingAckRef.current.get(connection.peer) === connection) {
          awaitingAckRef.current.delete(connection.peer)
          emit({
            type: 'system',
            text: `Connection to ${connection.peer} closed before being accepted.`,
          })
        }
      })

      connection.on('error', (err) => {
        emit({ type: 'error', message: formatPeerError(err) })
      })
    },
    [
      emit,
      finalizeJoin,
      handleChatMessage,
      handleFileFrame,
      handleIncomingChunk,
      handlePeerLeft,
    ],
  )

  // Forward-bind the ref so wireConnection's body can recurse on itself
  // when a roster frame triggers auto-introductions. Storing a useCallback
  // in a ref like this is the standard workaround for a fwd-ref cycle.
  useEffect(() => {
    wireConnectionRef.current = wireConnection
  }, [wireConnection])

  const startConnection = useCallback(
    (peerId: string, key: string | null) => {
      const peer = peerRef.current
      if (!peer) return
      // /connect is the user telling us "(re)connect to this peer." Trust
      // them: forcibly drop any prior entry for this peerId before opening
      // a fresh outbound. Distinguishing "really alive" from "looks alive
      // but is silently dead" is unreliable across browsers/network
      // changes, and any check we add will eventually false-positive and
      // wrongly emit "Already connected" to a user who genuinely needs to
      // retry. Better to always honor the explicit /connect.
      const existing = connsRef.current.get(peerId)
      if (existing) {
        try {
          existing.close()
        } catch {
          // ignore
        }
        connsRef.current.delete(peerId)
        handlePeerLeft(peerId)
      }
      const awaiting = awaitingAckRef.current.get(peerId)
      if (awaiting) {
        try {
          awaiting.close()
        } catch {
          // ignore
        }
        awaitingAckRef.current.delete(peerId)
      }
      const inFlight = pendingOutboundRef.current.get(peerId)
      if (inFlight) {
        try {
          inFlight.close()
        } catch {
          // ignore
        }
        pendingOutboundRef.current.delete(peerId)
      }
      // Reuse the room key if one is already established. This keeps the
      // group-chat case simple: one shared passphrase.
      const effectivePassphrase: string | null =
        keyRef.current?.passphrase ?? key ?? null
      const metadata: ConnectionMetadata = {
        v: 1,
        encrypted: !!effectivePassphrase,
      }
      const connection = peer.connect(peerId, { metadata })
      pendingOutboundRef.current.set(peerId, connection)

      // Belt-and-braces timeout. PeerJS routes the most common failure
      // ('peer-unavailable' — the destination isn't online) through
      // peer.on('error'), NOT connection.on('error'), so the latter never
      // fires. Without this timeout, a /connect to an offline peer would
      // leave pendingOutboundRef populated forever and every retry would
      // print "Already connecting to <id>". 15s comfortably outlives the
      // broker's own peer-lookup timeout.
      const timeoutId = setTimeout(() => {
        if (!pendingOutboundRef.current.has(peerId)) return
        if (connection.open) return
        pendingOutboundRef.current.delete(peerId)
        try {
          connection.close()
        } catch {
          // ignore
        }
        emit({
          type: 'system',
          text: `Connection to ${peerId} timed out.`,
        })
      }, 15_000)

      connection.on('open', async () => {
        clearTimeout(timeoutId)
        pendingOutboundRef.current.delete(peerId)
        if (effectivePassphrase && !keyRef.current) {
          // First encrypted connection in this session: derive the room
          // key once. PBKDF2 takes ~1s on a phone, so warn the user.
          emit({ type: 'system', text: 'Deriving room key (this may take a moment)...' })
          try {
            keyRef.current = await createSessionKey(effectivePassphrase)
          } catch (err) {
            emit({
              type: 'error',
              message: err instanceof Error ? err.message : String(err),
            })
            try {
              connection.close()
            } catch {
              // ignore
            }
            return
          }
        }
        wireConnection(connection)
        // Wait for the receiver's join-ack frame (sent from accept() or the
        // fromRoom auto-accept path) before treating this as a real join.
        awaitingAckRef.current.set(peerId, connection)
        emit({
          type: 'system',
          text: `Waiting for ${peerId} to accept...`,
        })
      })
      connection.on('error', (err) => {
        clearTimeout(timeoutId)
        pendingOutboundRef.current.delete(peerId)
        emit({ type: 'error', message: formatPeerError(err) })
      })
    },
    [emit, handlePeerLeft, wireConnection],
  )

  const login = useCallback(
    (id: string) => {
      if (peerRef.current) return
      const peer = new Peer(id)
      peerRef.current = peer

      peer.on('open', (openId) => {
        emit({ type: 'login', peerId: openId })
        const last = lastConnectRef.current
        if (!last || connsRef.current.size > 0) return
        if (last.encrypted) {
          emit({
            type: 'system',
            text: `Previous session with ${last.peerId} was encrypted; type "/connect ${last.peerId} <key>" to resume.`,
          })
          return
        }
        emit({
          type: 'system',
          text: `Resuming connection to ${last.peerId}...`,
        })
        startConnection(last.peerId, null)
      })

      peer.on('connection', (connection) => {
        connection.on('open', () => {
          // Drop duplicate inbound when we already have (or are opening) a
          // connection to this peer — cheaper than a glare-resolution dance.
          if (
            connsRef.current.has(connection.peer) ||
            pendingOutboundRef.current.has(connection.peer)
          ) {
            connection.close()
            return
          }

          const wantsEncryption = isEncryptedHandshake(connection)
          const fromRoom = isFromRoomHandshake(connection)
          const haveKey = !!keyRef.current

          // Auto-accept room-introduced connections: trust that an existing
          // peer (whose roster we already accepted) brought this one in.
          // Only valid when our encryption mode matches the incoming one,
          // and we're already in a room (otherwise fromRoom is meaningless).
          if (
            fromRoom &&
            connsRef.current.size > 0 &&
            wantsEncryption === haveKey
          ) {
            wireConnection(connection)
            // Mark joined locally first, THEN ack the initiator. The order
            // matters because finalizeJoin sends the roster on the same
            // connection, and we want the ack to arrive before the roster
            // (so the initiator finishes joining before processing roster).
            try {
              connection.send(JSON.stringify({ _t: 'j', op: 'ack' }))
            } catch {
              // ignore
            }
            finalizeJoin(connection, { auto: true })
            return
          }

          if (pendingRef.current) {
            // Already prompting for a different incoming request; reject
            // this one so the receiver isn't left guessing.
            connection.close()
            return
          }
          pendingRef.current = connection
          emit({
            type: 'incoming',
            peerId: connection.peer,
            encrypted: wantsEncryption,
          })
        })
      })

      peer.on('disconnected', () => {
        emit({
          type: 'system',
          text: 'Disconnected from broker. Reconnecting...',
        })
        // The visibilitychange path can race ahead of this event (it
        // sometimes fires while peer.disconnected is still false, then
        // returns early), so kick off the reconnect from here too. Small
        // delay lets the network settle on a wake-from-sleep transition.
        if (
          typeof document === 'undefined' ||
          document.visibilityState === 'visible'
        ) {
          setTimeout(() => {
            reconnectIfNeededRef.current?.()
          }, 500)
        }
      })

      peer.on('error', (err) => {
        // peer-unavailable's message embeds the failed peerId. Parse it so
        // we can immediately clear the corresponding pendingOutbound entry,
        // rather than waiting for the 15s timeout in startConnection.
        const errType = (err as { type?: string }).type
        if (errType === 'peer-unavailable') {
          const message = err instanceof Error ? err.message : String(err)
          const match = /Could not connect to peer (\S+)/.exec(message)
          if (match) {
            pendingOutboundRef.current.delete(match[1])
          }
        }
        emit({ type: 'error', message: formatPeerError(err) })
      })
    },
    [emit, finalizeJoin, startConnection, wireConnection],
  )

  const reconnectIfNeeded = useCallback(() => {
    // Prune any DataConnections whose ICE transport died while we were
    // suspended. Without this, after a sleep/wake cycle the local connsRef
    // can still hold a peer whose link is actually dead, which both blocks
    // the auto-resume path (`connsRef.size > 0` short-circuits it) and
    // makes manual /connect retries trip on a stale entry.
    for (const [peerId, conn] of connsRef.current) {
      if (isConnLikelyAlive(conn)) continue
      try {
        conn.close()
      } catch {
        // ignore
      }
      connsRef.current.delete(peerId)
      handlePeerLeft(peerId)
    }
    for (const [peerId, conn] of awaitingAckRef.current) {
      if (isConnLikelyAlive(conn)) continue
      try {
        conn.close()
      } catch {
        // ignore
      }
      awaitingAckRef.current.delete(peerId)
    }

    const peer = peerRef.current
    if (!peer || peer.destroyed || !peer.disconnected) return
    if (reconnectingRef.current) return
    reconnectingRef.current = true
    let openFired = false
    const onOpen = () => {
      openFired = true
      reconnectingRef.current = false
    }
    try {
      peer.on('open', onOpen)
    } catch {
      // ignore — the listener is best-effort
    }
    try {
      peer.reconnect()
    } catch {
      // fall through to the failsafe below
    }
    // PeerJS' public broker reaps disconnected sessions after a short
    // idle window. After a phone sleep that's longer than that window,
    // peer.reconnect() restores the WebSocket but the broker no longer
    // knows our peerId — every subsequent peer.connect() then fails with
    // "peer-unavailable" no matter who the target is. Detect this by
    // waiting for the broker's OPEN message; if it doesn't arrive we
    // destroy the Peer and re-register from scratch with the same id.
    setTimeout(() => {
      if (openFired) return
      reconnectingRef.current = false
      if (peerRef.current !== peer) return
      try {
        peer.off('open', onOpen)
      } catch {
        // ignore
      }
      const id = peer.id
      try {
        peer.destroy()
      } catch {
        // ignore
      }
      peerRef.current = null
      if (id) {
        emit({
          type: 'system',
          text: 'Broker session expired; re-registering...',
        })
        login(id)
      }
    }, 5_000)
  }, [emit, handlePeerLeft, login])

  // Forward-bind so peer.on('disconnected') (set up in login, declared
  // earlier) can call reconnectIfNeeded without a circular dep.
  useEffect(() => {
    reconnectIfNeededRef.current = reconnectIfNeeded
  }, [reconnectIfNeeded])

  const closeAllConnections = useCallback(() => {
    for (const conn of connsRef.current.values()) {
      try {
        conn.close()
      } catch {
        // ignore
      }
    }
    for (const conn of awaitingAckRef.current.values()) {
      try {
        conn.close()
      } catch {
        // ignore
      }
    }
    connsRef.current.clear()
    awaitingAckRef.current.clear()
    pendingOutboundRef.current.clear()
  }, [])

  const logout = useCallback(() => {
    pendingRef.current?.close()
    pendingRef.current = null
    closeAllConnections()
    keyRef.current = null
    if (outgoingFileRef.current) outgoingFileRef.current.status = 'aborted'
    outgoingFileRef.current = null
    incomingFileRef.current = null
    lastConnectRef.current = null
    clearStoredLastConnect()
    peerRef.current?.destroy()
    peerRef.current = null
    emit({ type: 'logout' })
  }, [closeAllConnections, emit])

  const connectTo = useCallback(
    (peerId: string, key?: string) => {
      startConnection(peerId, key ?? null)
    },
    [startConnection],
  )

  const accept = useCallback(
    async (key?: string) => {
      const connection = pendingRef.current
      if (!connection) return
      pendingRef.current = null
      const encrypted = isEncryptedHandshake(connection)
      // If the room already has a key, ignore whatever the user typed and
      // use the existing one. Otherwise the user-typed key bootstraps it.
      const passphrase = encrypted
        ? (keyRef.current?.passphrase ?? key ?? null)
        : null
      if (encrypted && passphrase && !keyRef.current) {
        emit({
          type: 'system',
          text: 'Deriving room key (this may take a moment)...',
        })
        try {
          keyRef.current = await createSessionKey(passphrase)
        } catch (err) {
          emit({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
          try {
            connection.close()
          } catch {
            // ignore
          }
          return
        }
      }
      wireConnection(connection)
      // Tell the initiator we accepted, then promote locally + send roster.
      try {
        connection.send(JSON.stringify({ _t: 'j', op: 'ack' }))
      } catch {
        // ignore
      }
      finalizeJoin(connection, { auto: false })
    },
    [emit, finalizeJoin, wireConnection],
  )

  const reject = useCallback(() => {
    const connection = pendingRef.current
    pendingRef.current = null
    if (!connection) return
    // Send a courtesy reject frame so the initiator can show a specific
    // "rejected" message rather than a generic "closed before accepted".
    try {
      connection.send(JSON.stringify({ _t: 'j', op: 'reject' }))
    } catch {
      // ignore
    }
    connection.close()
    emit({ type: 'incoming_canceled' })
    emit({
      type: 'system',
      text: `Connection from ${connection.peer} rejected.`,
    })
  }, [emit])

  const disconnect = useCallback(
    (peerId?: string) => {
      if (peerId) {
        const conn =
          connsRef.current.get(peerId) ?? awaitingAckRef.current.get(peerId)
        if (!conn) {
          emit({ type: 'system', text: `Not connected to ${peerId}.` })
          return
        }
        conn.close()
        return
      }
      // No arg: drop everyone and forget the auto-resume marker.
      lastConnectRef.current = null
      clearStoredLastConnect()
      closeAllConnections()
    },
    [closeAllConnections, emit],
  )

  const listPeers = useCallback(
    (): ReadonlyArray<string> => Array.from(connsRef.current.keys()),
    [],
  )

  const ping = useCallback(
    async (peerId?: string): Promise<PingResult | null> => {
      const conn = peerId
        ? connsRef.current.get(peerId)
        : connsRef.current.values().next().value
      if (!conn || !conn.open) return null
      const pc = conn.peerConnection
      if (!pc || typeof pc.getStats !== 'function') return null
      try {
        const stats = await pc.getStats()
        let rttSeconds: number | null = null
        stats.forEach((stat) => {
          if (
            stat.type === 'candidate-pair' &&
            (stat as { state?: string }).state === 'succeeded'
          ) {
            const rtt = (stat as { currentRoundTripTime?: number })
              .currentRoundTripTime
            if (typeof rtt === 'number') rttSeconds = rtt
          }
        })
        if (rttSeconds === null) return null
        return { rttMs: Math.round(rttSeconds * 1000) }
      } catch {
        return null
      }
    },
    [],
  )

  const sendFile = useCallback(
    async (file: File, peerId?: string): Promise<void> => {
      const peers = Array.from(connsRef.current.keys())
      if (peers.length === 0) {
        emit({ type: 'system', text: 'Not connected.' })
        return
      }
      const targetId = peerId ?? (peers.length === 1 ? peers[0] : null)
      if (!targetId) {
        emit({
          type: 'system',
          text: `Multiple peers connected. Specify one: /send <peerId>. Connected: ${peers.join(', ')}`,
        })
        return
      }
      const conn = connsRef.current.get(targetId)
      if (!conn || !conn.open) {
        emit({ type: 'system', text: `Not connected to ${targetId}.` })
        return
      }
      if (outgoingFileRef.current || incomingFileRef.current) {
        emit({
          type: 'system',
          text: 'A file transfer is already in progress.',
        })
        return
      }
      const id = newTransferId()
      const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
      outgoingFileRef.current = {
        id,
        file,
        peerId: targetId,
        status: 'awaiting-accept',
      }
      try {
        conn.send(
          JSON.stringify({
            _t: 'f',
            op: 'init',
            id,
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            chunks,
          }),
        )
        emit({
          type: 'system',
          text: `Offering ${file.name} to ${targetId} (waiting for /accept)...`,
        })
      } catch (err) {
        outgoingFileRef.current = null
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [emit],
  )

  const acceptIncomingFile = useCallback(() => {
    const inc = incomingFileRef.current
    if (!inc || inc.status !== 'pending') return
    const conn = connsRef.current.get(inc.peerId)
    if (!conn || !conn.open) {
      incomingFileRef.current = null
      emit({ type: 'system', text: `Sender ${inc.peerId} disconnected.` })
      return
    }
    inc.status = 'receiving'
    try {
      conn.send(JSON.stringify({ _t: 'f', op: 'accept', id: inc.id }))
      emit({ type: 'system', text: `Receiving ${inc.name}...` })
    } catch (err) {
      incomingFileRef.current = null
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [emit])

  const saveReceivedFile = useCallback(async () => {
    const inc = incomingFileRef.current
    if (!inc || inc.status !== 'ready' || !inc.blob) {
      emit({ type: 'system', text: 'Nothing to save.' })
      return
    }
    try {
      await deliverBlob(inc.blob, inc.name)
      emit({ type: 'system', text: `Saved ${inc.name}.` })
      incomingFileRef.current = null
    } catch (err) {
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [emit])

  const cancelTransfer = useCallback(() => {
    const out = outgoingFileRef.current
    const inc = incomingFileRef.current
    if (!out && !inc) {
      emit({ type: 'system', text: 'No transfer to cancel.' })
      return
    }
    if (out) {
      const conn = connsRef.current.get(out.peerId)
      const id = out.id
      out.status = 'aborted'
      outgoingFileRef.current = null
      try {
        conn?.send(
          JSON.stringify({ _t: 'f', op: 'abort', id, reason: 'sender' }),
        )
      } catch {
        // ignore
      }
      emit({ type: 'file_canceled', reason: 'You canceled the send.' })
    }
    if (inc) {
      const conn = connsRef.current.get(inc.peerId)
      const id = inc.id
      const status = inc.status
      incomingFileRef.current = null
      if (status !== 'ready') {
        try {
          conn?.send(
            JSON.stringify({
              _t: 'f',
              op: status === 'pending' ? 'reject' : 'abort',
              id,
              reason: 'receiver',
            }),
          )
        } catch {
          // ignore
        }
      }
      emit({
        type: 'file_canceled',
        reason:
          status === 'ready'
            ? 'Discarded received file.'
            : 'You canceled the transfer.',
      })
    }
  }, [emit])

  const send = useCallback(
    async (text: string) => {
      const peers = Array.from(connsRef.current.values()).filter((c) => c.open)
      if (peers.length === 0) return
      const session = keyRef.current
      const payload = session ? await encryptWithSession(text, session) : text
      let anySent = false
      for (const conn of peers) {
        try {
          conn.send(payload)
          anySent = true
        } catch (err) {
          emit({
            type: 'error',
            message: `Send to ${conn.peer} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        }
      }
      if (anySent) {
        emit({ type: 'sent', sender: peerRef.current?.id ?? '', payload })
      }
    },
    [emit],
  )

  // Wake on visibility / network return.
  useEffect(() => {
    const handler = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      reconnectIfNeeded()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handler)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handler)
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handler)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handler)
      }
    }
  }, [reconnectIfNeeded])

  useEffect(() => {
    // Snapshot refs so the linter is happy; the underlying objects don't
    // change identity for the lifetime of the hook.
    const conns = connsRef.current
    const awaiting = awaitingAckRef.current
    const pendingOutbound = pendingOutboundRef.current
    return () => {
      pendingRef.current?.close()
      pendingRef.current = null
      for (const conn of conns.values()) {
        try {
          conn.close()
        } catch {
          // ignore
        }
      }
      for (const conn of awaiting.values()) {
        try {
          conn.close()
        } catch {
          // ignore
        }
      }
      conns.clear()
      awaiting.clear()
      pendingOutbound.clear()
      keyRef.current = null
      if (outgoingFileRef.current) outgoingFileRef.current.status = 'aborted'
      outgoingFileRef.current = null
      incomingFileRef.current = null
      peerRef.current?.destroy()
      peerRef.current = null
    }
  }, [])

  return {
    login,
    logout,
    connectTo,
    accept,
    reject,
    disconnect,
    listPeers,
    send,
    ping,
    sendFile,
    acceptIncomingFile,
    saveReceivedFile,
    cancelTransfer,
  }
}
