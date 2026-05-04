# cli-chat

```
  ___ _    ___     ___ _  _   _ _____
 / __| |  |_ _|__ / __| || | /_\_   _|
| (__| |__ | |___| (__| __ |/ _ \| |
 \___|____|___|   \___|_||_/_/ \_\_|
  CLI based P2P chat app
```

A serverless, terminal-style P2P chat client that runs entirely in the browser. No accounts, no backend, no message history on any server — browsers talk directly over WebRTC, with optional end-to-end AES-GCM encryption, group chat, and file transfer.

**Live demo:** https://clichat.pages.dev

## Features

- **CLI-style UI** — every action is a slash command (`/login`, `/connect`, `/help`)
- **Pure P2P** — WebRTC data channels via the [PeerJS](https://peerjs.com/) public broker; message contents never touch a server
- **Mesh group chat** — connect to multiple peers; one `/connect` brings the new joiner into the whole room automatically (auto-roster)
- **File transfer** — `/send` to push a file directly to a peer; works under encryption, with backpressure-aware chunking and an iOS-PWA-friendly save flow (Web Share API)
- **End-to-end encryption (opt-in)** — AES-GCM 256 with PBKDF2-SHA256 (600 000 iterations); the room key is derived once per session and reused for every message and every file chunk
- **PWA** — installable, offline-capable shell, Workbox-managed service worker
- **Local chat log** — saved per-day in `localStorage`; encrypted messages stored as ciphertext, decrypted on demand via `/log`
- **Auto-resume** — the previous session is restored automatically after the device wakes from sleep, including broker-session-expiry recovery
- **Wake lock** — keeps the screen awake while a connection is active (mobile-friendly)
- **Tight CSP** — strict Content-Security-Policy restricts network access to the PeerJS broker only

## Quickstart

```bash
git clone https://github.com/shonocode/cli-chat.git
cd cli-chat
npm install
npm run dev
```

Open `http://localhost:5173` in two browser windows (or two devices on the same network).

## Usage

The app is driven by slash commands. Type `/help` at any time for the full list.

### 1-on-1 plaintext session

```
[Window A]
> /login alice
[Window B]
> /login bob
> /connect alice
[Window A]
alice wants to connect. Do you accept? (y/n)
> y
[Window A]
bob joined.
[Window B]
alice joined.
[both]
> hello!
```

### Group chat (3+ peers)

When a third peer joins, they only need to `/connect` to **one** existing member. The mesh extends automatically — every member ends up directly connected to every other member.

```
[A and B already connected]

[Window C]
> /login carol
> /connect alice
[Window A]
carol wants to connect. Do you accept? (y/n)
> y
[Window A]
carol joined.

[After A's roster reaches C, C auto-connects to B and B auto-accepts]
[Window B]
carol joined (auto-introduced via the room).
[Window C]
bob joined (auto-introduced via the room).

> /who
Connected peers: bob, carol
> hi all
  alice> hi all   (B and C see this)
```

### Encrypted session

All peers must hold the same passphrase, exchanged out-of-band (e.g. via Signal, in person). The room key is derived once per session and reused — joining a room takes about a second on a phone, then chat and file transfer run at full speed.

```
[Window B]
> /connect alice hunter2
[Window A]
Encrypted connection request from bob. Accept? (y <key>/n)
> y hunter2
Deriving room key (this may take a moment)...
bob joined.
```

### File transfer

```
[A and B connected]

[Window A]
> /send
(file picker opens)
Offering photo.jpg to bob (waiting for /accept)...

[Window B]
Incoming file from alice: photo.jpg (4.2 MB). Type /accept to receive or /cancel to decline.
> /accept
Receiving photo.jpg...
receiving photo.jpg [#####-----] 50%
photo.jpg (4.2 MB) ready. Type /save to save it.
> /save
Saved photo.jpg.
```

On iOS PWA, `/save` opens the native share sheet (Files / Photos / AirDrop). On desktop, it triggers a download.

With multiple peers connected, target a specific recipient: `/send bob`.

### Command reference

| Command | Description |
|---|---|
| `/login <id>` | Set your peer ID and initialize PeerJS |
| `/connect <id> [<key>]` | Connect to a peer (or invite another into the group). Optional `<key>` enables AES-GCM encryption; ignored once a room key is set |
| `/disconnect [<id>]` | Disconnect one peer, or all if no id is given |
| `/who` | List currently connected peers |
| `/ping [<id>]` | Show round-trip time to a peer |
| `/send [<id>]` | Pick a file and send it (target id required if multiple peers connected) |
| `/accept` | Accept the pending incoming file transfer |
| `/save` | Save the most recently received file to your device |
| `/cancel` | Cancel the current file transfer (in either direction) |
| `/logout` | Log out and return to the online status |
| `/log <date> [<key>]` | Show the log for a date (`YYYY-MM-DD`); `<key>` decrypts ciphertext |
| `/loglist` | List all available log dates |
| `/logdelete <date>\|all` | Delete logs for a date, or wipe all logs |
| `/help` | Show all commands |

When connected, plain text without a leading `/` is broadcast to every connected peer.

## Stack

- React 19 + TypeScript + Vite 7
- PeerJS for WebRTC signaling and data channels
- Web Crypto API for encryption (no third-party crypto)
- VT323 (self-hosted via `@fontsource/vt323`)
- Workbox via `vite-plugin-pwa`
- Vitest + Testing Library

## Scripts

```bash
npm run dev            # Vite dev server with HMR
npm run build          # tsc -b && vite build
npm run preview        # preview the production build locally
npm test               # run the test suite once
npm run test:watch     # watch mode
npm run lint           # ESLint (--max-warnings 0)
npm run deploy         # build + wrangler pages deploy (Cloudflare Pages)
npm run preview:pages  # local Cloudflare Pages emulator
```

## Deployment

The repo is configured for **Cloudflare Pages** out of the box. After `npx wrangler login`, run:

```bash
npm run deploy
```

The build output (`dist/`) is uploaded; the SPA fallback and security headers come from [public/_redirects](public/_redirects) and [public/_headers](public/_headers). Any static host works equally well — just serve `dist/` with the SPA fallback.

## Privacy & threat model

- **PeerJS broker (public):** peer IDs and SDP/ICE signalling pass through `0.peerjs.com`. Message contents do **not** — WebRTC is direct browser-to-browser, DTLS-encrypted. For full peer-ID privacy, run a [self-hosted PeerJS server](https://github.com/peers/peerjs-server).
- **Encryption passphrase:** lives in JS memory for the active session (held inside the derived `SessionKey`) and appears in on-screen scrollback once typed. It is **never** sent over the wire and **never** written to `localStorage` or `sessionStorage`.
- **Mesh trust model:** when an existing room member sends an `auto-introduced` connection on your behalf, the receiver auto-accepts using the existing room key. In effect, every existing member can pull in additional peers — fine for small trusted groups; not a substitute for cryptographic invitations.
- **Local logs:** stored in `localStorage` under `cli-chat:log:YYYY-MM-DD`. Encrypted messages are stored as ciphertext and decrypted on demand.

## Architecture

See [AGENTS.md](AGENTS.md) for an architectural map: state machine, three subsystems, wiring layer, the four wire-frame types, and the join-ack handshake.

## License

[MIT](LICENSE)
