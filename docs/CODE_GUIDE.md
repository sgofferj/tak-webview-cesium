# CODE_GUIDE.md — Functional & Architecture Guide

**Project:** tak-webview-cesium
**Audience:** Auditors and new developers
**Scope:** Complete functional description of the codebase as of August 24, 2026
(branch `feat/channel-selection`, commit `bfa9edd`).

Licensed under the GNU General Public License V3 or later.
(C) 2026 Stefan Gofferje

---

## Table of Contents

1. [What this application is](#1-what-this-application-is)
2. [High-level architecture](#2-high-level-architecture)
3. [Feature overview](#3-feature-overview)
4. [Code map — where to find what](#4-code-map--where-to-find-what)
5. [Backend modules in detail](#5-backend-modules-in-detail)
6. [Frontend modules in detail](#6-frontend-modules-in-detail)
7. [Data flow walkthroughs](#7-data-flow-walkthroughs)
8. [Security model](#8-security-model)
9. [Configuration reference](#9-configuration-reference)
10. [Tests and tooling](#10-tests-and-tooling)

---

## 1. What this application is

tak-webview-cesium is a browser-based TAK (Team Awareness Kit) client. It
connects to a TAK Server over mTLS, streams Cursor-on-Target (CoT) events,
renders all tactical entities ("atoms") on a CesiumJS 3D globe, and provides
full geochat (ATAK-compatible `b-t-f` messaging) with contacts, rooms,
delivery/read receipts, and TAK Server channel (group) subscription
management.

It is a two-part application:

| Part     | Technology                                        | Role                                                        |
| -------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Backend  | Python 3.11, FastAPI, Poetry                      | TLS/CoT connectivity to TAK Server, auth/enrollment, cert vault, WebSocket hub, Marti REST proxy |
| Frontend | Vite (Vanilla JS ES modules), CesiumJS, milsymbol | Map rendering, entity lifecycle, chat UI, auth/config UI    |

The backend serves the built frontend as static files; there is exactly one
origin and one port (default 8000). The browser never talks to the TAK Server
directly — everything goes through the backend.

### Design philosophy: "Never-Unencrypted-on-Disk"

Private keys are Fernet-encrypted at rest with a key derived from the user's
password (PBKDF2-SHA256, 100k iterations). Decrypted keys exist **RAM only**
and are fed to OpenSSL via Linux `memfd` file descriptors — never written to
disk unencrypted. All user data lives under an ephemeral directory and is
wiped on logout-with-wipe, after three failed logins, or when a certificate
expires.

---

## 2. High-level architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│  index.html + main.js                                           │
│  ├── viewer.js   (Cesium viewer, imagery, terrain, overlays)    │
│  ├── state.js    (entity state manager, filters, unit list)     │
│  ├── chat.js     (chat panel UI)                                │
│  ├── websocket.js (WS client, msgpack decode)                   │
│  └── config.js / utils.js / i18n locales                        │
└─────────────▲──────────────────────────────▲────────────────────┘
      HTTP REST (JSON)              WebSocket (/ws, msgpack+JSON)
│             │                              │                    │
┌─────────────▼──────────────────────────────▼──────────────────┐ │
│ FastAPI app — backend/app/main.py                             │
│  ├── auth.py        enrollment, P12 import, login, RAM keys   │
│  ├── users.py       per-user registry, PBKDF2/Fernet crypto   │
│  ├── clients.py     ClientPool: one TAKClient per user        │
│  ├── tak_client.py  CoT stream, keepalive, geochat, receipts  │
│  ├── connection.py  WS hub (per-user routing) + SessionTracker│
│  ├── groups.py      Marti REST proxy (channel subscriptions)  │
│  └── layers.py / iconsets.py / config.py                      │
└─────────────▲──────────────────────────────▲────────────────────┘
              │ mTLS TCP :8089               │ mTLS HTTPS :8443 (Marti API)
              ▼                              ▼
        TAK Server 5.x  ◄──── enrollment API :8446 (TLS)
```

### Core runtime rules

- A user's TAK client starts **only** after the user confirms their messaging
  configuration (callsign/color/role) in the config overlay — not at login.
- It stops automatically when the user's last web client (browser tab)
  disconnects (`main.py` websocket `finally` block → `pool.stop_user`).
- Each registered user gets their own TAK connection and a distinct UID
  derived from a SHA-256 hash of the username (`users.py: uid_for_username`),
  so multiple users on one install appear as separate clients on the TAK net.

---

## 3. Feature overview

### Authentication & identity
- **Automated enrollment** against the TAK Server TLS enrollment API
  (port 8446): RSA keypair + CSR, server-signed certificate, optional
  server-pushed device profile (callsign/color/role) used to prefill the
  messaging config popup.
- **Manual `.p12` upload**: CN becomes the username; insecure passwords are
  detected and force re-encryption with a strong new password.
- **Login** for already-enrolled users; 3 failed attempts wipe that user's
  records.
- **Single-server pinning**: `FORCE_SERVER` env var or first successful
  enrollment/upload pins the install to one TAK Server; mismatches are
  rejected backend-side.
- **Logout vs. logout-and-forget**: logout keeps certificates but drops RAM
  keys; "forget" wipes only the logged-in user's data.

### Visualization
- CesiumJS 3D globe with configurable base maps (WMS, XYZ/TMS, ArcGIS
  MapServer), custom terrain provider, elevation exaggeration, dark-map
  detection, and elevation contours (dark map + terrain only).
- MIL-STD-2525 symbols rendered via milsymbol; team-color circle icons for
  SA entities carrying `__group`; iconset support (`iconset.xml` sets from
  `/iconsets` and `/app/user_iconsets`); explicit SIDC override from
  `__milsym`/`__milicon` details.
- Per-entity: callsign label (toggleable), motion trail, course/speed arrow,
  info box with MGRS, contact info, battery gauge, squawk emergency labels,
  clickable hashtags, external links.
- Filters: free text, affiliation, dimension; zoom-dependent label visibility;
  camera-tilt-aware display conditions; "Zoom to All" with outlier exclusion;
  stale-entity cleanup (stale + 120 s grace).
- Local file overlays (GeoJSON/KML/CZML from `/app/overlays`) with
  right-click style editor (color, line style, width, fill, transparency),
  polygon outlines drawn as separate polylines, geographic-center polygon
  labels via `Rectangle`.
- Own-location marker: pick on map or browser geolocation, persisted per
  user, pushed into the TAK SA position report.

### Messaging (geochat)
- Full ATAK 5.8 wire-format `b-t-f` chat: rooms and DMs (DMs carry
  `<marti><dest uid=.../></marti>` so the server routes them 1:1).
- Thread history (bounded ring buffers, RAM only), contacts tracked from
  live SA traffic, system room auto-creation ("All Chat Rooms", per team
  color, per role), unread badges, optimistic send with deduplication.
- Delivery (`b-t-f-d`) and read (`b-t-f-r`) receipts with ✓/✓✓ UI, mirrored
  `__chatreceipt` construction, automatic delivery receipt on receive and
  read receipt when viewing a thread.
- `t-x-d-d` delete handling removes entities AND their contacts/DM threads.

### Channels (TAK Server group subscriptions)
- Status-bar "Channels" popup lists the user's entitled TAK Server groups
  with merged IN/OUT subscription state (one checkbox covers both).
- Backend proxies the Marti group REST API over mTLS using the user's own
  certificate: `GET /Marti/api/groups/user` and absolute-set
  `PUT /Marti/api/groups/active`.

### Platform features
- Multi-user single-server operation: per-user certs, sessions, identities,
  chat state; fully isolated logout/wipe.
- i18n: English, German, Swedish, Finnish (browser-language detection).
- Configurable branding (title, logo, position), GoTo quick-nav buttons,
  Zulu clock, session persistence (camera/filters/layers in localStorage),
  health endpoint excluded from access logs, MessagePack + per-entity
  throttling for frontend traffic optimization, staff-comment highlighting.

---

## 4. Code map — where to find what

### Repository layout

```
backend/
  pyproject.toml          Poetry deps + ruff/mypy/pylint/pytest config
  main.py                 Container entrypoint (uvicorn)
  app/
    main.py               FastAPI app: routes, websocket, lifespan
    config.py             Pydantic Settings (env vars), validators
    auth.py               AuthManager: enroll/upload-p12/login/wipe, RAM sessions
    users.py              UserRegistry: per-user storage, PBKDF2/Fernet helpers
    tak_client.py         TAKClient: CoT stream, keepalive, parsing, geochat
    clients.py            ClientPool keyed by (server, username)
    connection.py         ConnectionManager (WS hub) + SessionTracker
    groups.py             Marti group REST proxy (channels)
    layers.py             customlayers.json loader, WMS extent discovery
    iconsets.py           iconset.xml scanner/cache
  tests/
    conftest.py           Shared fixtures (tmp ephemeral dir, settings)
    test_config.py        Settings/env validation
    test_cot_parsing.py   CoT XML -> dict parser tests
    test_users.py         Registry/crypto primitives
    test_clients.py       ClientPool behavior
    test_multiuser.py     Multiuser isolation scenarios
    test_server_pinning.py FORCE_SERVER / pin semantics
    test_chat_roundtrip.py Chat parse/build roundtrips
    test_chat_receipts.py b-t-f-d / b-t-f-r receipt handling
    test_groups.py        Channel entitlement reduction + PUT body building
frontend/
  index.html              Single-page shell: auth overlay, sidebar, status bar,
                          chat panel, modals (~1675 lines of markup + CSS)
  main.js                 Bootstrap, auth UI flows, config overlay, channels
                          popup, layer picker, own-location picker
  state.js                Entity state machine, visibility/filters, unit list,
                          staff comments, stale sweep
  viewer.js               Cesium init, imagery/terrain providers, overlays,
                          contour analysis
  chat.js                 Chat panel: threads, contacts, receipts, send
  websocket.js            WS client, msgpack decode, reconnect
  config.js               /config fetch, i18n loading, static translations
  utils.js                CoT->SIDC mapping, MGRS, icons, throttle
  public/locales/*.json   en/de/sv/fi translations
  iconsets/               Bundled MIL-STD-2525 iconsets (mounted at /iconsets)
customlayers.json         Sample custom map-source config
Dockerfile                Two-stage build: node (vite build) -> python runtime
MULTIUSER_PLAN.md         Deferred multiserver design notes
```

### Quick lookup table

| I need to change/find…                        | Go to |
| --------------------------------------------- | ----- |
| An HTTP endpoint                               | `backend/app/main.py` |
| Env var handling / valid colors & roles        | `backend/app/config.py` (`Settings`) |
| Enrollment flow (CSR, signClient, profile zip) | `backend/app/auth.py: enroll()`, `_fetch_enrollment_profile()` |
| P12 import / password hardening                | `backend/app/auth.py: upload_p12()` |
| Key encryption / RAM-only decryption           | `backend/app/users.py` (crypto), `auth.py: get_private_key()`, `tak_client.py: build_ssl_context_for_user()` |
| Login rules (3-strike wipe)                    | `main.py: auth_login()` + `auth.py: record_failed_login()/wipe_user()` |
| CoT wire parsing (XML → dict)                  | `tak_client.py: parse_cot()` |
| Keepalive/ping/dead-link timers                | `tak_client.py: _heartbeat_loop()` (RX_STALE/PING_INTERVAL/RX_DEAD constants) |
| Outgoing CoT events (SA, ping, self-delete)    | `tak_client.py: _build_sa_event/_build_ping_event/_build_self_delete_event` |
| Chat wire format (b-t-f build/parse)           | `tak_client.py: _build_chat_event/parse_chat` |
| DM 1:1 routing (`<marti><dest>`)               | `tak_client.py: _build_chat_event` (is_dm branch) |
| Receipts (✓ / ✓✓)                              | `tak_client.py: parse_receipt/_extract_receipt_mirror/_build_receipt_event/send_chat_read`; frontend `chat.js: handleChatReceipt/statusCheckmark/signalReadForThread` |
| Contact registry (live users list)             | `tak_client.py: _update_contact` (+ run loop atom branch) |
| t-x-d-d entity/contact deletion                | `tak_client.py: _parse_delete/_apply_delete`; frontend `state.js: removeEntity`, `chat.js: handleCotDelete` |
| Channel (group) subscription                   | `backend/app/groups.py`; endpoints in `main.py: list_channels/update_channels`; frontend `main.js` "Channel Selection Popup" section |
| Per-user TAK client lifecycle                  | `clients.py` + `main.py: _start_user_client/set_messaging_config` |
| WS hub & per-user message isolation            | `connection.py: ConnectionManager.broadcast(username=...)` |
| Session→user resolution                        | `connection.py: SessionTracker` + `main.py` sid usage |
| Throttling / msgpack minification of CoT       | `tak_client.py: _broadcast_if_needed`, `KEY_MAP` |
| Entity creation/update/removal (frontend)      | `state.js: updateEntity/_reconcileCesiumEntity/removeEntity/processRemovalQueue` |
| Icon generation (milsymbol/team circle/iconset)| `state.js: _reconcileCesiumEntity` icon block + `drawGroupIcon` |
| Visibility rules (DDC, tilt, selection)        | `state.js: applyFilter/calculateVisibility/updateEntitySelectionVisibility` |
| Filters (text/affiliation/dimension)           | `state.js: setFilters/calculateVisibility` |
| Unit list / staff comments sidebar             | `state.js: updateUnitListUI/updateStaffCommentsUI/staffCommentMap` |
| Stale entity sweep                             | `state.js: initStateManager` (onTick, 30 s interval, 120 s grace) |
| Base maps / terrain / contours                 | `viewer.js` |
| Overlay loading & styling (GeoJSON/KML/CZML)   | `viewer.js: toggleOverlayLayer/applyOverlayStyling` |
| Polygon center labels                          | `viewer.js: applyOverlayStyling` (Rectangle center) |
| Auth screens / config overlay / channels popup | `index.html` markup + `main.js: checkAuth/setupAuthEvents` |
| Own-location feature                           | `main.js` bottom ("Own location") + `POST /api/messaging/location` |
| Camera/session persistence                     | `main.js: saveAppState/loadAppState`, `viewer.js: getCameraState/getLayerState` |
| i18n strings                                   | `frontend/public/locales/{en,de,sv,fi}.json` + `config.js: loadTranslations/applyStaticTranslations` |
| Reconnect behavior (frontend WS)               | `websocket.js: ws.onclose` (4001 = no reconnect) |
| Docker image build                             | `Dockerfile` |

---

## 5. Backend modules in detail

### 5.1 `app/config.py` — Settings

Pydantic `BaseSettings` reading env vars / `.env`. Groups:

- Connection: `TAK_HOST/TAK_PORT/TAK_API_PORT` (streaming CoT vs. Marti REST
  API port), `TAK_ENROLL_PORT`.
- Identity: default callsign/type/uid plus UI-chosen `callsign/color/role`
  overrides. `VALID_COLOURS`/`VALID_ROLES` frozensets with field validators
  enforce whitelists.
- Security: `SECRET_KEY` (session cookie signing, random if unset),
  `TRUSTED_PROXIES` (string-or-JSON-list validator).
- Traffic: `WS_THROTTLE` (min seconds between updates per UID),
  `USE_MSGPACK`, `LOG_COTS`, `TAK_STAFF_COMMENTS` map string.
- Paths: fixed dirs `/app/certs/ephemeral`, `/iconsets`,
  `/app/overlays`, `/app/user_iconsets` (properties, not env-configurable).

`uid_for_username()` derives the stable per-user UID
(`CesiumViewer-<sha256(username)[:16]>`) — the username itself is never sent
to the TAK network in the clear.

Singleton instance exported as `settings`.

### 5.2 `app/users.py` — UserRegistry & crypto primitives

- `UserAccount`: persisted JSON under `<ephemeral>/users/<username>/account.json`
  (pw hash, salt, server, cert expiry, UID, saved lat/lon). Never holds
  plaintext secrets.
- `UserSession`: RAM-only dataclass holding the decrypted Fernet storage key.
- `UserRegistry`: file storage per user (`cert.pem`, encrypted `cert.key`,
  `ca.pem`), plus primitives: PBKDF2-SHA256 password hashing (100k iters,
  `secrets.compare_digest` verification), Fernet key derivation, deterministic
  SHA256-based enrollment secret (for CSR private-key decryption),
  password strength validation (≥8 chars, ≠ `atakatak`, ≠ username),
  credential verification returning a `UserSession`, and
  `any_certificates_remain()` used to decide pin reset.

### 5.3 `app/auth.py` — AuthManager

Central authentication/certificate authority facade (module-level singleton
`auth_manager`):

- **Server pinning**: `decide_server()` enforces `FORCE_SERVER` or the pinned
  server recorded by the first enrollment/upload
  (`pinned_server.json`). Pin resets when the last cert disappears.
- **Enrollment** (`enroll()`): full TAK enrollment dance against
  `https://<server>:8446/Marti/api/tls`: GET `/config` for subject OIDs →
  build CSR from a temporary RSA-2048 key → POST `/signClient/v2` with the
  deterministic enrollment secret as token → parse signedCert/privateKey/CA
  chain from the XML response → decrypt the delivered private key with the
  enrollment secret → re-encrypt with the user's Fernet storage key → store
  per-user. Afterwards fetches the optional enrollment profile mission
  package (`profile/enrollment?clientUid=`) — a ZIP containing `.pref`
  entries parsed for `locationCallsign/locationTeam/atakRoleType` — kept
  one-shot in `_enrollment_profiles` to prefill the config UI.
- **P12 import** (`upload_p12()`): decrypt PKCS12, extract CN as username,
  enforce password strength (forces strong replacement otherwise), encrypt
  and store key material, auto-login.
- **Sessions**: `login()` verifies credentials and caches the RAM-only
  session (storage key); `drop_session()` removes it; `_activate/_deactivate`
  maintain the active user + runtime identity in global settings.
- **Cert material accessors** for the TLS context: `get_cert_bytes`,
  `get_ca_bytes`, `get_private_key` (decrypt-on-demand into RAM),
  `get_cert_info` (CN/org/expiry with green/orange/red/expired status).
- **Wipes**: `wipe_user()` deletes one user's directory + session (isolation);
  `wipe_ephemeral()` nukes the install (legacy path/tests).

### 5.4 `app/tak_client.py` — TAKClient (the heart)

One instance per user (owned by `ClientPool`). Responsibilities:

**TLS setup** — module function `build_ssl_context_for_user(username)`:
loads cert + decrypted key (RAM only) into OpenSSL through `os.memfd_create`
fds (`/dev/fd/N` paths), optionally loads CA bundle; without CA the server
cert check is disabled. Shared by the streaming connection *and* the Marti
REST proxy (`groups.py`).

**Connection loop** (`run()`):
- Resolves target host (identity.server > enrolled server > settings).
- `asyncio.open_connection(..., ssl=ctx)`; read loop splits the stream on
  `</event>` boundaries (1 s tick so dead-link detection can abort).
- Exponential-free fixed retry every 10 s on SSL/OSError; inner-loop errors
  also retry.
- Routing of each inbound event:
  - Contains `b-t-f-d`/`b-t-f-r` → receipt handling (parse, broadcast
    `chat_receipt` to the user's tabs).
  - Contains `b-t-f` → parse chat, mirror `__chat` for future receipts,
    send `b-t-f-d` delivery receipt unless it's our own echo, update
    sender contact info, push into thread history + broadcast.
  - Contains `t-x-d-d` → parse delete task (requires full link triplet
    uid/relation/type; ignores our own UID), prune contact + thread, notify
    frontend via `cot_delete`.
  - Otherwise → `parse_cot()`; atoms (type starting `a-`, plus any event
    with `<emergency>`) become throttled/minified map updates and update
    the contact registry when they carry callsign + endpoint.

**Keepalive** (`_heartbeat_loop`, spec-derived constants):
`RX_STALE_SECONDS=15`, `PING_INTERVAL_SECONDS=4.5`, `RX_DEAD_SECONDS=25`,
`SA_INTERVAL_SECONDS=30`. SA position report sent immediately on connect and
refreshed every 30 s; `t-x-c-t` pings start once inbound goes quiet; after
25 s silence the connection is declared dead and re-established.

**Outbound events**: SA report (`a-f-G-U-C` with `endpoint="*:-1:stcp"` so
others treat us as geochat-capable, `__group` color/role, `takv` platform
WebView), ping, self-delete (`t-x-d-d` with `p-p` link to our UID) on clean
stop.

**CoT parsing** (`parse_cot`): lxml → flat dict (uid, type, how, callsign,
lat/lon/alt rounded, ce, stale, battery, group name/role, course/speed,
remarks, link_url, argb color, iconsetpath, `__milsym`/`__milicon`, squawk
from contact@track or remarks regex, xmpp/mail/phone, emergency object incl.
cancel, staff_comment match from configured patterns).

**Geochat**:
- Threads keyed by `chatgrp id` (peer UID for DMs, room name otherwise);
  bounded history: 200 msgs/thread, 50 threads (LRU-by-time eviction).
- `parse_chat` distinguishes DM vs room via parent/TeamGroups/chatgrp shape
  and resolves sender callsign (attribute > remarks source lookup >
  link uid).
- `send_chat` validates text (≤4000 chars), builds ATAK 5.8-format event,
  adds `<marti><dest uid>` for DMs (server-side 1:1 routing; stripped by the
  server before delivery), mirrors the message locally with `self=True`;
  `client_id` (frontend UUID) becomes `messageId` enabling optimistic-send
  deduplication.
- Receipts: received messages snapshot `_receipts[messageId] = mirror`;
  delivery receipt (`b-t-f-d`) auto-sent on receive; `send_chat_read`
  (triggered from WS `chat_read`) sends `b-t-f-r` once per message
  (`_read_sent` dedup).
- `chat_snapshot()` gives a fresh tab its full state (`chat_init`);
  `reset_chat()` clears state when the active user changes.

**Broadcast pipeline** (`_broadcast_if_needed`): per-UID TTL throttle
(exempts active emergencies), key minification via `KEY_MAP`
(uid→i, lat→la, …), MessagePack or JSON, broadcast scoped to the owning
username.

### 5.5 `app/clients.py` — ClientPool

`dict[(server, username) -> TAKClient]`. `client()` creates on demand and
always refreshes the identity (so config changes are picked up without a
new pool entry); wires `on_cot = client._broadcast_if_needed`.
`client_for(username)`, `is_running`, `stop_user`, `stop_all`.

### 5.6 `app/connection.py` — WS hub + session tracker

- `ConnectionManager`: maps live WebSockets → username.
  `broadcast(payload, username=None)` fans out to all tabs of one user
  (multiuser isolation); `None` means everyone (legacy). Failed sends drop
  the socket from the registry.
- `SessionTracker`: authoritative RAM mapping sid→username registered at
  login/enroll/upload, per-sid WS counts, reverse index username→sids.
  Used by every authenticated HTTP endpoint (`tracker.username_for(sid)`)
  and by logout logic to detect "last session gone".

Both are singletons: `manager`, `tracker`.

### 5.7 `app/groups.py` — Channels (Marti proxy)

Talks to the TAK Server's classic-auth group API as the logged-in user
(mTLS with their own cert/key via `build_ssl_context_for_user`):

- `GET /Marti/api/groups/user?username=` → entitlement list; each entry is a
  `(name, direction, active)` triple (IN = receive, OUT = send).
- `channels_from_entitlements()` reduces triples to `{name, subscribed}`
  where subscribed = *all* available directions active.
- `set_subscribed_channels()` implements the **absolute** PUT semantics:
  refetches entitlements, submits only the desired subset as the complete
  active set (omitted names go inactive server-side).

### 5.8 `app/main.py` — FastAPI application

Lifespan: load layers/iconsets at startup, stop all clients at shutdown.
Middleware: signed session cookie (`tak_webview_session`, session-scoped),
permissive CORS. Static mounts for iconsets and frontend dist.

Endpoints:

| Route | Purpose |
| ----- | ------- |
| `GET /health` | Liveness probe (filtered out of access logs) |
| `GET /api/auth/status` | enrolled/authenticated flags, cert info, pinned/forced server |
| `POST /api/auth/enroll` | Enrollment; returns server profile for prefill |
| `POST /api/auth/upload-p12` | Manual cert import |
| `POST /api/auth/login` | Password login; 3 failures → wipe |
| `POST /api/auth/logout` | Keep certs, stop client when last tab closes, drop RAM key |
| `POST /api/auth/logout-wipe` | Delete this user's data entirely |
| `POST /api/messaging/config` | Save callsign/color/role; starts or hot-updates the user's TAK client |
| `GET /api/messaging/config` | Saved config + account lat/lon |
| `POST /api/messaging/location` | Persist own location; refresh live identity in place (no reconnect) |
| `GET /api/channels` | List channels + merged subscription state |
| `PUT /api/channels` | Apply selected channel set |
| `GET /config` | Aggregated frontend config (`layers.get_app_config`) |
| `GET /iconsets`, `GET /logo`, `GET /api/overlays/{file}` | Assets |
| `WS /ws` | Authenticated data socket (below) |

Module-level `messaging_config: dict[username, {callsign,color,role}]` is
RAM-only and cleared whenever the auth context changes
(`reset_messaging_config` on enroll/upload/logout-wipe) — this guarantees
the TAK client cannot auto-start before explicit confirmation.

**WebSocket protocol** (`/ws`): requires session auth + known sid; opens
with `chat_init` snapshot; then accepts `chat_send` and `chat_read` JSON
messages, resolving the user's TAK client *per message* (lazy-start handles
the case where config was confirmed after connect); errors surface as
`chat_error`. Inbound broadcasts arrive as minified CoT dicts, `cot_delete`,
`chat`, `contacts_update`, `chat_receipt`. On disconnect, when the user has
no tabs left, their TAK client stops.

---

## 6. Frontend modules in detail

### 6.1 `index.html`

Single-page shell (~1675 lines including CSS). Major regions:

- **Auth overlay** (`authOverlay`): choice screen (Enroll / Upload / Login),
  enrollment form, upload form (with insecure-password "new password"
  container), login form, server-info banner showing the pinned server.
- **Status bar** (`statusBar`): connection dot, Zulu clock, cert org +
  expiry (color-coded), identity (`statusUser`), own-location button +
  picker, `configStatusBtn` (messaging config), `channelsStatusBtn`
  (channels popup), chat toggle w/ unread badge, logout/forget buttons.
- **Sidebar**: view options (show-callsigns checkbox), filter inputs
  (text, affiliation VirtualSelect, dimension VirtualSelect), track list
  (`unitListContent`, collapsible category/affiliation tree), staff
  comment groups.
- **Layer picker panel**: base maps grid, overlays grid, terrain section,
  analysis (contours) section with spacing stepper.
- **Modals**: overlay style editor, info modal, messaging config overlay
  (`configOverlay`), channels overlay (`channelsOverlay`).
- **Chat panel** (`chatPanel`): channel list (Rooms/Users), thread view,
  composer.

### 6.2 `main.js` — bootstrap & UI orchestration

- `init()` → `checkAuth()` (fetches `/api/auth/status`, decides whether to
  show auth overlay or start the app) → `startApp()` (loadConfig, i18n,
  viewer, state manager, events, layer picker, GoTo buttons, restore
  localStorage state, start WebSocket, initChat, own-location init).
- Auth flows: enrollment/upload/login/logout/forget handlers; server-pinning
  hides the server inputs and shows the pinned name; enrollment profile
  prefills the messaging config overlay.
- **Messaging config overlay logic**: mandatory callsign guard, save posts
  `/api/messaging/config` (which starts the TAK client), localStorage
  persistence scoped per username (`messagingConfig.<user>`).
- **Channels popup**: opens with fresh `GET /api/channels` every time,
  renders one checkbox per channel, `PUT /api/channels` with the checked
  names on save.
- Layer picker construction, overlay style modal, contour controls,
  filter wiring, Zoom-to-All (theater-radius outlier exclusion + padding),
  Reset View (min 15 km height), selection redirection
  (`*-course/-trail/-outline` → parent entity), hashtag filter links inside
  the Cesium InfoBox iframe, tab-visibility render pausing, camera-move
  autosave.
- **Own-location**: canvas triangle marker, map-click picking via
  ScreenSpaceEventHandler or browser geolocation, persists to localStorage
  and pushes `POST /api/messaging/location`.

### 6.3 `state.js` — entity state manager

Central store `entityState: {uid -> state}` where state holds the JS-side
data (`lastData`, position/history, references to up to three Cesium
entities: main billboard+label, `-trail` polyline, `-course` arrow) plus
bookkeeping flags.

Key mechanisms:

- **Deferred reconciliation**: incoming updates only mutate JS state; actual
  Cesium work happens either immediately (tab visible; foreground queue,
  throttled 50 ms batches) or is deferred via `_pendingCesiumReconcile`
  until the tab becomes visible again. Rendering loop pauses entirely when
  hidden (`viewer.useDefaultRenderLoop = false` in main.js).
- **Removal pipeline**: logical removal mark → immediate hide → batched
  removal queue processed on animation frames (suspend/resume events,
  batch deselect of selected/tracked entities, deferred state-object
  deletion next frame). "Resurrection": an update arriving mid-teardown
  cancels removal.
- **Icon generation**: cache keyed by `sidc-color-squawk-staff_comment`
  (or team-circle / iconset variants); milsymbol canvas → blob URL with
  reference-counted blob revocation (`iconCache`, `blobUsageRegistry`,
  `pendingIcons` promise dedup). Team circles (`drawGroupIcon`) render the
  TAK color disc with role abbreviation; GPS-modifier slash suppressed for
  live SA (`how === "m-g"`).
- **Visibility engine**: text/affiliation/dimension filters
  (`calculateVisibility`, affiliation normalization a→f, j/k→h, p/o→u),
  DistanceDisplayConditions varying by tilt and selection, trails visible
  only while selected + passing filters, callsign master toggle.
- **Unit list & staff comments**: grouped HTML lists (Incidents/Aircraft/
  Vessels/Other by UID heuristics gdacs/icao/#adsb/ais/#ais, then
  affiliation), collapsible via `window.toggleCollapse`, zoom via
  `window.zoomToUnit`; staff-comment definitions parsed from
  `appConfig.tak_staff_comments`, matched per entity into `staffCommentMap`.
- **Stale sweep**: clock tick every ~30 s removes entities whose stale time
  passed more than 120 s ago.

Minified-key reversal happens in `updateEntity` via `REVERSE_KEY_MAP`.

### 6.4 `viewer.js` — Cesium scene

- `initViewer()`: token setup, OSM fallback base, minimal chrome, ellipsoid
  terrain, initial view from config, depth-test against terrain, Zulu clock.
- Imagery providers: WMS (WebMercator, transparent PNG), XYZ/TMS template,
  ArcGIS MapServer; optional rectangle from config or discovered extent;
  manual attribution credits.
- Terrain switching + contour gating (contours require terrain AND a dark
  base map — enforced by `checkAnalysisAvailability` hiding the UI section).
- Overlays: file datasources (GeoJSON/KML/CZML) clamped to ground, pickable,
  styled from `localStorage["overlay_style_<layer>"]` — border polylines as
  separate entities (native polygon outlines don't clamp), dashed/dotted
  materials, fill color/transparency, geographic-center labels via
  `Rectangle.fromCartesianArray().center` with distance-scaled rendering.
- Camera/layer state getters for session persistence.

### 6.5 `chat.js` — chat panel UI

State: `contacts` Map, `threads` Map (key → messages/unread/kind),
`pendingIds` (dedup), `receiptStatus`, `readSignaled`, `roomIconCache`.

- `handleChatInit` hydrates from `chat_init`; `insertMessage` dedups
  optimistic sends by `message_id` (flips `pending` off instead of adding
  twice), counts unread, triggers read receipts for the open thread.
- `buildSystemRooms`: "All Chat Rooms" + one room per visible team color +
  one per non-member role (own included); merged with live room threads in
  `roomChannelList`; icons drawn on canvas (color discs, role monograms,
  forum glyph).
- Users section lists DM threads *plus* contacts without threads (starting a
  DM to a contact with no history works — `contacts.get(threadKey)` path in
  `sendMessage`), each showing the contact's live map icon
  (`getEntityIconUrl`), refreshed on the `cot-icon-ready` event.
- Sending is optimistic: local pending bubble + `ws.send({chat_send})`;
  receipts render ✓/✓✓ via `statusCheckmark`.
- `escapeHtml` used consistently for all injected strings.

### 6.6 Supporting modules

- `websocket.js`: connects `/ws` (binaryType arraybuffer), decodes msgpack
  or JSON, dispatches to state/chat modules, status-dot pulse, 4001 =
  unauthorized (no reconnect, shows auth), otherwise 5 s auto-reconnect.
- `config.js`: `/config` fetch into shared mutable `appConfig`; i18n JSON
  loading with language fallback chain; static DOM translation pass.
- `utils.js`: `cotToSidc` (CoT 2525 mapping), `cleanSIDC2525C` (wildcard/SOF
  normalization), MGRS conversion, affiliation colors/labels, squawk
  emergency labels, great-circle destination math, generic throttle, Google-
  Material-style canvas icon renderer.

---

## 7. Data flow walkthroughs

### 7.1 Login → first map update

1. Browser: `POST /api/auth/login` → backend verifies PBKDF2 hash, creates
   RAM `UserSession` (Fernet key), registers `sid→username`, sets session
   cookie.
2. Frontend re-runs `init()`; `GET /api/messaging/config` empty → config
   overlay forces callsign/color/role entry.
3. `POST /api/messaging/config` → `pool.client(server, username, identity)`
   created; `client.start()` → TLS connect (memfd-fed cert/key), SA report
   sent, heartbeat running.
4. Browser opens `/ws`; hub tags the socket with the username; backend sends
   `chat_init`; inbound CoT atoms flow: parse → throttle → minify → msgpack
   → `manager.broadcast(username=...)` → `updateEntity()` → reconcile →
   billboard appears.

### 7.2 Sending a chat message

Frontend `sendMessage()` → optimistic bubble → `chat_send{room?, peer_uid?,
peer_callsign?, text, client_id}` over `/ws` → backend resolves user's
client per-message → `send_chat()` builds `b-t-f` (DM adds
`<marti><dest uid>`), writes to TLS stream, mirrors into thread history and
back to all tabs with `self=true` and the same `message_id` → frontend flips
pending off. Recipient side: server delivers `b-t-f` → `parse_chat` →
delivery receipt `b-t-f-d` back to sender → recipient's tabs get `chat`
message; when they open the thread, `chat_read` → `b-t-f-r` → sender's
checkmark upgrades ✓→✓✓.

### 7.3 Subscribing to channels

Status bar → "Channels" → `GET /api/channels` → `groups.py` builds mTLS ctx
from the user's RAM-decrypted key, GETs `/groups/user`, merges IN/OUT per
name → checkboxes. Save → `PUT /api/channels` with checked names → backend
refetches entitlements and PUTs the absolute active set to
`/Marti/api/groups/active`.

### 7.4 Entity deletion

Remote client disconnects → server emits `t-x-d-d` linking the UID →
backend prunes contact + DM thread, broadcasts `cot_delete` → frontend
removes map entity (`removeEntity`) and chat contact/DM (`handleCotDelete`).

### 7.5 Logout / teardown

- Simple logout: last tab's `/ws` closing triggers `pool.stop_user` (soft
  `t-x-d-d` to expire our SA); last session end drops the RAM storage key.
- Logout-wipe additionally deletes the user's registry directory, resets
  messaging config, resets server pin if it was the last cert.

---

## 8. Security model

- **At rest**: private keys Fernet(AES128-CBC)-encrypted; storage key =
  PBKDF2(password, salt). Account stores only hash+salt. Nothing plaintext
  touches disk under `/app/certs/ephemeral`.
- **In RAM**: decrypted keys only during TLS context construction; fed via
  anonymous `memfd`s closed immediately after `load_cert_chain`.
- **Transport**: browser↔backend is plain HTTP behind whatever proxy the
  operator provides (README advises reverse proxy + TLS); backend↔TAK
  Server is always mTLS. Without a CA bundle the server certificate check
  is disabled (`CERT_NONE`) — deployments should supply the CA.
- **Access control**: every authenticated route resolves the user via
  server-side `sid` (cookie value alone is useless without the signing
  key); WebSocket requires the same; broadcasts never cross user
  boundaries.
- **Abuse limits (current)**: 3 failed logins wipe the account's records;
  password strength enforcement on import; input validation on colors,
  roles, coordinates, channel lists, chat length. Rate limiting and IP
  banning are **not yet implemented** (see AGENTS.md open items).
- **Privacy**: UID is a salted-nothing hash of the username; the status bar
  shows cert organization rather than CN; usernames never leave the
  backend except in Marti API calls that require them.

---

## 9. Configuration reference

See README.md for the complete environment-variable tables (connection,
identity, security, map/UI, traffic/chat/logging, ports). Summary of the
most architecturally significant:

- `TAK_HOST` / `TAK_PORT` (8089) — CoT stream target.
- `TAK_API_PORT` (8443) — Marti REST API (channels).
- `TAK_ENROLL_PORT` (8446) — enrollment.
- `FORCE_SERVER` — install-wide server pin.
- `WS_THROTTLE` (0.5 s) / `USE_MSGPACK` — frontend traffic shaping.
- `LOG_COTS` — wire logging (raises tak/main loggers to DEBUG).
- Fixed container paths: `/app/certs/ephemeral`, `/iconsets`,
  `/app/user_iconsets`, `/app/overlays`.

---

## 10. Tests and tooling

Backend (`poetry run pytest` from `backend/`, asyncio mode auto):

| File | Covers |
| ---- | ------ |
| `test_config.py` | Settings parsing/validation |
| `test_cot_parsing.py` | `parse_cot` XML→dict |
| `test_users.py` | Registry + crypto primitives |
| `test_clients.py` | ClientPool lifecycle |
| `test_multiuser.py` | Per-user isolation |
| `test_server_pinning.py` | FORCE_SERVER/pin decisions |
| `test_chat_roundtrip.py` | Chat build/parse symmetry |
| `test_chat_receipts.py` | b-t-f-d/b-t-f-r handling |
| `test_groups.py` | Entitlement merging + PUT body |

Frontend: Vitest (`npm test`), ESLint + Prettier (`npm run lint/format`),
Vite build (`npm run build`).
Python quality gates: black, mypy (strict), pylint, ruff.

Docker: stage 1 builds the frontend with Node, stage 2 installs Poetry deps
into python:3.11-slim, copies `backend/app`, serves `frontend/dist` from
FastAPI, mounts iconsets at `/iconsets`, exposes 8000.
