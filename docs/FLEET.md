# Steward Fleet — Multi-Node Design

Status: design, implementation-ready.
Scope: node identity, pairing, transport mesh, RPC protocol, remote management (API
proxying), fleet state replication, conflict rules, offline handling, security posture.

This document assumes the stack in `docs/BRIEF.md`: Bun + TypeScript daemon, Hono on
`127.0.0.1:4777`, SQLite at `~/.steward/steward.db`, ed25519 node identity.

---

## 1. Concepts and vocabulary

- **Node** — one Steward daemon on one machine. Exactly one per machine.
- **Fleet** — the set of nodes that have all been (transitively) paired. One fleet per
  user. A node belongs to at most one fleet.
- **Peer record** — a node's signed, self-published metadata document (name, addresses,
  capabilities, index summary). Replicated to every node by gossip.
- **Link** — a live, mutually authenticated, encrypted WebSocket between two nodes.
- **Relay** — any node forwarding opaque ciphertext frames between two nodes that cannot
  reach each other directly.

Design north star: **every node is a full replica of fleet metadata and a full-featured
control panel for every other node.** There is no coordinator, no primary, no cloud.

---

## 2. Node identity

### 2.1 Keypair

Each node generates an ed25519 keypair on first boot:

- Private key: `~/.steward/identity/node.key` — 32-byte seed, file mode `0600`, never
  leaves the machine, never written to SQLite.
- Public key: `~/.steward/identity/node.pub` (also cached in DB for convenience).
- Generated with `crypto.subtle` ed25519 (supported in Bun); libsodium-wrappers is the
  fallback and is already required for the transport cipher (§4.3), so use
  `libsodium-wrappers` (`crypto_sign_keypair`) for everything — one crypto library,
  no WebCrypto feature-detection.

### 2.2 Node ID

```
nodeId = "stw1" + base32nopad(ed25519_pubkey)        // 4 + 52 = 56 chars, lowercase
shortId = first 8 chars after prefix                  // for logs/UI, e.g. "stw1-k7f3q2xa…"
```

- The nodeId **is** the public key. There is no separate registry; possession of the
  private key is the identity. Renaming a machine never changes its nodeId.
- `base32nopad` = RFC 4648 lowercase, no padding. Chosen over hex for QR/URL density and
  over base58 to keep encoding trivial and case-insensitive.

### 2.3 Derived X25519 key

The transport handshake (§4.3) needs Diffie-Hellman. Convert the ed25519 static key to
X25519 via libsodium `crypto_sign_ed25519_pk_to_curve25519` /
`crypto_sign_ed25519_sk_to_curve25519`. One identity file, two uses (sign + DH).

### 2.4 Human-facing identity

Nodes also carry a mutable display name (`"erics-mbp"`, default `os.hostname()`), an
emoji/color chosen at pair time, and a `machineClass` enum:
`laptop | desktop | server | backup`. These live in the peer record (§7), not the key.

---

## 3. Pairing

Pairing is how two nodes learn and trust each other's public keys. After pairing, all
trust is cryptographic; pairing is the only ceremony.

Two flows, both initiated from the web UI of an already-running node:

### 3.1 Flow A — URL / QR (preferred, MITM-proof)

1. On node A's UI: **Fleet → Add node → Show pairing link**. A calls
   `POST /api/pair/offer` locally, which mints:

```jsonc
// pairing offer (encoded into URL + QR)
{
  "v": 1,
  "nodeId": "stw1k7f3q2xa…",                 // A's full pubkey
  "addrs": ["192.168.1.20:4778", "100.101.5.9:4778"],
  "token": "u4…22 chars…",                    // 128-bit single-use secret, base32
  "exp": 1755550000                           // unix seconds, now + 10 min
}
```

   URL form: `steward://pair?v=1&id=stw1k7f…&a=192.168.1.20:4778,100.101.5.9:4778&t=u4…`
   plus an equivalent `https://steward.sh/pair#…` fallback that just renders instructions
   (fragment never sent to server).

2. On node B's UI: **Add node → Enter link** (or `steward pair <url>` in the CLI). B dials
   each address, runs the transport handshake (§4.3) **pinned to A's nodeId from the URL**
   — so a MITM is impossible — then sends `pair.request` carrying the token and B's peer
   record. A verifies the token (constant-time, single use, unexpired), marks B trusted,
   replies `pair.accept` with A's peer record and the current fleet roster.

### 3.2 Flow B — short numeric code (same room, typing not scanning)

For when you can see A's screen but can't paste a URL (fresh headless box, phone-less).

1. Node A UI shows: `Pairing code: 481-905` and its LAN addresses. Internally A calls
   `POST /api/pair/offer {"mode":"code"}` → 6-digit code, 2-minute TTL, max **3** failed
   attempts fleet-wide before the code is invalidated.
2. Node B: `steward pair --code 481905 [--host 192.168.1.20]`. Without `--host`, B mDNS-
   browses for pairable Steward nodes (§4.1) and tries each.

A 6-digit code cannot pin a pubkey, so the code authenticates the handshake instead of
the URL doing it. We use a **PAKE-style confirmation** over the already-established (but
not yet trusted) encrypted channel:

```
B → A  pair.request { mode:"code", peerRecord_B }
A → B  pair.challenge { saltA: 16B random }
both   K = argon2id(code, saltA, t=3, m=64MiB, p=1)         // code is low-entropy; argon2id
                                                             // makes offline guessing costly
B → A  pair.confirm  { mac: HMAC-SHA256(K, transcriptHash || "B") }
A → B  pair.accept   { mac: HMAC-SHA256(K, transcriptHash || "A"), peerRecord_A, roster }
```

`transcriptHash` = SHA-256 of the handshake transcript (§4.3), which includes both static
pubkeys — so a MITM who relayed the handshake has a different transcript on each side and
both MACs fail. Combined with 3 attempts / 2 minutes / argon2id, a 6-digit code is fine.
Failed attempt → 5 s delay before A answers the next `pair.request`.

### 3.3 Joining the fleet (both flows)

`pair.accept` carries the **roster**: every peer record A knows. B stores them all as
trusted (transitive trust — pairing with one node joins the whole fleet; this is a
single-user system, §10). B then gossips its own peer record, and every node learns of B
within one gossip round. A also pushes B's record proactively to its connected peers.

### 3.4 Unpairing / revocation

`DELETE /api/fleet/nodes/:nodeId` on any node publishes a signed **revocation** into
gossip:

```jsonc
{ "type": "revoke", "nodeId": "stw1…", "by": "stw1…", "sig": "…", "ts": 1755551111, "seq": 42 }
```

Every node that sees it drops the peer's trust, closes links, and remembers the
revocation forever (tombstone) so gossip can't resurrect the peer. Re-adding a revoked
machine requires it to generate a fresh identity (`steward identity reset`) and pair
again. Any fleet member may revoke any other — acceptable for a single-user fleet.

---

## 4. Transport

### 4.1 Listeners and discovery

- **Port 4777** (Hono HTTP + UI + local WS): binds `127.0.0.1` **only**. Never changes.
- **Port 4778** (fleet mesh): binds `0.0.0.0`. Speaks **only** the binary handshake
  below — it is not an HTTP server, has no unauthenticated surface beyond the handshake
  parser, and drops connections that don't complete the handshake in 10 s.
- **mDNS**: advertise `_steward._tcp.local` on port 4778 with TXT records
  `id=<nodeId> v=1 pair=<0|1>` (`pair=1` only while a pairing offer is live). Browse
  continuously; discovered addresses feed the dialer and the peer record's `addrs`.
  Implementation: a small pure-TS mDNS responder over Bun's `udpSocket` (multicast
  224.0.0.251:5353) — no native deps.

### 4.2 Mesh topology and dialing

- Every node tries to hold a direct link to **every** trusted peer (full mesh; fleets are
  ≤ ~20 nodes, so O(n²) links is trivial).
- Deterministic dial direction to avoid duplicate links: the node with the
  lexicographically **smaller** nodeId dials. The larger node still dials if it has seen
  no link for 60 s (covers NAT asymmetry); on crossed connects, keep the one initiated by
  the smaller nodeId, close the other.
- Address candidates per peer, tried in order: (1) current mDNS-discovered LAN address,
  (2) `addrs` from the peer record (includes tailscale/WireGuard IPs — these make WAN
  "just work" without Steward doing NAT traversal), (3) relay (§4.5).
- Reconnect with decorrelated jitter backoff: 1 s → cap 60 s. Heartbeat: transport-level
  `ping` every 15 s, drop link after 2 missed pongs (45 s).

### 4.3 Handshake (Noise-IK-style over WebSocket)

The dialer opens `ws://host:4778/` and the two sides exchange **binary** messages
(everything after the handshake is encrypted frames; JSON lives inside them, §5).

Notation: `sA/sB` static X25519 (derived §2.3), `eA/eB` ephemeral X25519,
`EdA/EdB` ed25519 static.

```
M1  dialer → listener:
    { proto:"steward/1", eA_pub, dst: listener_nodeId }            // plaintext CBOR
M2  listener → dialer:
    eB_pub,
    enc1 = AEAD(k1, listener_cert)         // k1 = HKDF(DH(eA,eB), "stw-hs-1")
M3  dialer → listener:
    enc2 = AEAD(k2, dialer_cert)           // k2 = HKDF(DH(eA,eB) || DH(eA,sB), "stw-hs-2")

cert  = { EdX_pub, sX_pub, sig: Ed25519-sign(EdX_priv, "stw-bind" || sX_pub || eX_pub || peer_e_pub) }
```

- The signature binds the static identity to this session's ephemerals → mutual auth +
  no unilateral replay.
- Session keys: `HKDF-SHA256(DH(eA,eB) || DH(eA,sB) || DH(sA,eB), "stw-sess", transcriptHash)`
  → `k_send`, `k_recv` (one per direction). Cipher: **XChaCha20-Poly1305** (libsodium
  `crypto_secretstream`), which handles nonces and rekeying-by-chunk for us.
- `transcriptHash = SHA-256(M1 || M2 || M3)` — this is the value the pairing code MAC
  (§3.2) signs over.
- **Trust check**: after M3 each side looks up the peer's `EdX_pub` in `trusted_peers`.
  Unknown peer + no live pairing offer → close with code `4403`. Unknown peer + live
  pairing offer → allow only `pair.*` messages until pairing completes.
- Why not TLS: no CA story for LAN nodes; self-signed cert pinning is just a worse
  version of this with x509 parsing attack surface. Why not raw Noise lib: the pattern
  above *is* Noise-IK in spirit; writing it with libsodium primitives (~150 lines) avoids
  a native dependency and keeps the transcript hash accessible for pairing.

### 4.4 Encrypted frame layer

After handshake, every WebSocket binary message is one secretstream chunk decrypting to:

```
[1 byte channel] [payload]
channel 0x00 = control (ping/pong/goodbye, CBOR)
channel 0x01 = rpc (JSON, §5)
channel 0x02 = relay (opaque forwarded ciphertext, §4.5)
channel 0x03 = bulk (blob transfer; length-prefixed binary, out of scope here — see BACKUP doc)
```

### 4.5 Relay (indirect connectivity)

If A cannot reach C directly but both reach B, A tunnels **end-to-end encrypted** traffic
through B. B forwards ciphertext it cannot read.

- A picks a relay: any connected peer whose peer record shows a live link to C
  (peer records gossip a `links: [nodeId]` list, §7). Prefer `machineClass:"server"`.
- A sends on channel `0x02`: `{ tunnelId, dst:"stw1…C", data:<bytes> }` (CBOR). B looks
  up its live link to C and forwards `{ tunnelId, src:"stw1…A", data }`. No multi-hop in
  v1: relay path length is exactly 1 (A→B→C); if no single relay works, C is offline
  from A's perspective. Multi-hop can come later without protocol changes (B applies the
  same rule recursively) but is disabled by a hop-count field fixed at 1.
- Inside the tunnel, A and C run the **full §4.3 handshake** (M1's `dst` routes it), so
  the relay sees only handshake metadata sizes and ciphertext. Same code path as a direct
  link — a `Link` object just has a different underlying "socket" (direct WS vs tunnel).
- Relay bandwidth is capped (default 10 MB/s per tunnel) and bulk channel `0x03` over
  relay is allowed (backups through a relay are a feature, not an accident).

---

## 5. RPC protocol

JSON frames on channel `0x01`. One protocol for node↔node **and** browser↔local-daemon
(the UI talks the same RPC over `ws://127.0.0.1:4777/ws`, minus the crypto — localhost
trust, see §10).

### 5.1 Frame schemas

```ts
type Frame = Hello | Req | Res | Err | Sub | SubOk | Event | Unsub | Cancel;

interface Hello {            // first frame in each direction after link-up
  t: "hello";
  proto: 1;                  // RPC protocol major version — mismatch → close 4505
  app: string;               // steward version, e.g. "0.3.1+gitsha"
  caps: string[];            // capability strings, e.g. ["git","docker","blobs","facets"]
  min: 1; max: 1;            // acceptable proto range; effective = min(max_A, max_B)
}

interface Req {
  t: "req";
  id: string;                // ulid, unique per sender per link
  m: string;                 // method, dot-namespaced: "fs.list", "git.status", "sys.info"
  p?: unknown;               // params (method-defined)
  deadline?: number;         // ms; receiver aborts work + sends Err "deadline" after this
}

interface Res  { t: "res";  id: string; ok: unknown }
interface Err  { t: "err";  id: string; code: ErrCode; msg: string; data?: unknown }
type ErrCode = "not_found" | "bad_params" | "unauthorized" | "unavailable"
             | "deadline" | "conflict" | "internal" | "no_route" | "canceled";

interface Sub {              // open a subscription (server-push stream)
  t: "sub";
  id: string;                // subscription id, ulid
  m: string;                 // topic method: "fleet.watch", "git.watchStatus", "task.stream"
  p?: unknown;
}
interface SubOk  { t: "subok"; id: string; snapshot?: unknown }  // initial state, then events
interface Event  { t: "ev";  id: string; ev: unknown; seq: number } // seq per-subscription, gap = resubscribe
interface Unsub  { t: "unsub"; id: string }                      // either side may send; receiver confirms by Event stop
interface Cancel { t: "cancel"; id: string }                     // abort in-flight Req
```

Rules:

- Every `Req` gets exactly one `Res` or `Err`. Every `Sub` gets `SubOk` or `Err`, then
  zero-or-more `Event`, terminated by `Unsub` from either side or link death.
- Link death implicitly cancels all in-flight requests (caller gets local
  `Err "unavailable"`) and all subscriptions (subscriber must resubscribe on reconnect —
  `SubOk.snapshot` makes resubscription self-healing).
- Backpressure: per-link outbound queue cap 8 MB; events on a slow subscription are
  **coalesced** where the topic supports it (state-shaped topics) or the subscription is
  dropped with `Err "unavailable"` (log-shaped topics). Never unbounded buffering.
- Versioning: `proto` majors gate the frame format. Method-level evolution is additive
  (new methods, new optional params). A method call the peer lacks → `Err "not_found"`,
  which the UI renders as "node X is on an older Steward" with its `app` version.

### 5.2 Method namespaces (registry)

Methods are registered in one table in code (`src/rpc/methods.ts`) with zod schemas for
params/result — the same registry serves local UI calls and remote calls:

```
sys.*     sys.info, sys.metrics, sys.update, sys.restart
fleet.*   fleet.roster, fleet.watch, fleet.setName, fleet.revoke, fleet.pairOffer
fs.*      fs.list, fs.stat, fs.read (size-capped), fs.watch
index.*   index.summary, index.query, index.rescan
git.*     git.status, git.log, git.stage, git.commit, git.push, git.pull, git.watchStatus
docker.*  docker.ps, docker.images, docker.compose*, docker.logs (sub)
task.*    task.list, task.run, task.stream (sub), task.cancel
vault.*   vault.* (ciphertext ops only — see VAULT doc)
```

Every handler receives `ctx = { caller: NodeId | "local-ui", link, deadline }`. Handlers
must not care whether the caller is local or remote (§6 depends on this).

---

## 6. Remote management = API proxying

**Definition:** from the web UI served by any node A, you can operate node C exactly as
if you had opened C's own UI. Concretely, two mechanisms:

### 6.1 RPC proxying (primary)

The UI addresses every RPC call with a node scope. Local WS frames from the browser get
an optional `dst`:

```jsonc
{ "t": "req", "id": "01J…", "dst": "stw1…C", "m": "git.status", "p": { "repo": "~/Code/Seed" } }
```

Node A's router: if `dst` is absent or self → dispatch to local handler; else look up
the live link to C (direct or via relay) and forward the frame verbatim (minus `dst`,
plus nothing — C sees a normal `Req` whose `ctx.caller` is A's nodeId). Responses route
back by `id`. No route → immediate `Err "no_route"` with `data:{lastSeen}` so the UI can
say "offline since Tuesday".

This is the whole feature: because local UI and remote peers speak the same RPC and every
handler is caller-agnostic, remote management costs one `dst` field and a router branch.

The UI's node switcher (top-left, per `docs/UX.md`) just sets the default `dst` for the
current view; fleet-wide screens (redundancy dashboard) fan out the same request to all
nodes with `Promise.allSettled` semantics and render per-node staleness.

### 6.2 HTTP proxying (escape hatch)

Some things want real HTTP: downloading a file from C, streaming a container log into a
new tab, serving C's raw UI. Node A exposes, on **localhost only**:

```
ANY /api/nodes/:nodeId/http/*  →  tunneled to C, replayed against C's 127.0.0.1:4777/*
```

Implementation: `m:"http.proxy"` RPC carrying `{method, path, headers (allowlist), body?}`
with chunked response events over a `Sub` for streaming bodies. C's Hono app processes it
as a normal request with header `x-steward-caller: <A's nodeId>`. Size cap 512 MB, then
use the bulk channel. This also gives us "open node C's full UI in a tab" for free:
`http://127.0.0.1:4777/api/nodes/stw1…C/http/` (C's UI assets proxied through A) — useful
when C is mid-upgrade and its RPC surface is older than A's UI expects.

### 6.3 Authorization

All fleet nodes are equal admins (single user). Authorization is binary: trusted peer or
not. There are no per-method ACLs in v1; the enum `ErrCode "unauthorized"` exists for the
localhost-UI auth described in §10 and for future multi-user.

## 7. Fleet state replication

### 7.1 What replicates

Two categories with different mechanics:

1. **Peer records** — single-writer, signed documents. Each node is the *only* writer of
   its own record. This is the backbone of the fleet UI and routing.
2. **Fleet settings** — small multi-writer KV (fleet display name, backup policy knobs,
   revocation tombstones). LWW-merged (§8).

Big data (file index detail, blobs) does **not** gossip. Peer records carry compact
**index summaries**; drill-down queries go live over RPC to the owning node (or return
`no_route` + cached summary when it's offline).

### 7.2 Peer record schema

```jsonc
{
  "v": 1,
  "nodeId": "stw1k7f3q2xa…",
  "seq": 812,                          // strictly increasing per node; the version
  "ts": 1755551234123,                 // wall clock, informational only
  "name": "erics-mbp",
  "machineClass": "laptop",
  "os": { "platform": "darwin", "release": "25.5.0", "arch": "arm64" },
  "app": "0.3.1+9f2c1e",
  "caps": ["git", "docker", "blobs", "facets"],
  "addrs": ["192.168.1.20:4778", "100.101.5.9:4778"],   // self-observed, tailscale included
  "links": ["stw1abc…", "stw1def…"],   // currently-connected peers (drives relay selection)
  "disk": { "totalBytes": 1000204886016, "freeBytes": 312000000000 },
  "indexSummary": {
    "generatedAt": 1755550000000,
    "repoCount": 297, "dirtyRepos": 41, "unpushedRepos": 17, "remotelessRepos": 9,
    "novelBytes": 182000000000,
    "atRiskBytes": 23400000000,        // novel data with redundancy < 2
    "rootHash": "b3:8fa4…"             // blake3 of the index manifest, for cheap diffing
  },
  "sig": "base64(ed25519 sig over canonical-json of all fields except sig)"
}
```

Canonicalization: JCS (RFC 8785). Records with bad signatures or `nodeId` not in
`trusted_peers` are dropped (except during pairing roster import, which trusts A's link).

The record is republished (seq++) on: any field change, index rescan completion, link
set change (debounced 5 s), and at minimum every 10 minutes as a liveness heartbeat.

### 7.3 Gossip algorithm

Simple anti-entropy, leveraging the (near-)full mesh — this is a ≤20-node fleet, not a
DHT:

- **Push**: when a node observes a new version (its own or relayed), it sends
  `gossip.push { records: [PeerRecord] }` to all connected peers **except** the one it
  came from. Duplicate suppression by `(nodeId, seq)`.
- **Pull / anti-entropy**: every 60 s, each node sends one random connected peer
  `gossip.digest { entries: [{nodeId, seq}] }` (its whole version vector — tiny).
  Receiver responds with records it has that are newer, and a digest-back of entries it
  is missing; sender pushes those. Two messages, converged.
- On link establishment: immediate digest exchange (so a returning laptop syncs in one
  round trip).
- Storage: `peer_records(node_id TEXT PRIMARY KEY, seq INTEGER, record JSON, sig BLOB,
  received_at INTEGER)` — plus `trusted_peers(node_id TEXT PRIMARY KEY, added_at, added_via,
  revoked_at INTEGER NULL, revoked_by TEXT NULL)`.

Convergence: with full mesh, push alone converges in one hop; the pull loop exists for
partitioned/relay topologies and missed frames. Eventual consistency window in practice:
< 1 s connected, ≤ 60 s after heal.

### 7.4 Fleet settings replication

`fleet_kv(key TEXT PRIMARY KEY, value JSON, hlc TEXT, writer TEXT, sig BLOB)`.
Same push/digest transport (`gossip.push` carries an optional `kv` array). HLC =
hybrid logical clock string `"<unixMs>-<counter>-<nodeId>"`, compared lexicographically
after zero-padding — see §8.

## 8. Conflict rules

Kept deliberately boring:

1. **Peer records: no conflicts by construction.** Single writer, `seq` monotonic. If two
   records for one nodeId claim the same `seq` with different content (restored-from-
   backup identity, cloned key), higher `ts` wins and the node surfaces a loud warning
   ("node identity may be duplicated — reset identity on the clone"). Cloned identities
   are user error we detect, not support.
2. **Fleet KV: LWW by HLC**, tie-broken by writer nodeId (lexicographic). Every write
   bumps the local HLC to `max(local, seen)+1`, so causally-later writes always win over
   anything they've seen; concurrent writes resolve deterministically and identically on
   every node. Acceptable because fleet KV is small, human-driven, low-frequency.
3. **Revocation tombstones always win** over any peer record for the revoked nodeId,
   regardless of seq/ts. Tombstones are permanent rows, replicated in fleet KV under
   `revoked:<nodeId>`.
4. **No replicated counters, no merged lists.** Anything that would need a CRDT beyond
   LWW (e.g. shared task queues) is instead *owned* by one node and accessed live via
   RPC. Redundancy scoring is computed locally by each node from the set of peer index
   summaries — a pure function of replicated inputs, so no conflicts to resolve.

## 9. Offline nodes

- A peer is **online** (live link, direct or relayed), **reachable-stale** (no link, but
  another peer's record `links` includes it → relay likely), or **offline** (no path).
  Every peer row in the UI shows `lastSeen` (last valid record `ts` received) with
  staleness tiers: fresh < 15 min, stale < 24 h, cold ≥ 24 h (amber), missing ≥ 14 days
  (red, "consider revoking or checking on this machine").
- **Reads about** an offline node: served from its last replicated peer record, always
  labeled with `lastSeen`. Drill-down RPC returns `Err "no_route"`; UI shows cached
  summary + offline banner.
- **Writes to** an offline node: fail fast with `no_route`. **No offline command queue in
  v1** — queued imperative ops (commit this, restart that) executing hours later are a
  footgun. The exceptions are *declarative* systems that reconcile on reconnect by
  design: backup placement (the backup planner re-evaluates when a node returns) and
  facet convergence (the node converges itself against replicated desired state). Rule:
  offline coordination is only allowed for desired-state systems, never for one-shot
  commands.
- A node that was offline reconnects → handshake → digest exchange → fully current in
  one round trip; its own record's `seq` catches everyone up on what changed on it.

## 10. Security posture

- **Never expose the daemon port.** `127.0.0.1:4777` binds loopback only, non-
  configurable. Port 4778 is exposed but speaks only the handshake; every byte after M1
  is authenticated+encrypted, unknown peers are dropped unless a pairing offer is live,
  and the pre-auth parser is ~200 lines of length-checked CBOR (fuzz it in CI).
- **All remote access = authenticated channel.** There is no auth token, no TLS cert, no
  reverse-proxy mode. Remote UI access to node C is "open any fleet node's UI and proxy"
  (§6) — the WAN story is tailscale/WireGuard addresses in `addrs`, which BRIEF names as
  the intended connectivity layer. Steward never does its own WAN hole-punching in v1.
- **Localhost UI trust:** v1 trusts localhost (single-user machine), with two mitigations:
  strict CORS (only `http://127.0.0.1:4777` origin; WS upgrade rejects browser origins
  that don't match, which blocks drive-by websites hitting the local API), and CSRF-safe
  design (no state-changing GET). A per-install browser session token
  (`~/.steward/ui-token`, injected by the CLI `steward open`) is a fast-follow.
- **Key hygiene:** `node.key` is `0600`, excluded from Steward's own backup indexing by
  hardcoded rule (identity must not replicate — that's how clones happen). Vault master
  key material never touches this layer; the fleet moves vault **ciphertext** only.
- **Relay honesty:** relays carry end-to-end encrypted tunnels (§4.5) — a compromised
  relay node can drop or delay traffic, not read or forge it.
- **Blast radius of one stolen machine:** its key is a full fleet admin (single-user
  model). Mitigation is revocation (§3.4) from any surviving node, which propagates as a
  tombstone. Disk-level protection of `~/.steward` is delegated to FileVault/LUKS.
- **Downgrade safety:** `proto` in `hello` is exchanged inside the encrypted channel;
  version negotiation cannot be tampered by a network attacker.

## 11. File layout (fleet subsystem)

```
src/fleet/
  identity.ts        // keygen, load, nodeId encode/decode, ed→x25519 derivation
  handshake.ts       // §4.3 state machine (pure: bytes in/out, no IO)
  link.ts            // Link: socket|tunnel + secretstream + channels + heartbeat
  mesh.ts            // dial policy, reconnect/backoff, link table, relay selection
  relay.ts           // channel 0x02 forwarding + tunnel client
  mdns.ts            // responder + browser (pure TS over Bun udpSocket)
  pairing.ts         // offers, code MAC flow, roster import  (§3)
  gossip.ts          // peer records, digests, fleet KV, HLC  (§7–8)
  router.ts          // RPC frame router incl. dst forwarding  (§5–6)
  httpProxy.ts       // §6.2
src/rpc/
  frames.ts          // zod schemas for Frame union (§5.1)
  methods.ts         // method registry: name → {params, result, handler, topic?}
```

`handshake.ts` and `gossip.ts` merge/conflict logic are pure functions → unit-testable
without sockets; `mesh.ts` integration-tested by spawning 3 daemons on ephemeral ports in
Bun's test runner.

## 12. Open questions (deliberately deferred)

- Multi-hop relay (protocol-ready via hop count, disabled in v1).
- Per-method ACLs / guest nodes (needs multi-user story first).
- NAT traversal without tailscale (STUN/ICE) — revisit only if tailscale-style overlay
  proves insufficient.
