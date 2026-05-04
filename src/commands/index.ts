import type { ChatLog } from '../hooks/useChatLog'
import type { PeerController } from '../hooks/usePeer'
import type { SessionState, Status } from '../state/session'
import { CLI_CHAT } from '../consts'
import { createSessionKey, decryptWithSession } from '../lib/crypto'
import { pickFile } from '../lib/fileTransfer'

export type CommandContext = {
  peer: PeerController
  chatLog: ChatLog
  state: SessionState
  print(sender: string, text: string): void
}

export type CommandHandler = (
  ctx: CommandContext,
  args: string[],
) => void | Promise<void>

export type Command = {
  name: string
  allowedIn: ReadonlyArray<Status> | '*'
  usage: string
  description: string
  handler: CommandHandler
}

const isAllowed = (cmd: Command, status: Status): boolean =>
  cmd.allowedIn === '*' || cmd.allowedIn.includes(status)

// Mirror of PeerJS' own peer ID rule: alphanumeric runs separated by space,
// underscore or hyphen. We validate at the entry point so we can show a
// terminal-friendly hint instead of waiting for the broker's 'invalid-id'.
const PEER_ID_REGEX = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/

const commands: ReadonlyArray<Command> = [
  {
    name: 'login',
    allowedIn: ['online'],
    usage: '/login <id>',
    description: 'Set your peer ID and initialize PeerJS.',
    handler: ({ peer, print }, args) => {
      const id = args[0] ?? ''
      if (!id) {
        print(CLI_CHAT, 'Usage: /login <id>')
        return
      }
      if (!PEER_ID_REGEX.test(id)) {
        print(
          CLI_CHAT,
          'Invalid peer ID. Use letters, digits, _ or - (no other symbols).',
        )
        return
      }
      peer.login(id)
    },
  },
  {
    name: 'connect',
    // Allowed while connected too — that's how you bring a 3rd peer into the
    // group chat.
    allowedIn: ['logged_in', 'connected'],
    usage: '/connect <id> [<key>]',
    description:
      'Connect to a peer (or invite another peer into the group). Optional <key> enables AES-GCM encryption; ignored if a key is already set for this room.',
    handler: ({ peer, print }, args) => {
      const id = args[0]
      const key = args[1]
      if (!id) {
        print(CLI_CHAT, 'Need a destination ID.')
        return
      }
      if (!PEER_ID_REGEX.test(id)) {
        print(
          CLI_CHAT,
          'Invalid peer ID. Use letters, digits, _ or - (no other symbols).',
        )
        return
      }
      peer.connectTo(id, key)
    },
  },
  {
    name: 'disconnect',
    allowedIn: ['connected'],
    usage: '/disconnect [<id>]',
    description:
      'Close one peer connection, or all if no id given.',
    handler: ({ peer }, args) => {
      peer.disconnect(args[0])
    },
  },
  {
    name: 'who',
    allowedIn: ['connected'],
    usage: '/who',
    description: 'List currently connected peers.',
    handler: ({ peer, print }) => {
      const peers = peer.listPeers()
      if (peers.length === 0) {
        print(CLI_CHAT, 'No peers connected.')
        return
      }
      print(CLI_CHAT, `Connected peers: ${peers.join(', ')}`)
    },
  },
  {
    name: 'ping',
    allowedIn: ['connected'],
    usage: '/ping [<id>]',
    description:
      'Show round-trip time. With multiple peers, give an id to target one.',
    handler: async ({ peer, print }, args) => {
      const target = args[0]
      const result = await peer.ping(target)
      if (!result) {
        print(CLI_CHAT, 'No RTT data yet (try again after a few seconds).')
        return
      }
      print(
        CLI_CHAT,
        target ? `rtt(${target})=${result.rttMs}ms` : `rtt=${result.rttMs}ms`,
      )
    },
  },
  {
    name: 'send',
    allowedIn: ['connected'],
    usage: '/send [<id>]',
    description:
      'Pick a file and send it. If multiple peers are connected, give an id to pick the target.',
    handler: async ({ peer, print }, args) => {
      const target = args[0]
      // pickFile must run synchronously off the keypress to keep the user
      // gesture; the click() inside is what counts. Browsers tolerate the
      // microtask boundary here.
      const file = await pickFile()
      if (!file) {
        print(CLI_CHAT, 'No file selected.')
        return
      }
      await peer.sendFile(file, target)
    },
  },
  {
    name: 'accept',
    allowedIn: ['connected'],
    usage: '/accept',
    description: 'Accept an incoming file transfer.',
    handler: ({ peer }) => peer.acceptIncomingFile(),
  },
  {
    name: 'save',
    allowedIn: ['connected'],
    usage: '/save',
    description: 'Save the most recently received file to your device.',
    handler: ({ peer }) => peer.saveReceivedFile(),
  },
  {
    name: 'cancel',
    allowedIn: ['connected'],
    usage: '/cancel',
    description: 'Cancel the current file transfer (in either direction).',
    handler: ({ peer }) => peer.cancelTransfer(),
  },
  {
    name: 'logout',
    allowedIn: ['logged_in', 'connected'],
    usage: '/logout',
    description: 'Log out and return to the online status.',
    handler: ({ peer }) => peer.logout(),
  },
  {
    name: 'help',
    allowedIn: '*',
    usage: '/help',
    description: 'Show this help message.',
    handler: ({ print }) => print(CLI_CHAT, buildHelpText()),
  },
  {
    name: 'log',
    allowedIn: '*',
    usage: '/log <date> [<key>]',
    description:
      'Show log for the date (YYYY-MM-DD). Optional <key> decrypts AES-GCM payloads.',
    handler: async ({ chatLog, print }, args) => {
      const dateKey = args[0]
      const key = args[1]
      if (!dateKey) {
        print(
          CLI_CHAT,
          'Usage: /log <date> [<key>]  e.g. /log 2026-04-28 hunter2',
        )
        return
      }
      const raw = chatLog.read(dateKey)
      if (!raw) {
        print(CLI_CHAT, 'No logs found for the specified date.')
        return
      }
      const lines = raw.split('\n').filter(Boolean)
      // Build a SessionKey once for the whole log replay. Different chat
      // sessions in the log will have different salts, but each one is
      // PBKDF2'd at most once thanks to inboundCache.
      const session = key ? await createSessionKey(key) : null
      for (const line of lines) {
        const sep = line.indexOf('> ')
        if (sep < 0) {
          print(CLI_CHAT, line)
          continue
        }
        const sender = line.slice(0, sep)
        const payload = line.slice(sep + 2)
        if (!session) {
          print(sender, payload)
          continue
        }
        try {
          const text = await decryptWithSession(payload, session)
          print(sender, text)
        } catch {
          print(CLI_CHAT, `Failed to decrypt message: ${payload}`)
        }
      }
    },
  },
  {
    name: 'loglist',
    allowedIn: '*',
    usage: '/loglist',
    description: 'List all available log dates.',
    handler: ({ chatLog, print }) => {
      const keys = chatLog.list()
      if (keys.length === 0) {
        print(CLI_CHAT, 'No logs found.')
        return
      }
      for (const key of keys) print(CLI_CHAT, key)
    },
  },
  {
    name: 'logdelete',
    allowedIn: '*',
    usage: '/logdelete <date>|all',
    description: 'Delete logs for a date, or wipe all logs.',
    handler: ({ chatLog, print }, args) => {
      const target = args[0]
      if (!target) {
        print(
          CLI_CHAT,
          'Usage: /logdelete <date>  (e.g. /logdelete 2026-04-28) or /logdelete all',
        )
        return
      }
      if (target === 'all') {
        chatLog.clear()
        print(CLI_CHAT, 'All logs have been deleted.')
        return
      }
      if (chatLog.remove(target)) {
        print(CLI_CHAT, `Log for ${target} has been deleted.`)
      } else {
        print(CLI_CHAT, 'No logs found for the specified date.')
      }
    },
  },
]

const commandsByName = new Map(commands.map((c) => [c.name, c]))

const buildHelpText = (): string => {
  const lines = ['Commands (prefix with /):']
  const padTo = Math.max(...commands.map((c) => c.usage.length))
  for (const c of commands) {
    lines.push(`  ${c.usage.padEnd(padTo)}  ${c.description}`)
  }
  lines.push('Replies in connecting state: y / n / y <key>')
  lines.push('Replies in connected state: any text (sent as a chat message)')
  return lines.join('\n')
}

export const runCommand = async (
  input: string,
  ctx: CommandContext,
): Promise<void> => {
  const trimmed = input.trim()
  if (!trimmed) return

  if (trimmed.startsWith('/')) {
    const [rawName, ...args] = trimmed.slice(1).split(/\s+/)
    const name = rawName.toLowerCase()
    const command = commandsByName.get(name)

    // In `connected` state, an unknown /foo is more usefully treated as
    // chat content (Discord/Slack style escape) than as a hard error.
    if (!command) {
      if (ctx.state.status === 'connected') {
        await ctx.peer.send(trimmed)
        return
      }
      ctx.print(CLI_CHAT, `Unknown command: /${name}. Type /help for a list.`)
      return
    }

    if (!isAllowed(command, ctx.state.status)) {
      ctx.print(CLI_CHAT, 'Command not allowed in the current status.')
      return
    }
    await command.handler(ctx, args)
    return
  }

  // Free-form (no leading slash) is interpreted by current status.
  switch (ctx.state.status) {
    case 'connecting':
      await handleConnectingResponse(trimmed, ctx)
      return
    case 'connected':
      await ctx.peer.send(trimmed)
      return
    default:
      ctx.print(
        CLI_CHAT,
        'Type /help to see available commands. Commands must start with /.',
      )
  }
}

const handleConnectingResponse = async (
  input: string,
  { peer, state, print }: CommandContext,
): Promise<void> => {
  const [accept, key] = input.split(/\s+/)

  if (state.pendingEncrypted) {
    if (accept === 'y' && key) {
      peer.accept(key)
    } else if (input === 'n') {
      peer.reject()
    } else {
      print(CLI_CHAT, "Invalid response. Please enter 'y <key>' or 'n'.")
    }
    return
  }

  if (input === 'y') {
    peer.accept()
  } else if (input === 'n') {
    peer.reject()
  } else {
    print(CLI_CHAT, "Invalid response. Please enter 'y' or 'n'.")
  }
}
