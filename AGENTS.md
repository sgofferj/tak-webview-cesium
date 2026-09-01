# AGENTS.md - Project Agent Coordination

## Project: tak-webview-cesium
A TAK (Track Awareness Kit) Cesium map viewer for geochat/messaging functionality.

## Ground rules
- Do not commit to main - every work unit gets a feat-branch
- Clean up branches after a work unit is designated completed and merged
- Do not reveal AI participation
- Never commit/push AGENTS.md or similar AI control files
- Never leak real life addresses/URLs (e.g. TAK test server, etc), cert or creds. Be 1000% sure about that!
- AI agents must not change this section unless specifically and clearly in a separate command instructed to do so.

### Project Context (from GEMINI.md)
- **Objective:** Webview-based TAK client using CesiumJS for 3D visualization.
- **Architecture:**
    - **Backend:** FastAPI (Python), Poetry for dependency management. Handles CoT (Cursor on Target) connectivity.
    - **Frontend:** Vite (Vanilla JS), CesiumJS for mapping, milsymbol for military icons.
- **Engineering Standards:**
    - **Backend:** Poetry, Ruff, MyPy, PyLint.
    - **Frontend:** ESLint, Prettier, Vite, Vitest.
    - **Python standards:** Always run `black`, `mypy`, and `pylint` after modifying Python code.
- **Current Status (as of September 01, 2026):**
    - [x] **Callsign Style Updated**: Black text, no outline, transparent white background.
    - [x] **Callsign Visibility Toggle**: Implemented sidebar checkbox with local persistence and i18n.
    - [x] **Polygon Overlay Labels**: Geographic center labeling using `Rectangle` for accuracy.
    - [x] **Manual Certificate Upload**: Support for `.p12` files with automatic CN extraction.
    - [x] **Authentication Choice**: New entry screen for enrollment vs. manual upload.
    - [x] **Password Hardening**: Forced re-encryption for insecure certificate passwords.
    - [x] **Auth UI Branding**: Integrated configured logo on the login/enrollment screen.
    - [x] **Security Fixes**: Verified CoT/Map access controls.
    - [x] **Transparent Key Encryption:** Fernet-encrypted private keys on disk, RAM-only decryption.
    - [x] **Automated Enrollment Secrets:** SHA256-derived CSR passwords.
    - [x] **UX Simplification**: Removed Certificate Password from enrollment UI.
    - [x] **Automatic Re-encryption:** Force strong passwords for imported insecure certificates.
    - [x] **Geochat (b-t-f) Implementation**: Full chat send/receive with thread history, contact tracking, `__milsym`/`__milicon` parsing, staff comments, throttling, msgpack minification.
    - [x] **TAK Connection Lifecycle**: TLS with RAM-only keys (memfd), proper keepalive (RX_STALE/PING_INTERVAL/RX_DEAD), reconnection with exponential backoff.
    - [x] **Chat Button Fix**: Now properly opens chat panel instead of showing alert.
    - [x] **Messaging Config**: Config overlay saves callsign/color/role to backend; TAK client starts only after user confirms.
    - [x] **Chat Panel UI**: Channel list (Rooms/Users), thread view, composer with send.
    - [x] **Contact List**: Shows callsigns (not UIDs) from CoT contact/callsign + endpoint filter.
    - [x] **First Message Send (DM)**: Fixed - sendMessage now checks the contacts map for DMs without an existing thread (commit 1532744).
    - [x] **WebSocketDisconnect Handling**: Disconnect (1001) no longer produces uncaught ASGI tracebacks on logout/reload/drop; clean teardown through finally.
    - [x] **TAK Connect Ordering**: TAK client no longer auto-starts before the messaging config is confirmed (reset_messaging_config on enroll/upload/logout-wipe).
    - [x] **Health Endpoint**: GET /health liveness probe excluded from the access log (HealthCheckLogFilter).
    - [x] **Multiuser Chat Send Fix**: WS handler now resolves the TAK client per message (plus lazy start), so chat_send no longer silently drops when the messaging config is confirmed after the socket connects (commit f317227).
    - [x] **Chat Receipts (b-t-f-d/b-t-f-r)**: Delivery/read receipts with ✓/✓✓ UI checkmarks, mirror-based replies, dedup, i18n (en/de/sv/fi), auto delivery receipt on receive and read receipt on thread view (PR #40).
    - [x] **t-x-d-d Chat Cleanup**: Contacts AND their DM threads are removed completely from the chat list when a t-x-d-d is received (backend prunes `_chat_threads`, frontend clears thread + contact + pending state).
    - [x] **Chat Room Auto-creation**: "All Chat Rooms" unconditionally; per-color and per-role (except "Team Member") rooms auto-created from visible users. Rooms get fitting icons (color circle without GPS modifier, white role icon, forum icon for All Chat Rooms); the Users list mirrors each client's map icon.
    - [x] **Direct Message Server Routing**: Outbound DMs now carry `<marti><dest uid=.../></marti>` so the TAK server routes them 1:1 instead of broadcasting them as a group/room chat (verified against TAK Server source: StreamingEndpointRewriteFilter → EXPLICIT_UID_KEY).
    - [x] **Channel Selection (TAK Server Groups)**: Status-bar "Channels" popup listing the user's TAK server groups (channels) with merged IN/OUT subscription state; backend proxy for the Marti group REST API (`GET /api/channels`, `PUT /api/channels`) using mTLS with the user's own cert and RAM-only key (`build_ssl_context_for_user`); absolute `PUT /Marti/api/groups/active` semantics; new `TAK_API_PORT` setting (default 8443); i18n en/de/sv/fi; unit tests in `backend/tests/test_groups.py`. Merged as PR #43.
    - [x] **Code Guide Docs**: Complete functional/architecture description for auditors and new developers in `docs/CODE_GUIDE.md` (English) and `docs/CODE_GUIDE.fi.md` (Finnish): high-level overview, code map with quick-lookup table, module walkthroughs, data-flow walkthroughs, security model. Merged as PRs #44/#45; keep both languages in sync when architecture changes.
    - [x] **Full UI Label i18n**: All previously hardcoded UI labels (status bar buttons, location picker, layer picker headers, chat panel, config overlay, auth screens, connection status) now go through i18n with full key parity across en/de/sv/fi (PR #46).
    - [x] **Forum Icon Fix**: `renderGoogleIcon()` grid detection corrected (max coordinate magnitude instead of "-" presence) — the All Chat Rooms icon previously rendered as an empty ring (PR #49).
    - [x] **End-User Guide (EN/FI)**: `docs/user-guide/en|fi/` with 13 chapters for military/LEO end-users (no IT/TAK background assumed), functional UI icons in `docs/user-guide/images/`, cross-linked language versions. Merged as PR #47.
    - [x] **User-Guide PDF Release Workflow**: `.github/workflows/user-guide-pdf.yml` builds EN+FI PDFs (pandoc/xelatex) and publishes them as GitHub release assets (`user-guide-v<run_number>`) whenever a `docs/*` branch is merged into main; also manual dispatch. Verified live: release `user-guide-v2` (PR #50).
    - [x] **Messaging Config Persistence & Channel 403 Fix (2026-09-01)**: Callsign/color/role persisted to `account.json` (per-user) in addition to RAM; `GET /api/messaging/config` falls back to disk, `POST` syncs both, frontend `loadMessagingConfig` now runs on startup before WS, uses live `getSelfInfoKey()`, migrates legacy `messagingConfig` key and pushes localStorage to backend when backend empty — status bar now shows `username - <callsign> (<role>)` immediately after login. Channels: `GET /Marti/api/groups/user` is admin-only (403 for user cert, verified live); switched to `GET /groups/all?useCache=true&sendLatestSA=true` with dedup by `(name, direction, created)` and `PUT` deduplication; `GET /api/channels` now returns full catalog with correct `subscribed` flags.
    - [ ] **Rate Limiting:** Implement rate limiting on the FastAPI backend for enrollment and CoT endpoints.
    - [ ] **IP Banning:** Ban IPs with increasing ban time on failed enrollment and failed logins (escalating window, e.g. 5 min -> double up to 24 h cap; bounded LRU table; respect trusted_proxies for X-Forwarded-For).
    - [x] **Multi-User Refactor (multiuser-singleserver)**: Users registry with per-user cert/key/creds (RAM-only decryption per session), ClientPool keyed by (server, user), per-user session roster, FORCE_SERVER/MAX_USERS/MAX_SERVERS env vars, logout-wipe isolation, distinct per-user UID. Multiserver data-scoping deliberately deferred (see `MULTIUSER_PLAN.md`).
    - [ ] **Backend Robustness:** Add comprehensive unit tests for CoT parsing.
    - [ ] **Frontend Polish:** Implement a more sophisticated "Entity Selection" UI with a cleaner side panel.

### Agent Coordination
- This file coordinates agent work on the tak-webview-cesium project.
- Recent agent-facilitated changes include: Messaging Configuration Popup (callsign, color, role dropdowns); chat receipts; t-x-d-d chat cleanup; chat room auto-creation; DM `<marti><dest>` routing fix; channel selection (Marti group REST proxy, merged as PR #43); code guide docs EN/FI (merged as PRs #44/#45); full UI label i18n (PR #46); end-user guide EN/FI with functional icons (merged as PR #47); user-guide PDF release workflow (merged as PR #50); messaging config persistence & channel 403 fix (2026-09-01, `fix/messaging-config-and-channels`) — persisted callsign/color/role to `account.json`, `GET /groups/all` fix for user certs, frontend `loadMessagingConfig` startup + per-user `localStorage` migration. All feat/ci/fix/docs branches from this work are merged and cleaned up.
- A detailed functional/architecture description of the codebase for auditors and new developers lives in `docs/CODE_GUIDE.md` (English) and `docs/CODE_GUIDE.fi.md` (Finnish). Keep both in sync when architecture changes.
- **⚠️ NOTE TO FUTURE MODELS:** Don't delete working TLS/CoT implementations when "refactoring" - commit 1eb5c4b (2026-08-14) replaced a fully functional 910-line RAM-only SSL context + geochat implementation with `await asyncio.sleep(86400)`. The working code was recovered from Docker test images (13AUG/14AUG). Read the existing code FIRST. If it works, don't rewrite it unless asked.
- **⚠️ NOTE:** The TAK client lifecycle is now: starts ONLY after user confirms messaging config (callsign/color/role) via config overlay. Does NOT start on enrollment/login. Stops when last web client disconnects.
- **⚠️ NOTE:** The TAK server routes a b-t-f to a single recipient ONLY when it carries `<marti><dest uid=.../></marti>` (StreamingEndpointRewriteFilter → EXPLICIT_UID_KEY). Without it, chat is broadcast as a group message. The server strips `<marti>` before delivery, so it is invisible in server-delivered wire captures.

### Development Commands
- `bun install` / `npm install` - Install frontend dependencies
- `bun run dev` / `npm run dev` - Start development server
- `poetry install` - Install backend dependencies
- `poetry run start` - Start backend server

### Git Workflow
- Current branch: `main`
- **All documentation work (docs/, user guides, guides translations) must happen on `docs/*` branches** — never directly on main or feat-branches. Merging a `docs/*` branch into main automatically triggers the user-guide PDF release workflow (`.github/workflows/user-guide-pdf.yml`).
- Commit messages should be descriptive of the feature/fix
- Run `black`, `mypy`, and `pylint` after modifying Python code
- Default branch for TAK projects must always be 'main'
- Always exclude cert subdirs, PEM, KEY, and PFX files in .gitignore for TAK projects

### Notes
- Project author: Stefan Gofferje
- Email: stefan@gofferje.net
- Project name for Docker builds: 'tak-webview-cesium'
- Tag local verification builds as ':test', production as ':latest'
- Include pip-audit in pre-commit configuration for dependency security
