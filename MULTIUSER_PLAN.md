# Multi-User Refactor Plan

Status: Planning. Not yet implemented. Author: AI-assisted planning 2026-08-16.

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

### Phase 5 - Tests
- Unit: registry persistence, per-user key decryption, FORCE_SERVER rejection,
  MAX_USERS saturation, logout-wipe isolation, IP ban escalation and
  un-banning.
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
- Enrollment secrets: SHA256-derived CSR password (`auth.py:64-67`) stays
  per-user (salt-derived).
- `verify=False` on the enroll HTTPX client (`auth.py:306`): tighten via a CA
  bundle env var later; not a blocker.

## Extra suggestions

- Login should attempt a Fernet decrypt before declaring success
  (proof-of-possession) - also a poison-check on corrupted stores. The key is
  already derived from the password in `verify_credentials`; keep that
  invariant.
- Global asyncio lock around the user store so two enrollments cannot race.
- Per-user logger context (e.g. "user 'joe' connected to TAK Server") - cheap,
  very useful once N people are on it.
- Geochat contacts/threads already live on `TAKClient`
  (`tak_client.py:106-108`); they become per-user for free.
- No permission model today (any logged-in user can fetch most things). When
  shared, consider read-only guests vs. enrolled users. Not required now.
- Multiserver later: add a `server` key to the WebSocket broadcast scope and
  the frontend entity/chat state; the `(server, user)` pool makes it a
  scoping exercise, not a rewrite.