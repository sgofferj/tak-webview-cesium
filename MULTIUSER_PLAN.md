# Multi-User Refactor Plan

Status: Planning. Not yet implemented. Author: AI-assisted planning 2026-08-16.

**Approved mods (2026-08-18):** all "Extra suggestions" below are approved
**except** the permission model, which is rejected - permissions are configured
centrally on the TAK server via `<group>_READ`/`<group>_WRITE` membership, so no
client-side permission model is needed. A new **Phase 5 - Provisioning API** is
added for deployment systems (PVARKI Deploy App / Rasenmaeher, others) to create
and remove enrolled users ("fake enrollments"), including cert auth against a
deployment CA with CRL-based pre-flight revocation checks (CRL fetched live from
each cert's `CRLDistributionPoints` URL). **Cert-auth web login** is approved:
`AUTH_MODE=both` (default) auto-authenticates users who present a valid client
cert, with the password login form as fallback; the cert source is flexible so
it works behind haproxy and behind other/PVARKI TLS terminators.

## Goal

The backend runs somewhere and multiple users can enroll, upload certs, or
(logged-in, known users) connect from anywhere. Each user's credentials and
keys are handled securely. Optional limits:
- `MAX_USERS` - cap on registered users
- `MAX_SERVERS` - cap on distinct TAK server connections
- `FORCE_SERVER` - pin a single server; hides the server field in the
  enrollment dialog and rejects enroll/upload for any other server

Scope recommendation: **multiuser-singleserver now, multiserver later.**
The client pool is keyed by `(server, user)` from day one so multiserver is
only a scoping exercise later, not a rewrite.

## Verdict up front

- **Multiuser-singleserver is very achievable and low-risk.** The mTLS
  lifecycle, CoT->WebSocket pipeline, geochat, and keepalives are intact; the
  blockers are process-global singletons, not the network code.
- **Multiserver is a rabbit hole, defer it.** The hard part is not running N
  TAK clients, it is *data scoping*: each server yields its own tactical
  feed/chat/contacts, so every entity, thread, and WebSocket broadcast must be
  namespaced per server and the frontend state partitioned per server. Roughly
  doubles the refactor.

## What is blocking today

1. `settings` is a mutable process-global (`config.py:185`); runtime identity
   (`tak_callsign_input/color/role`) is written into it (`main.py:295-297`,
   `tak_client.update_config:961-976`). One user changing callsign overwrites
   everyone; `reset_messaging_config()` (`main.py:256`) mutates it too.
2. `auth_manager` is a singleton with a single cred/cert set (`auth.py:31-41`):
   one `ephemeral_dir`, one `creds_file`, one RAM `_storage_key`. Cannot hold
   two users.
3. `tak_client` is one singleton instance (`tak_client.py:979`) bound to the
   global `settings`, mutating `self.config` at runtime. One connection = one
   TAK identity.
4. `messaging_config` is a process-global dict (`main.py:253`).
5. `tracker.active` drives `tak_client.stop()` globally (`main.py:392-394`);
   one logout can tear down everyone's connection.
6. `ConnectionManager.broadcast()` sends to every WebSocket
   (`connection.py:36-41`) - fine for one server, wrong once two exist.
7. UID is derived from callsign (`config.py:179-182`, embedded in the CSR at
   `auth.py:357`). Two users with the same default callsign collide as TAK
   identities.
8. `is_enrolled()`/`auth_status` describe the *installation's* enrollment; the
   backend only ever verifies against that one record.

## Target architecture

Three layers in `backend/app/`:

### `users.py` (new)
- `UserRegistry` - on-disk per-user storage under
  `ephemeral_dir/users/<username>/` (key/cert/ca/creds per user).
- `UserAccount` - holds hash+salt+server+encrypted key blob (never plaintext).
- `UserSession` - short-lived object holding the decrypted Fernet storage key
  **in RAM only** for a logged-in user.
- Enforces `MAX_USERS`.
- `AuthManager`'s crypto moves here (PBKDF2, Fernet derivation, P12 parsing,
  enrollment). The crypto is unchanged - only the 1-record store becomes
  N records.

### `clients.py` (new)
- `ClientPool` - owns `TAKClient` instances keyed by `(server, username)`,
  capped by `MAX_SERVERS`/`MAX_USERS`.
- Auto-starts/stops per user based on a per-user session roster (per-user web
  session counts), replacing the global tracker -> stop coupling.

### `TAKClient` refactor
- Takes a per-user `Identity` (uid, callsign, color, role, server,
  staff_comments) instead of the global `settings`.
- Receives its private key via callback `get_private_key(user)` instead of
  `auth_manager.get_private_key()` with no args (`tak_client.py:141`).
- Networking/CoT/chat code inside is unchanged.

Session flow: login maps `sid -> username` server-side (rotate sid on login -
partially done). `SessionMiddleware` stays. Each authed request/WebSocket
resolves its user via the sid.

## Phased plan

### Phase 1 - Model (no behavior change)
- Add `users.py` with `UserRegistry`/`UserAccount`/`UserSession`; move the
  crypto from `auth.py`.
- Refactor `AuthManager` to delegate to the registry; keep public method names
  so `main.py`/`tak_client.py` barely move.

### Phase 2 - Global identity -> per-user session
- `auth_status` returns user-scoped info; `auth_login` authenticates against
  the registry, creates a `UserSession` (RAM key), returns `username`.
- `logout` = drop this user's session + stop *their* TAK client if idle.
- `logout-wipe` = only delete the logged-in user's records (today it wipes the
  whole install - dangerous once shared).
- Bind `messaging_config` to the session.
- Frontend: key `messagingConfig` localStorage by username; show logged-in
  callsign.

### Phase 3 - Per-user TAK clients
- Introduce `Identity` dataclass; `TAKClient(identity, key_provider)`.
- `ClientPool.start(user)`/`.stop(user)`; replace `tracker.active ->
  tak_client.stop()` coupling (`main.py:392-394`, `connection.py`) with
  per-user session counting.
- **Distinct per-user UID** derived from cert CN/username, stable per
  enrollment, replacing the callsign-derived UID (`config.py:179-182`).
- `websocket_endpoint` resolves sid -> user and talks to *that user's* client;
  `chat_init`/`send_chat` become per-user.

### Phase 4 - Limits, ops env, and abuse protection
- `MAX_USERS`, `MAX_SERVERS`, `FORCE_SERVER` in `config.py`.
- FORCE_SERVER: hide server field in UI (frontend config) *and* reject
  enroll/upload where `server != FORCE_SERVER` backend-side, before any crypto
  work.
- Rate limiting on `/api/auth/enroll`, `/upload-p12`, `/login`.
- **IP banning with increasing ban time on failed enrollment and failed
  logins:**
  - Track failures per IP in a RAM table: `ip -> {failures, blocked_until}`.
  - On N consecutive failures, ban the IP for an escalating window (e.g.
    first ban 5 min, double each subsequent ban up to a cap like 24 h).
  - Apply to both `/api/auth/enroll` and `/api/auth/login` (and optionally
    `/upload-p12`).
  - Return 429 (or 403) while blocked; the ban time is a suggestion in the
    response/logs.
  - Ban table is bounded (LRU) to avoid unbounded RAM growth.
  - Note: behind haproxy, trust `X-Forwarded-For` only for
    `trusted_proxies` (config already exists, `config.py:58`); otherwise
    derive from the socket peer.
  - Consider combining with`failed_attempts` logic already in `auth.py`.

### Phase 5 - Provisioning API + cert auth / CRL

Deployment-driven "fake enrollments": let deployment systems (PVARKI Deploy App
/ Rasenmaeher, others) create and remove enrolled users by pushing certs and
creating logins, without interactive enrollment or P12 upload.

**Separate port for firewalling:**
- A second FastAPI app `provisioning_app` on its own `PROVISION_PORT`
  (default e.g. 8100), served by a second uvicorn instance in the same process
  as the main app (or a separate container entrypoint). It shares the
  `UserRegistry` in-process.
- Default bind to `127.0.0.1` so it is unreachable unless the deployment
  explicitly binds it and opens the firewall. The separate port is
  defense-in-depth, not the only auth.
- Auth: `PROVISIONING_TOKEN` env var required via `Authorization: Bearer`
  (or `X-API-Key`); reject with 401 otherwise. Token is never logged.

**Endpoints:**
- `POST /v1/users` - create/replace an enrolled user. Accepts `username`,
  `password` (login), `server`, and client cert + private key (PEM), a `.p12`,
  or a base64 blob. The webview derives the storage key, encrypts the key at
  rest, and stores per-user records. No TAK server interaction - the cert must
  already be issued by a CA the TAK server trusts. Enforces `MAX_USERS` and
  `FORCE_SERVER` before any crypto work.
- `DELETE /v1/users/{username}` - remove the user: delete their records, stop
  *their* TAK client, drop their active web sessions. Never touches other
  users' data (logout-wipe isolation).
- `GET /v1/users` / `GET /v1/users/{username}` - metadata only (username,
  server, cert CN, cert expiry/status); never returns keys, hashes, or blobs.

**"Fake enrollment" semantics:** no `enroll()`/`signClient` call. The deploy
system already obtained certs from the deployment CA; the webview ingests them.
On the TAK side, cert-auth mode maps the cert CN -> username, so the TAK server
accepts the user without enrollment.

**Cert auth against a deployment CA + CRL pre-flight:**
- The CA cert lives on storage (`ca.pem` per user or a shared `CA_CERT`), used
  both for `_get_ssl_context()` server verification and to validate the user's
  own client cert chain (`cert.verify_directly_issued_by(ca)` in
  `cryptography.x509`).
- Revocation is checked **pre-flight in the webview**: at login (and again
  before a user's TAK client starts), fetch the CRL live from the cert's
  `CRLDistributionPoints` URL via httpx, and compare the cert serial against
  the revoked list (`x509.load_pem_x509_crl`). Cache per-CA CRLs in a bounded
  TTL cache honoring `nextUpdate`.
- Revoked serial -> refuse login with 401 ("certificate revoked"). Fetch
  failure policy is configurable (`CRL_MODE`); default: warn + fail open on
  fetch errors, because the TAK server remains the **authoritative** gate - the
  deployment must configure the TAK server truststore with the CA and enable
  CRL checking there.

**Cert-auth web login (`AUTH_MODE`):**
- `AUTH_MODE=both` (default): users presenting a valid client cert are
  auto-authenticated (no login form); users without a cert see the existing
  password login. `AUTH_MODE=cert` hides login/enroll/upload entirely and
  rejects password login; `AUTH_MODE=password` is today's behavior.
- **Flexible cert source** - topology-agnostic, because deployments differ
  (self-hosted behind haproxy vs. PVARKI's stack):
  1. **Reverse-proxy mTLS + trusted header:** the TLS terminator (haproxy,
     nginx, or whatever PVARKI uses) requires the client cert, validates it
     against the deployment CA, and forwards the verified CN via
     `X-SSL-Client-CN` + `X-SSL-Client-Verify: SUCCESS`. The backend reads
     these headers **only when the direct peer is in `trusted_proxies`**
     (reuse `config.py:59`), with configurable header names.
  2. **Uvicorn-native mTLS:** uvicorn terminates TLS itself
     (`ssl_certfile`/`ssl_keyfile`/`ssl_ca_certs`/
     `ssl_cert_reqs=ssl.CERT_REQUIRED`); the client cert is read from the ASGI
     scope SSL socket (`scope["ssl"].getpeercert()`).
  - Resolution order: trusted-proxy headers first, then ASGI scope; both are
    ignored when no cert was presented. This needs no haproxy on PVARKI's side.
- Auto-login flow: resolve CN -> `UserRegistry` lookup -> CRL pre-flight ->
  create session (sid rotation, `tracker.register`) - identical to a successful
  password login. Unknown or revoked cert -> 403, no login offered.
- **Key asymmetry:** the browser cert proves identity to the webview, but the
  webview needs a *private key* to connect to the TAK server. The deploy app
  therefore pushes a copy of the user's cert **plus encrypted key** via the
  provisioning API; browser cert and stored cert share the same CN. Stored key
  stays Fernet-encrypted at rest, RAM-only per session (memfd, Phase 3).
- Frontend: in `cert` mode hide login/enroll/upload; in `both` mode show the
  login form but auto-login when a cert is presented.
- Note: cert auth governs both the web session and the TAK connection; the
  browser/web session no longer relies on passwords when a cert is presented.

### Phase 6 - Tests
- Unit: registry persistence, per-user key decryption, FORCE_SERVER rejection,
  MAX_USERS saturation, logout-wipe isolation, IP ban escalation and
  un-banning.
- Provisioning API: create/delete/list round-trips, 401 without token,
  MAX_USERS/FORCE_SERVER enforcement, cross-user isolation on delete.
- Cert auth / CRL: chain validation against the CA, revoked serial blocks
  login, CRL fetch-failure policy.
- Cert-auth web login: auto-login from trusted-proxy header, header ignored
  from non-trusted peers, ASGI-scope cert path, unknown/revoked cert -> 403,
  `AUTH_MODE=both` fallback to password.
- Keep existing `test_cot_parsing.py` green (it builds `TAKClient(config)` -
  keep that constructor working or adapt).

## Security requirements (non-negotiable)

- Passwords: never stored or logged; PBKDF2 hash + per-user salt stays.
- Keys: Fernet-encrypted at rest in each user's dir; decrypted only into RAM
  per active session; memfd for the SSL chain (`tak_client.py:149-167`) keeps
  working per connection.
- Sessions: sid rotated on login; `SessionMiddleware` unchanged; sid-to-user
  map authoritative, RAM only.
- logout-wipe isolation: must never delete other users' data.
- Provisioning API: token-only auth, `PROVISION_PORT` bound to `127.0.0.1` by
  default, token never logged; remove-user stops only that user's client.
- CRL: cached in RAM only; the TAK server truststore + CRL config (deployment
  responsibility) is the authoritative revocation enforcement layer.
- Cert-auth web login: `X-SSL-Client-*` headers trusted only from
  `trusted_proxies` (no spoofable CN from arbitrary clients); unknown or
  revoked cert -> 403; password path still rotates sid on login.
- Enrollment secrets: SHA256-derived CSR password (`auth.py:64-67`) stays
  per-user (salt-derived).
- `verify=False` on the enroll HTTPX client (`auth.py:306`): tighten via a CA
  bundle env var later; not a blocker.

## Extra suggestions (status: approved 2026-08-18 unless noted)

- [x] Login should attempt a Fernet decrypt before declaring success
  (proof-of-possession) - also a poison-check on corrupted stores. The key is
  already derived from the password in `verify_credentials`; keep that
  invariant.
- [x] Global asyncio lock around the user store so two enrollments cannot race.
- [x] Per-user logger context (e.g. "user 'joe' connected to TAK Server") -
  cheap, very useful once N people are on it.
- [x] Geochat contacts/threads already live on `TAKClient`
  (`tak_client.py:106-108`); they become per-user for free.
- [x] Multiserver later: add a `server` key to the WebSocket broadcast scope
  and the frontend entity/chat state; the `(server, user)` pool makes it a
  scoping exercise, not a rewrite.
- [~] No permission model today (any logged-in user can fetch most things).
  **NOT approved.** Permissions are configured centrally on the TAK server via
  `<group>_READ`/`<group>_WRITE` membership; no client-side permission model is
  required or desired.