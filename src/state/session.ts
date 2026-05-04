export type Status =
  | 'offline'
  | 'online'
  | 'logged_in'
  | 'connecting'
  | 'connected'

export type TerminalLine = { sender: string; text: string }

export type SessionState = {
  status: Status
  peerId: string
  pendingPeerId: string | null
  pendingEncrypted: boolean
  peers: ReadonlyArray<string>
  encryptionKey: string | null
  messages: ReadonlyArray<TerminalLine>
}

export type SessionAction =
  | { type: 'set_online' }
  | { type: 'logged_in'; peerId: string }
  | { type: 'incoming_request'; peerId: string; encrypted: boolean }
  | { type: 'incoming_canceled' }
  | { type: 'peer_joined'; peerId: string; key: string | null }
  | { type: 'peer_left'; peerId: string }
  | { type: 'logged_out' }
  | { type: 'append'; line: TerminalLine }
  | { type: 'reset_messages'; lines: ReadonlyArray<TerminalLine> }

export const initialState: SessionState = {
  status: 'offline',
  peerId: '',
  pendingPeerId: null,
  pendingEncrypted: false,
  peers: [],
  encryptionKey: null,
  messages: [],
}

const baseStatus = (peerId: string, peerCount: number): Status =>
  peerCount > 0 ? 'connected' : peerId ? 'logged_in' : 'online'

export const sessionReducer = (
  state: SessionState,
  action: SessionAction,
): SessionState => {
  switch (action.type) {
    case 'set_online':
      return state.status === 'offline' ? { ...state, status: 'online' } : state

    case 'logged_in':
      return { ...state, status: 'logged_in', peerId: action.peerId }

    case 'incoming_request':
      // Always go to 'connecting' so y/n must be resolved before any other
      // command is accepted, even if peers are already connected.
      return {
        ...state,
        status: 'connecting',
        pendingPeerId: action.peerId,
        pendingEncrypted: action.encrypted,
      }

    case 'incoming_canceled':
      return {
        ...state,
        status: baseStatus(state.peerId, state.peers.length),
        pendingPeerId: null,
        pendingEncrypted: false,
      }

    case 'peer_joined': {
      const peers = state.peers.includes(action.peerId)
        ? state.peers
        : [...state.peers, action.peerId]
      const resolvedPending = state.pendingPeerId === action.peerId
      return {
        ...state,
        status: 'connected',
        peers,
        // First encrypted peer establishes the room key; later joiners reuse it.
        encryptionKey: state.encryptionKey ?? action.key,
        pendingPeerId: resolvedPending ? null : state.pendingPeerId,
        pendingEncrypted: resolvedPending ? false : state.pendingEncrypted,
      }
    }

    case 'peer_left': {
      const peers = state.peers.filter((p) => p !== action.peerId)
      const status: Status = state.pendingPeerId
        ? 'connecting'
        : baseStatus(state.peerId, peers.length)
      return {
        ...state,
        peers,
        status,
        // Drop the room key only when the room is empty.
        encryptionKey: peers.length === 0 ? null : state.encryptionKey,
      }
    }

    case 'logged_out':
      return {
        ...state,
        status: 'online',
        peerId: '',
        pendingPeerId: null,
        pendingEncrypted: false,
        peers: [],
        encryptionKey: null,
      }

    case 'append':
      return { ...state, messages: [...state.messages, action.line] }

    case 'reset_messages':
      return { ...state, messages: action.lines }
  }
}
