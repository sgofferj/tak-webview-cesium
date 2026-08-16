# AGENTS.md - Project Agent Coordination

## Project: tak-webview-cesium
A TAK (Track Awareness Kit) Cesium map viewer for geochat/messaging functionality.

### Project Context (from GEMINI.md)
- **Objective:** Webview-based TAK client using CesiumJS for 3D visualization.
- **Architecture:**
    - **Backend:** FastAPI (Python), Poetry for dependency management. Handles CoT (Cursor on Target) connectivity.
    - **Frontend:** Vite (Vanilla JS), CesiumJS for mapping, milsymbol for military icons.
- **Engineering Standards:**
    - **Backend:** Poetry, Ruff, MyPy, PyLint.
    - **Frontend:** ESLint, Prettier, Vite, Vitest.
    - **Python standards:** Always run `black`, `mypy`, and `pylint` after modifying Python code.
- **Current Status (as of August 15, 2026):**
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
    - [ ] **Rate Limiting:** Implement rate limiting on the FastAPI backend for enrollment and CoT endpoints.
    - [ ] **IP Banning:** Ban IPs with increasing ban time on failed enrollment and failed logins (escalating window, e.g. 5 min -> double up to 24 h cap; bounded LRU table; respect trusted_proxies for X-Forwarded-For).
    - [ ] **Multi-User Refactor:** See `MULTIUSER_PLAN.md`. Users registry (per-user cert/key/creds, RAM-only decryption per session), ClientPool keyed by (server, user), per-user session roster, FORCE_SERVER/MAX_USERS/MAX_SERVERS env vars, logout-wipe isolation, distinct per-user UID.
    - [ ] **Backend Robustness:** Add comprehensive unit tests for CoT parsing.
    - [ ] **Frontend Polish:** Implement a more sophisticated "Entity Selection" UI with a cleaner side panel.
### Agent Coordination
- This file coordinates agent work on the tak-webview-cesium project.
- See `GEMINI.md` for persistent project context loaded into every session.
- Agent tasks should reference both this file and `GEMINI.md` for complete context.
- Recent agent-facilitated changes include: Messaging Configuration Popup (callsign, color, role dropdowns).
- **⚠️ NOTE TO FUTURE MODELS:** Don't delete working TLS/CoT implementations when "refactoring" - commit 1eb5c4b (2026-08-14) replaced a fully functional 910-line RAM-only SSL context + geochat implementation with `await asyncio.sleep(86400)`. The working code was recovered from Docker test images (13AUG/14AUG). Read the existing code FIRST. If it works, don't rewrite it unless asked.
- **⚠️ NOTE:** The TAK client lifecycle is now: starts ONLY after user confirms messaging config (callsign/color/role) via config overlay. Does NOT start on enrollment/login. Stops when last web client disconnects.
### Development Commands
- `bun install` / `npm install` - Install frontend dependencies
- `bun run dev` / `npm run dev` - Start development server
- `poetry install` - Install backend dependencies
- `poetry run start` - Start backend server

### Git Workflow
- Current branch: `main`
- Commit messages should be descriptive of the feature/fix
- Run `black`, `mypy`, and `pylint` after modifying Python code
- ESP-IDF environment: `. /home/sgofferj/esp/esp-idf/export.sh`
- Default branch for TAK projects must always be 'main'
- Always exclude cert subdirs, PEM, KEY, and PFX files in .gitignore for TAK projects

### Notes
- Project author: Stefan Gofferje
- Email: stefan@gofferje.net
- Project name for Docker builds: 'tak-webview-cesium'
- Tag local verification builds as ':test', production as ':latest'
- Include pip-audit in pre-commit configuration for dependency security
