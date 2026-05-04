import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { CLI_CHAT, CLI_CHAT_AA } from '../consts'
import {
  initialState,
  sessionReducer,
  type SessionState,
  type TerminalLine,
} from '../state/session'
import { useChatLog } from './useChatLog'
import { usePeer, type PeerEvent } from './usePeer'
import { runCommand } from '../commands'
import { buildProgressBar, formatBytes } from '../lib/fileTransfer'

export type ChatSession = {
  state: SessionState
  isProcessing: boolean
  handleSubmit(input: string): Promise<void>
}

export const useChatSession = (): ChatSession => {
  const [state, dispatch] = useReducer(sessionReducer, initialState)
  const [isProcessing, setIsProcessing] = useState(false)
  const chatLog = useChatLog()
  const stateRef = useRef<SessionState>(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const print = useCallback((sender: string, text: string) => {
    dispatch({ type: 'append', line: { sender, text } })
  }, [])

  const appendLine = useCallback((line: TerminalLine) => {
    dispatch({ type: 'append', line })
  }, [])

  const handlePeerEvent = useCallback(
    (event: PeerEvent) => {
      switch (event.type) {
        case 'login':
          dispatch({ type: 'logged_in', peerId: event.peerId })
          print(CLI_CHAT, `Your ID has been set to ${event.peerId}`)
          setIsProcessing(false)
          break
        case 'incoming':
          dispatch({
            type: 'incoming_request',
            peerId: event.peerId,
            encrypted: event.encrypted,
          })
          print(
            CLI_CHAT,
            event.encrypted
              ? `${event.peerId} wants to encrypt connect. Do you accept? (y <key>/n)`
              : `${event.peerId} wants to connect. Do you accept? (y/n)`,
          )
          break
        case 'peer_joined':
          dispatch({
            type: 'peer_joined',
            peerId: event.peerId,
            key: event.key,
          })
          // Distinguish manual joins (someone you /accept'd or /connect'd)
          // from auto-introductions (mesh extension via roster). Without
          // this, the prompt-less appearance of new peers feels like a bug.
          print(
            CLI_CHAT,
            event.auto
              ? `${event.peerId} joined (auto-introduced via the room).`
              : `${event.peerId} joined.`,
          )
          break
        case 'peer_left':
          dispatch({ type: 'peer_left', peerId: event.peerId })
          print(CLI_CHAT, `${event.peerId} left.`)
          break
        case 'incoming_canceled':
          dispatch({ type: 'incoming_canceled' })
          break
        case 'logout':
          dispatch({ type: 'logged_out' })
          print(CLI_CHAT, 'Logged out.')
          setIsProcessing(false)
          break
        case 'message':
          appendLine({ sender: event.sender, text: event.text })
          chatLog.append(event.sender, event.payload)
          break
        case 'sent':
          chatLog.append(event.sender, event.payload)
          break
        case 'system':
          print(CLI_CHAT, event.text)
          break
        case 'error':
          print(CLI_CHAT, event.message)
          setIsProcessing(false)
          break
        case 'file_incoming':
          print(
            CLI_CHAT,
            `Incoming file from ${event.from}: ${event.name} (${formatBytes(
              event.size,
            )}). Type /accept to receive or /cancel to decline.`,
          )
          break
        case 'file_progress':
          print(
            CLI_CHAT,
            `${event.direction === 'send' ? 'sending' : 'receiving'} ${
              event.name
            } ${buildProgressBar(event.bytes, event.total)}`,
          )
          break
        case 'file_ready':
          print(
            CLI_CHAT,
            `${event.name} (${formatBytes(
              event.size,
            )}) ready. Type /save to save it.`,
          )
          break
        case 'file_sent':
          print(CLI_CHAT, `Sent ${event.name}.`)
          break
        case 'file_canceled':
          print(CLI_CHAT, event.reason)
          break
      }
    },
    [appendLine, chatLog, print],
  )

  const peer = usePeer(handlePeerEvent)

  useEffect(() => {
    dispatch({
      type: 'reset_messages',
      lines: [{ sender: '', text: CLI_CHAT_AA }],
    })
    print(
      CLI_CHAT,
      'Welcome to CLI-CHAT. Type /help to see the list of commands.',
    )
    if (navigator.onLine) dispatch({ type: 'set_online' })
  }, [print])

  const handleSubmit = useCallback(
    async (input: string) => {
      const promptId = stateRef.current.peerId || stateRef.current.status
      print(promptId, input)
      try {
        await runCommand(input, {
          peer,
          chatLog,
          state: stateRef.current,
          print,
        })
      } catch (err) {
        print(CLI_CHAT, err instanceof Error ? err.message : String(err))
      }
    },
    [chatLog, peer, print],
  )

  return { state, isProcessing, handleSubmit }
}
