# AGENTS.md

Entry point for AI coding agents (Claude Code, Cursor, Codex, and any tool following the [AGENTS.md](https://agents.md) convention) working in this repository. Human contributors may also find it useful as a quick architectural map — see [README.md](README.md) for user-facing docs.

## Commands

- `npm run dev` — Vite dev server with HMR
- `npm run build` — `tsc -b` (project references) then `vite build`
- `npm run lint` — ESLint v10 flat config (`--max-warnings 0`)
- `npm run preview` — preview the production build
- `npm test` — Vitest single run
- `npm run test:watch` — Vitest watch mode
- Run a single test file: `npx vitest run src/lib/crypto.test.ts`
- Run a single test by name: `npx vitest run -t "round-trips"`
- `npm run deploy` — `npm run build && wrangler pages deploy` (Cloudflare Pages, project name `cli-chat`)
- `npm run preview:pages` — local Cloudflare Pages emulator over the built `dist/`

## Architecture

This is a single-page PWA implementing a **CLI-style P2P chat client** with mesh group chat and file transfer in the browser. There is no backend — every connection is browser-to-browser over WebRTC via the public PeerJS broker.

### Application is a state machine driven by `Status`

[src/state/session.ts](src/state/session.ts) defines the union `Status = 'offline' | 'online' | 'logged_in' | 'connecting' | 'connected'` and the `sessionReducer` that owns every state transition. **Gating** (which CLI commands are accepted in which state) lives on each command record's `allowedIn` field in [src/commands/index.ts](src/commands/index.ts), not in the session module.

Mesh-aware state shape: the reducer holds `peers: ReadonlyArray<string>` rather than a single remote peerId; `status === 'connected'` means `peers.length >= 1`. The room key (`encryptionKey`, kept as a passphrase string for display) is established by the first encrypted peer-join and persists until the last peer leaves. `connecting` is a transient state used only while a single inbound y/n request is awaiting resolution; further inbound requests during that window are auto-rejected.

Commands are invoked with a leading `/` (e.g. `/login alice`, `/help`). Anything **without** a leading slash is interpreted by the current status: when `status === 'connecting'` it is the y/n response (or `y <key>`) to a pending inbound request; when `status === 'connected'` it is broadcast to every connected peer; in any other status it prints a hint pointing at `/help`. An **unknown** `/foo` while connected is also treated as chat (Slack/Discord-style escape).

### Wire-frame catalog (single DataConnection, multiplexed)

Every PeerJS `DataConnection` carries four kinds of payload, distinguished cheaply by their leading bytes:

| Kind | Format | Discriminator |
|---|---|---|
| **Chat** | raw string (plaintext or base64 ciphertext) | none — fall-through |
| **File** | JSON control frames + binary chunks | string starts with `{"_t":"f"` |
| **Roster** | JSON `{ peers: string[] }` | string starts with `{"_t":"r"` |
| **Join** | JSON `{ op: 'ack'\|'reject' }` | string starts with `{"_t":"j"` |

The dispatcher is in [src/hooks/usePeer.ts](src/hooks/usePeer.ts)' `wireConnection`. Add a new frame type by adding a new prefix predicate alongside the existing ones — chat is the fall-through default.

### Three subsystems collaborate

1. **PeerJS lifecycle (multi-peer)** — encapsulated in [src/hooks/usePeer.ts](src/hooks/usePeer.ts). The hook owns the `Peer`, `connsRef: Map<peerId, DataConnection>`, `awaitingAckRef: Map<peerId, DataConnection>` (outbound waiting for the receiver's `j-ack`), `pendingOutboundRef: Map<peerId, DataConnection>` (in-flight `peer.connect()` whose `'open'` hasn't fired), and `pendingRef` (the single inbound waiting for the user's y/n). It exposes a `PeerController` (`login`, `logout`, `connectTo`, `accept`, `reject`, `disconnect(peerId?)`, `listPeers`, `send`, `ping(peerId?)`, `sendFile(file, peerId?)`, `acceptIncomingFile`, `saveReceivedFile`, `cancelTransfer`) and emits a discriminated `PeerEvent` union back through a single callback. The unmount cleanup destroys the peer and closes every map's connections, so React 19 StrictMode double-mount does not leak broker connections.

   **Join-ack handshake**: PeerJS' DataChannel `'open'` event fires as soon as the underlying transport is up — i.e. before the receiver's user has had any chance to `/accept`. The initiator therefore does *not* emit `peer_joined` on `'open'`; it adds the connection to `awaitingAckRef`, prints "Waiting for `<peer>` to accept...", and waits for the receiver to send a `{"_t":"j","op":"ack"}` frame from `accept()` (or from the `fromRoom` auto-accept path). Only on receiving that ack does the initiator promote the connection into `connsRef` via `finalizeJoin`. A reciprocal `{"_t":"j","op":"reject"}` is sent from `reject()` so the initiator can show "rejected" rather than a generic "connection closed".

   **Auto-roster mesh**: when a peer joins (manually accepted or fromRoom auto-accepted), the existing-side member sends a `{"_t":"r","op":"roster","peers":[…others…]}` frame. The receiver iterates the roster, opens an outbound `peer.connect()` to each unknown peer with `metadata: { v: 1, encrypted, fromRoom: true }`. The other end sees `fromRoom: true` and auto-accepts (no y/n) using the existing room key; this requires `connsRef.size > 0` and matching encryption mode. The full mesh forms with one manual `/connect` per joiner.

   **Auto-resume**: persists the last (peerId, encrypted-flag) pair to `sessionStorage` under `cli-chat:last-connect`. On `peer.on('open')` (which fires on first login and after `peer.reconnect()`), if a saved peer exists and `connsRef.size === 0`, the hook either auto-resumes (plaintext) or prints an instruction to re-issue `/connect bob <key>` (encrypted — the passphrase is intentionally **not** persisted).

   **Sleep recovery**: PeerJS broker sessions get garbage-collected after extended WS disconnection (mobile sleep). On `peer.on('disconnected')` the hook schedules `reconnectIfNeeded`, which prunes ICE-dead `connsRef` entries via `isConnLikelyAlive`, calls `peer.reconnect()`, and sets a 5s failsafe — if `peer.on('open')` doesn't fire in time the broker has reaped the session, so we destroy the Peer and re-`login(id)` from scratch.

2. **Encryption** — opt-in AES-GCM with PBKDF2-SHA256 key derivation on the Web Crypto API ([src/lib/crypto.ts](src/lib/crypto.ts)). Wire format is base64 of `version(1) | salt(16) | iv(12) | ciphertext+tag`; current write version is `0x02` (PBKDF2 600 000 iterations). `SessionKey` derives the key once per room and reuses it for every chat message and every file-transfer chunk — sender uses one fixed `ownSalt` with fresh per-message IVs, receiver caches keys per incoming salt in `inboundCache` (peers can carry different ownSalts and still interoperate). Both peers must hold the same passphrase, exchanged out-of-band via `/connect <id> <key>` on the initiator and `y <key>` on the receiver. The encrypted handshake is signaled via the connection's `metadata: { v: 1, encrypted: true }`; the same metadata also carries an optional `fromRoom: true` flag for auto-introduced mesh peers.

3. **Local logging** — [src/hooks/useChatLog.ts](src/hooks/useChatLog.ts) wraps `localStorage` behind a `ChatLog` API (`append` / `read` / `list` / `remove` / `clear` / `todayKey`). Keys are namespaced as `cli-chat:log:YYYY-MM-DD` so `/loglist` and `/logdelete all` only touch our own data; `read`/`remove` validate the date format. Encrypted messages are stored **as ciphertext**; the `/log <date> [<key>]` command builds a temporary `SessionKey` from the user-supplied passphrase and decrypts each entry through `decryptWithSession`, so multiple sessions in one log file each only pay PBKDF2 once.

### File transfer protocol

[src/lib/fileTransfer.ts](src/lib/fileTransfer.ts) defines control-frame types and helpers; the actual state machine lives in `usePeer`. The flow:

1. Sender: `peer.connect()` is already open; pick a target peer (single peer is implicit, multiple requires `/send <id>`). Sender writes `{op:'init', id, name, size, mime, chunks}` and sets `outgoingFileRef.status = 'awaiting-accept'`.
2. Receiver: stores an `incomingFileRef` of `status: 'pending'`, emits `file_incoming`.
3. Receiver `/accept`: writes `{op:'accept', id}`, flips status to `'receiving'`.
4. Sender's `runOutgoingSend` streams `Math.ceil(file.size / 16KB)` binary chunks. Backpressure: pause when `dataChannel.bufferedAmount > 512KB`, resume on `bufferedamountlow`. Encrypted rooms encrypt each chunk via `encryptBufferWithSession` (cheap — PBKDF2 was paid once at room-join).
5. After the last chunk, sender drains `dataChannel.bufferedAmount` to 0 *before* writing `{op:'done', id}` — without this, PeerJS' internal binarypack encoding queue can deliver the small string ahead of the last few binary chunks, causing the receiver to finalize on a partial Blob.
6. Receiver completes when `(doneReceived && receivedBytes >= size) || receivedChunks.length >= expectedChunks || receivedBytes >= size`. A 5s watchdog fires from the `done` handler in case late chunks never arrive.
7. Receiver `/save`: builds a `File` and either calls `navigator.share({files:[…]})` on iOS PWA (the only reliable save path under standalone display mode) or falls back to a synthesised `<a download>` click. Web Share API needs an active user gesture, which is why save is a separate command rather than auto-invoked on transfer completion.

### Wiring layer

[src/hooks/useChatSession.ts](src/hooks/useChatSession.ts) is the single integration hook. It owns the reducer, the `usePeer` event handler, the `useChatLog` instance, and the `isProcessing` flag. It returns `{ state, isProcessing, handleSubmit }`. [src/App.tsx](src/App.tsx) is therefore a tiny shell — `useChatSession` + `useWakeLock` + render `Terminal`.

### Other UI pieces

- [src/Terminal.tsx](src/Terminal.tsx) — dumb presentational (props: `prompt`, `lines`, `isProcessing`, `onSubmit`)
- [src/PWABadge.tsx](src/PWABadge.tsx) — service worker update prompt (`registerType: 'prompt'`)
- [src/hooks/useWakeLock.ts](src/hooks/useWakeLock.ts) — screen wake lock during `connecting`/`connected`; auto re-acquires on `visibilitychange`

## Conventions specific to this repo

- Status transitions go through `dispatch({ type: '...' })` only. Don't read `state` inside `useCallback` deps if you need the latest value — `useChatSession` keeps a `stateRef` (synced via effect) for `runCommand`.
- All terminal output goes through `print(sender, text)` (which dispatches an `append` action). System messages use the `CLI_CHAT` constant as `sender`; an empty `sender` renders without a `peerId> ` prefix (used for the ASCII banner).
- New commands: add a record to the `commands` array in [src/commands/index.ts](src/commands/index.ts). The `usage` and `description` fields auto-populate `/help`, and the `allowedIn` field gates the dispatcher. There is no second place to update.
- New wire frames: pick a 1-character `_t` discriminator, add a prefix predicate next to the others in `usePeer`'s `wireConnection`, and route to a handler. Keep frames as JSON strings to avoid touching the binary chunk path.
- `verbatimModuleSyntax: true` is enabled — type imports must use `import type` or `import { type X }`.
- `eslint.config.js` is flat config; the lint script runs `eslint .` (no `--ext` flag). `dist`, `dev-dist`, and `coverage` are ignored.
- TypeScript build uses project references: `tsconfig.json` is the root, with `tsconfig.app.json` (src) and `tsconfig.node.json` (configs). Run `tsc -b` rather than plain `tsc`.

## Deployment (Cloudflare Pages)

- Project: `clichat` (live URL `clichat.pages.dev`)
- Config: [wrangler.jsonc](wrangler.jsonc) (`pages_build_output_dir: ./dist`)
- [public/_headers](public/_headers) sets a tight CSP allowing only the PeerJS broker (`*.peerjs.com` + `stun:`/`turn:`), plus `X-Frame-Options DENY`, nosniff, `Permissions-Policy` denying camera/mic/geo, and `no-referrer`. It also bypasses the CDN cache for `sw.js` / `workbox-*.js` / manifest so PWA updates flow through immediately.
- [public/_redirects](public/_redirects) is the SPA fallback (`/* /index.html 200`).
- Run `npm run deploy` to push a new build. The first deploy requires `npx wrangler login`.

## Privacy / threat-model notes

- **PeerJS public broker**: peer IDs and SDP/ICE signalling go through `0.peerjs.com`. Message contents do not (WebRTC is direct browser-to-browser, DTLS-encrypted). If peer ID disclosure matters, switch to a self-hosted PeerJS server via `new Peer(id, { host, port, path })`.
- **Encryption passphrase** is in JS memory for the active session, held inside the derived `SessionKey` so we can re-derive on cache misses for new salts. It is visible in the on-screen scrollback once typed (`/connect bob <key>`); never written to `localStorage` or `sessionStorage`; never sent over the wire. Encrypted sessions are not auto-resumed because resuming would require persisting the passphrase.
- **Mesh trust model**: `fromRoom: true` auto-acceptance means any existing room member can introduce additional peers without per-peer consent from other members. Suitable for small trusted groups, not a substitute for cryptographic invitations. The metadata flag is sent unauthenticated over the broker — spoofing it cannot reveal plaintext (no key) but could induce a "Deriving room key…" prompt loop on the receiver.
- **Local chat log** lives in `localStorage` namespaced as `cli-chat:log:YYYY-MM-DD`. Encrypted messages are stored as ciphertext.

## Testing

Vitest with `jsdom` environment, `globals: true`, and `@testing-library/jest-dom/vitest` set up in [src/setupTests.ts](src/setupTests.ts). Tests live next to the unit they cover (`*.test.ts`). The PeerJS hook is intentionally untested (WebRTC dependence); test the surrounding pieces (reducer, crypto, command dispatcher, chat log, fileTransfer protocol parser) instead and stub the `PeerController` interface in command tests.
