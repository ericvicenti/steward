# Steward — Security & Secrets Vault Design

Status: implementation-ready design. Companion to `docs/BRIEF.md` (authoritative vision).
Scope: threat model, node identity & mutual auth, browser↔daemon auth on localhost,
the encrypted secrets vault (crypto, schemas, sync, flows), and explicit non-goals.

---

## 1. Threat model

Steward is single-user, multi-machine, LAN-first. We defend against these concrete
adversaries, in priority order:

| # | Threat | Defended? | How |
|---|--------|-----------|-----|
| T1 | **Stolen laptop / stolen disk** (attacker has the powered-off machine or a disk image) | Yes | Vault items are ciphertext at rest; key derived from master password via argon2id, never stored. Node identity key is stored plaintext (0600) — a stolen node's identity must be revoked from another node (§3.6). |
| T2 | **Malicious LAN peer** (attacker on the same network: sniffing, spoofing, MITM, port scanning) | Yes | Daemon HTTP binds `127.0.0.1` only. Node-to-node traffic is a mutually-authenticated encrypted channel (§3). Unpaired peers get nothing past the handshake. Pairing requires a short-lived code with MAC proof (§3.5). |
| T3 | **Other local users / processes on the same machine (non-root, different UID)** | Yes | API requires a bearer session minted from a 0600 token file only our UID can read (§4). Identity, DB, and token files are 0600 in a 0700 `~/.steward`. |
| T4 | **Compromised remote node** (attacker fully owns one machine in the fleet) | Partially | It can read/modify anything that node legitimately syncs, and can serve its own UI. It **cannot** decrypt vault items (it only ever holds ciphertext) and cannot impersonate other nodes (no access to their private keys). Blast radius = that node's own data + garbage writes, which version vectors make detectable/recoverable (§6). Revocation flow in §3.6. |
| T5 | **Same-UID malware / root on the box** | **No** | Explicit non-goal, see §8. Root reads memory, patches the binary, keylogs the master password. |
| T6 | **Malicious daemon serving trojaned UI JS to steal the master password** | **No** (acknowledged) | "Client-side encryption" is only as honest as the JS the daemon serves. A compromised daemon on the node you type your master password into can exfiltrate it. Mitigation is T4 hygiene: type the master password only on machines you trust, which is the normal 1Password/Bitwarden posture too. |

Design rules that fall out of this:

1. Nothing secret ever crosses a socket in plaintext — not even on localhost loopback
   for the vault (loopback carries ciphertext; decryption is browser-memory only).
2. The daemon never holds vault plaintext or the vault key, ever. It is a dumb
   ciphertext store + sync relay.
3. Every remote byte flows through the authenticated node channel; no feature may open
   a second listening port.

---

## 2. Crypto library choice (decided)

**libsodium** everywhere: `libsodium-wrappers-sumo` (WASM) in the browser, Bun's
`node:crypto` for ed25519/X25519/HKDF in the daemon where convenient, libsodium in the
daemon for anything the browser must interoperate with byte-for-byte.

**Cipher: XChaCha20-Poly1305, not AES-GCM via WebCrypto.** Justification:

- WebCrypto has **no argon2id**, so a WASM crypto dependency is unavoidable for the KDF.
  Once libsodium is in the bundle, using it for AEAD too means one audited library, one
  API, identical bytes on server and client — instead of splitting KDF (WASM) and AEAD
  (WebCrypto) across two implementations.
- XChaCha20-Poly1305 has a **192-bit nonce**, safe to generate randomly forever with no
  bookkeeping. AES-GCM's 96-bit nonce makes random generation a per-key budget
  (~2³² messages) you must reason about on every write path and every future feature.
  Misuse-resistance beats hardware AES speed for a password vault (items are < 100 KB).
- ed25519/X25519 for identity and handshake come from the same library.

All binary values are stored/transmitted as base64url strings in JSON, raw bytes on the
encrypted WS channel.

---

## 3. Node identity & node-to-node auth

### 3.1 Identity files

```
~/.steward/                     mode 0700
  identity.json                 mode 0600   ← the node's soul; never syncs
  auth-token                    mode 0600   ← local browser/CLI auth (§4)
  steward.db                    mode 0600
```

`identity.json`:

```json
{
  "v": 1,
  "nodeId": "stw1-Zm9vYmFyLXB1YmtleS1iMzJ...",
  "ed25519": { "publicKey": "<b64url 32B>", "secretKey": "<b64url 64B>" },
  "createdAt": "2026-08-18T00:00:00Z",
  "name": "erics-mbp"
}
```

- `nodeId` = `"stw1-" + base64url(ed25519 publicKey)` — the public key **is** the
  identity (self-certifying, no CA).
- Created on first daemon start if absent; written with `O_CREAT|O_EXCL` and
  `chmod 0600`; daemon refuses to start if perms are looser (like `ssh` does), logging
  the fix command.
- The X25519 key for handshakes is derived per-handshake (ephemeral); the ed25519 key
  only signs.

### 3.2 Trusted-peers table

```sql
CREATE TABLE trusted_nodes (
  node_id      TEXT PRIMARY KEY,        -- "stw1-…"
  public_key   BLOB NOT NULL,           -- 32B ed25519
  name         TEXT NOT NULL,
  addresses    TEXT NOT NULL DEFAULT '[]', -- JSON: last-known ["192.168.1.10:4777", …]
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER                  -- non-null ⇒ refuse handshake, keep row for audit
);
```

### 3.3 Handshake (Noise-XX-with-signatures over WebSocket)

Transport: the daemon's Hono server exposes `GET /ws/node` (WebSocket upgrade) on the
LAN **only after** at least one peer is paired or a pairing window is open; otherwise
the listener stays loopback-only. All frames after upgrade are binary.

Pattern (mutual auth, forward secrecy; both sides prove possession of their ed25519 key
by signing the transcript — simpler to audit than Noise static-key patterns and reuses
the identity key directly):

```
Initiator (I)                          Responder (R)
  e_I = X25519 keygen
  m1 = { v:1, ePub_I, nonce_I(32B) }  ──────────────▶
                                         e_R = X25519 keygen
                                         ss = X25519(e_R, ePub_I)
                                         th = BLAKE2b(m1 ‖ ePub_R ‖ nonce_R)
                                         sig_R = ed25519_sign(sk_R, "stw-hs-v1" ‖ th)
  ◀──────  m2 = { ePub_R, nonce_R, nodeId_R, sig_R }
  ss = X25519(e_I, ePub_R)
  verify sig_R against trusted_nodes[nodeId_R]     ← unknown/revoked ⇒ close(4403)
  th  = BLAKE2b(m1 ‖ ePub_R ‖ nonce_R)             (same transcript hash)
  sig_I = ed25519_sign(sk_I, "stw-hs-v1" ‖ th)
  m3 = seal(k_i2r, n=0, { nodeId_I, sig_I })  ────▶
                                         open m3, verify sig_I against trusted_nodes
                                         unknown/revoked ⇒ close(4403)
```

Key schedule (HKDF-SHA-256):

```
prk        = HKDF-Extract(salt = "steward/hs/v1", ikm = ss ‖ th)
k_i2r      = HKDF-Expand(prk, "i2r", 32)     # initiator→responder AEAD key
k_r2i      = HKDF-Expand(prk, "r2i", 32)     # responder→initiator AEAD key
session_id = HKDF-Expand(prk, "sid", 16)     # log correlation, not secret
```

Transport frames after m3: `XChaCha20-Poly1305(key = direction key,
nonce = 16B random ‖ 8B LE counter, ad = session_id)`. Counter is per-direction,
strictly increasing; receiver rejects any non-monotonic counter (replay/reorder
protection — WS is ordered, so no window needed). Rekey by re-handshaking after 2³² 
frames or 24 h, whichever first.

Properties: forward secrecy (ephemeral X25519), identity hiding of the initiator from
passive observers (nodeId_I only inside m3, which is encrypted), mutual auth, MITM
resistance (signatures cover both ephemerals via `th`).

### 3.4 Application protocol on the channel

Inside the encrypted frames, messages are JSON envelopes:

```json
{ "id": "req-7", "type": "vault.pull", "payload": { … } }
{ "id": "req-7", "type": "reply", "ok": true, "payload": { … } }
```

RPC types are registered in `src/daemon/peer/rpc.ts`; every handler receives
`(peer: TrustedNode, payload)` — authorization is "is a non-revoked trusted node",
uniform for all fleet features (git sync, blob sync, vault sync, docker admin).

### 3.5 Pairing (first contact)

Trust bootstrap uses a short-lived one-time code, never TOFU:

1. On node A (already yours): `steward pair` or UI button. A generates
   `pairSecret = 32 random bytes`, displays it as a QR (full secret) **and** a human
   code: 8 Crockford-base32 chars (40 bits) — the human code path additionally requires
   both machines on the same LAN and a 60-second expiry, making the 40-bit space
   un-brute-forceable in the window (A hard-fails pairing after 3 bad attempts).
   A begins listening for pairing on its LAN interface, 60 s window.
2. On node B: `steward join <code-or-qr> [host:port]` (mDNS `_steward._tcp` discovery
   fills host:port on LAN). B connects to `/ws/pair` and runs the §3.3 handshake
   **unauthenticated** (no signature verification yet — encrypted but unauthenticated
   tunnel), then sends
   `{ nodeId_B, name_B, proof: BLAKE2b-MAC(key = pairSecret, msg = th) }`
   where `th` is the handshake transcript hash — binding the code to *this* tunnel, so
   a MITM cannot splice.
3. A verifies the MAC, replies with `{ nodeId_A, name_A, proof: MAC(pairSecret, th ‖ "A") }`,
   both insert each other into `trusted_nodes`, and the pairing window closes.
4. Both sides show the other's name + nodeId fingerprint (first 12 chars) for eyeball
   confirmation.

### 3.6 Revocation (stolen laptop)

From any surviving node: `steward node revoke <nodeId>` sets `revoked_at`, and the
revocation is gossiped to all reachable peers as a signed statement
`ed25519_sign(sk_revoker, "stw-revoke-v1" ‖ nodeId_revoked ‖ timestamp)` which peers
verify and apply. Revoked nodes fail every future handshake at m2/m3. Because the vault
key never touches disk, a stolen node leaks vault **ciphertext only**; rotating the
master password (§7.3) additionally rewraps item keys so even a future password
compromise doesn't compose with the old stolen ciphertext generation.

---

## 4. Browser ↔ daemon auth on localhost

Problem: `http://127.0.0.1:4777` is reachable by every process and user on the machine.
Cookies/DNS-rebinding/other-UID access must all fail closed.

### 4.1 Bootstrap token

- First run: daemon writes 32 random bytes (base64url) to `~/.steward/auth-token`,
  mode 0600. Possession of this file ⇒ same UID ⇒ authorized (this is the same trust
  model as the Docker socket or `~/.ssh`).
- `steward open` (and the installer's final step) reads the token and opens
  `http://127.0.0.1:4777/#/login?ott=<one-time-ticket>` — the CLI first exchanges the
  file token for a **one-time ticket** via `POST /api/auth/ticket`
  (header `Authorization: Bearer <file-token>`), so the long-lived token never appears
  in browser history, process args, or referrers. Tickets: 32B random, single-use,
  30-second TTL, stored in an in-memory map.

### 4.2 Session cookie

`POST /api/auth/session` with `{ "ott": "…" }` (the SPA does this on load when it sees
`ott` in the URL fragment — fragments are never sent to servers or logged):

- Sets `steward_session=<32B random>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
  (30 days, sliding). No `Secure` flag — the origin is plain-http loopback; the wire is
  the kernel. Session ids live in SQLite:

```sql
CREATE TABLE ui_sessions (
  id           TEXT PRIMARY KEY,   -- 32B random, b64url
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  user_agent   TEXT
);
```

### 4.3 Request hardening (all enforced in one Hono middleware, `src/daemon/http/auth.ts`)

1. Listener binds `127.0.0.1` and `::1` only (peer channel is a separate LAN listener
   speaking only `/ws/node` + `/ws/pair`).
2. **Host header check**: must be `127.0.0.1:4777`, `localhost:4777`, or `[::1]:4777`
   — kills DNS-rebinding, which is otherwise fatal on localhost servers.
3. **Origin check** on every non-GET and every WS upgrade: absent (CLI) or exactly the
   loopback origin — kills CSRF from arbitrary websites even before SameSite.
4. Custom header `X-Steward-Csrf: 1` required on mutating routes (a cross-origin form
   can't set custom headers).
5. Routes: everything under `/api/*` and `/ws/ui` requires a valid session cookie
   **or** `Authorization: Bearer <file-token>` (CLI path). Static assets and
   `/api/auth/*` are the only exceptions.
6. `steward auth reset` rotates the token file and deletes all `ui_sessions`.

---

## 5. The secrets vault

### 5.1 Key hierarchy

```
master password ──argon2id──▶ KEK (32B, exists only in browser memory)
                                 │ unwraps
                                 ▼
                       VaultKey generation g (32B random)   ← rotates on password change
                                 │ unwraps (per item)
                                 ▼
                       ItemKey (32B random, one per item)
                                 │ encrypts
                                 ▼
                       item plaintext JSON
```

Two wrap levels so that **password rotation is O(items) cheap rewraps of 48-byte keys,
not re-encryption of payloads**, and per-item keys mean a future "share one item"
feature needs no redesign.

**argon2id parameters** (libsodium `crypto_pwhash`, explicit — never "MODERATE" by
name, since libsodium's aliases can drift):

- memory: **64 MiB** (67108864 bytes)
- iterations (opslimit): **3**
- parallelism: **1** (libsodium WASM is single-threaded; also keeps mobile-Safari-tab
  memory pressure sane)
- salt: 16B random per vault, stored in vault header
- output: 32B

~0.5–1.5 s in WASM on Eric's machines: felt-but-fine for an unlock, brutal for offline
cracking. Parameters are stored in the header, so they can be raised later; unlock
always reads them from the header (forward-compatible).

### 5.2 Storage schema (daemon side — ciphertext only)

```sql
CREATE TABLE vault_header (          -- exactly one row per vault; synced
  vault_id        TEXT PRIMARY KEY, -- random uuid, same across all nodes
  kdf             TEXT NOT NULL,    -- JSON: {"alg":"argon2id","mem":67108864,"ops":3,"par":1,"salt":"<b64url>"}
  key_generation  INTEGER NOT NULL, -- bumped on password rotation
  wrapped_vault_key BLOB NOT NULL,  -- XChaCha20-Poly1305(KEK, VaultKey), 24B nonce ‖ ct ‖ tag
  verifier        BLOB NOT NULL,    -- seal(VaultKey, "steward-vault-verifier-v1") — unlock check
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT NOT NULL     -- nodeId
);

CREATE TABLE vault_items (
  item_id         TEXT PRIMARY KEY, -- uuidv7 (time-ordered)
  key_generation  INTEGER NOT NULL, -- which VaultKey wraps this item's key
  wrapped_item_key BLOB NOT NULL,   -- XChaCha20-Poly1305(VaultKey, ItemKey), ad = item_id
  ciphertext      BLOB NOT NULL,    -- XChaCha20-Poly1305(ItemKey, plaintextJSON), ad = item_id ‖ key_generation
  version_vector  TEXT NOT NULL,    -- JSON {"<nodeId>": counter, …}
  deleted         INTEGER NOT NULL DEFAULT 0,  -- tombstone; ciphertext blanked
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT NOT NULL
);
```

**Everything sensitive — including the item's title — is inside `ciphertext`.** The
daemon can see only: how many items exist, their ids, sizes, and edit times. The UI
therefore decrypts all items on unlock to build its search index in memory (fine for
the target scale of ≤ a few thousand items).

The `ad` (associated data) bindings prevent ciphertext-swapping between items and
across key generations.

### 5.3 Item plaintext schema (inside the ciphertext)

```json
{
  "v": 1,
  "type": "login",           // "login" | "note" | "ssh_key" | "api_key" | "env" | "totp" | "card"
  "title": "GitHub",
  "fields": [
    { "k": "username", "v": "ericvicenti", "kind": "text" },
    { "k": "password", "v": "…", "kind": "secret" },
    { "k": "url",      "v": "https://github.com", "kind": "url" },
    { "k": "totp",     "v": "otpauth://totp/…", "kind": "totp" }
  ],
  "tags": ["dev"],
  "notes": "",
  "history": [                       // last 10 secret-field values, for oops-recovery
    { "k": "password", "v": "old…", "replacedAt": "2026-06-01T…" }
  ],
  "createdAt": "2026-05-01T…",
  "updatedAt": "2026-08-18T…"
}
```

Typed `kind`s drive the UI (mask secrets, autolaunch urls, render TOTP codes with a
countdown — TOTP computed client-side from the stored `otpauth://` URI).

### 5.4 API routes (all localhost, session-authed; bodies are ciphertext)

```
GET    /api/vault/header                 → vault_header row
PUT    /api/vault/header                 → create/rotate (see flows §7)
GET    /api/vault/items?since=<hlc>      → [{item_id, key_generation, wrapped_item_key,
                                             ciphertext, version_vector, deleted, updated_at}]
PUT    /api/vault/items/:id              → upsert one encrypted row (client supplies
                                           bumped version_vector; daemon rejects if the
                                           stored VV is not ≤ the submitted one → 409
                                           with current row, client merges & retries)
DELETE /api/vault/items/:id              → tombstone (client sends re-encrypted blank + VV bump)
GET    /api/vault/status                 → { itemCount, lastSyncAt, peers: [{nodeId, lastVaultSyncAt}] }
```

There is deliberately **no** `/api/vault/unlock` — the daemon cannot unlock anything.

### 5.5 Client-side crypto architecture (browser)

- All key material lives in a dedicated **Web Worker** (`src/ui/vault/vault.worker.ts`).
  The React app posts commands (`unlock`, `decryptItem`, `encryptItem`, `lock`,
  `generatePassword`) and gets plaintext back; KEK/VaultKey/ItemKeys never enter the
  main thread's heap, which shrinks exposure to XSS-in-main-thread and makes lock =
  worker teardown.
- `lock` calls `sodium.memzero` on every key buffer then `worker.terminate()`; the app
  keeps zero plaintext in React state after lock (item list state is dropped, not just
  hidden).
- Unlock ceremony: fetch header → argon2id(password, header.kdf) → open
  `wrapped_vault_key` → check `verifier` opens to the fixed string → success. Wrong
  password = AEAD failure on the wrap, indistinguishable from tampering: both show
  "wrong password or corrupted vault".

### 5.6 Auto-lock

- Idle timer in the worker: default **10 minutes** since last vault operation
  (configurable 1 min–1 h, or "on tab hide"). Worker self-terminates; UI flips to the
  lock screen via the worker's `close` event.
- Also locks on: tab `visibilitychange` → hidden for > 60 s (configurable), explicit
  `⌘L`, and `steward vault lock` (broadcast over `/ws/ui` so every open tab locks).
- The session cookie (§4) is unaffected — auto-lock is about vault keys, not UI auth.

### 5.7 Password generator (entirely client-side)

`crypto.getRandomValues` with **rejection sampling** (no modulo bias):

- Modes: `chars` (default 24 chars from a 94-symbol set, toggles for
  no-ambiguous/no-symbols/require-each-class — require-each-class implemented by
  generate-then-check-then-retry, not by slot-forcing, to keep uniformity) and
  `words` (diceware: 6 words from the EFF long list (7776 words, ~77 bits), `-`
  separator, bundled as a static asset).
- Entropy meter shown in bits, computed from the actual mode parameters, not zxcvbn
  guessing.

---

## 6. Vault sync between nodes (opaque ciphertext)

Runs over the §3 channel; the daemon syncs rows it cannot read.

### 6.1 Version vectors

- Each item carries `version_vector: { nodeId → counter }`. On local edit (which is
  always via the browser of some node N), the client bumps `VV[N] += 1`.
- Dominance: `A ≥ B` iff every counter in B is ≤ its counterpart in A. Strictly greater
  ⇒ overwrite. Concurrent (neither dominates) ⇒ **conflict**.
- Conflict policy (secrets must never be silently lost): keep the row with the higher
  `updated_at` as the item, and write the loser as a **new item** whose decrypted title
  the UI suffixes with `(conflict from <node>, <date>)` at next unlock. Its VV is the
  join of both plus a bump. The UI surfaces a "resolve conflicts" badge.
- Tombstones: `deleted=1` rows sync like normal rows and win by the same rules;
  purged after 90 days once every trusted node's sync cursor has passed them.

### 6.2 Protocol (anti-entropy, runs on connect + every 60 s + push on write)

```
A→B  vault.digest   { vaultId, headerGen, items: [{item_id, vvHash: BLAKE2b(VV)}…] }   (compact)
B→A  vault.want     { need: [item_id…], offer: [item_id…] }
A→B  vault.rows     { rows: [full encrypted rows…] }        (for `need`)
B→A  vault.rows     { rows: […] }                            (for `offer`)
```

Header sync: higher `key_generation` always wins (rotation is globally ordered by
generation number; ties are impossible because rotation is refused unless the node has
synced the current max generation — see §7.3). Items whose `key_generation` is older
than the header's are still decryptable only after rewrap; the rotating client rewraps
all items it can see, and stragglers arriving later from offline nodes get rewrapped
lazily by the next unlocked client that sees them (old VaultKeys, wrapped under the
new one, are kept in the header's `legacy_keys` JSON for exactly this).

---

## 7. Flows

### 7.1 Create vault (first run, in browser)

1. UI: choose master password (min 10 chars; show entropy; offer generated diceware).
2. Worker: random salt → argon2id → KEK; random VaultKey; build
   `wrapped_vault_key` + `verifier`; `PUT /api/vault/header` with `key_generation = 1`.
3. Header syncs to peers like any row; other nodes now have the vault, locked.

### 7.2 Unlock

Browser only, per §5.5. Rate limiting is client-side courtesy only (attacker with the
ciphertext does offline cracking anyway — argon2id is the real defense).

### 7.3 Rotate master password

1. Unlock with old password (must hold VaultKey_g).
2. Refuse unless this node's sync cursor shows the current max `key_generation`
   (prevents split-brain double-rotation; user is told to sync first if offline).
3. Worker: new salt → argon2id(newPassword) → KEK′; **new** VaultKey_{g+1}; rewrap every
   item's `wrapped_item_key` under VaultKey_{g+1} (payload ciphertext untouched — this
   is ~48 bytes/item of AEAD, instant for thousands of items); build new header with
   `key_generation = g+1` and `legacy_keys = { g: seal(VaultKey_{g+1}, VaultKey_g) }`.
4. Single `PUT /api/vault/header` + batched item PUTs; header generation bump
   propagates by §6.2.

Rotating after a device theft: also `steward node revoke` the stolen node (§3.6).

### 7.4 Change a secret / add item

Edit in UI → worker encrypts with the item's ItemKey (new random nonce), bumps VV →
`PUT /api/vault/items/:id` → daemon pushes `vault.rows` to connected peers.

---

## 8. Explicitly NOT protected

Written down so nobody oversells this later:

1. **Root (or your own UID's malware) on any node.** They read `identity.json`, the
   token file, daemon memory, and can patch the served JS to capture the master
   password at next unlock. No local software can defend against its own administrator.
2. **A compromised daemon on the machine where you type the master password** (T6):
   same reason. Unlock on trusted machines.
3. **Clipboard**: copied secrets go to the OS clipboard; we auto-clear after 30 s via
   the Clipboard API where allowed, but clipboard managers may retain history.
4. **Swap/hibernation files** possibly containing key bytes from browser memory —
   use FileVault/LUKS (Steward's convergence facets should nag about this).
5. **Traffic analysis** on the peer channel: item counts, sizes, and timing are visible
   to a LAN observer even though contents are not.

---

## 9. File layout (implementation map)

```
src/daemon/
  http/auth.ts          # §4 middleware: host/origin/CSRF/session checks
  http/routes/auth.ts   # /api/auth/ticket, /api/auth/session
  http/routes/vault.ts  # §5.4 routes (ciphertext CRUD, VV enforcement)
  peer/identity.ts      # identity.json load/create, perm checks
  peer/handshake.ts     # §3.3 (shared with browser? no — daemon-only)
  peer/channel.ts       # framing, counters, rekey
  peer/pairing.ts       # §3.5
  peer/rpc.ts           # envelope router
  vault/sync.ts         # §6.2 digest/want/rows
src/ui/vault/
  vault.worker.ts       # all key material; argon2id, AEAD, generator
  api.ts                # ciphertext CRUD client
  components/…          # lock screen, item list, editor, conflict badge
src/cli/
  pair.ts join.ts open.ts auth-reset.ts node-revoke.ts vault-lock.ts
```

Test priorities: handshake transcript vectors (golden bytes, both roles), VV merge
property tests (fast-check), wrong-password/tampered-ciphertext rejection, perm-check
refusal on identity file, Host/Origin rejection matrix for §4.3.
