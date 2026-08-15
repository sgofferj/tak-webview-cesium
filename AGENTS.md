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
- **Current Status (as of April 17, 2026):**
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
    - [ ] **Rate Limiting:** Implement rate limiting on the FastAPI backend for enrollment and CoT endpoints.
    - [ ] **Backend Robustness:** Add comprehensive unit tests for CoT parsing.
    - [ ] **Frontend Polish:** Implement a more sophisticated "Entity Selection" UI with a cleaner side panel.
- **Architectural Decisions:**
    - **Surface Clamping:** Ground/Surface units use `CLAMP_TO_GROUND`. Air units use `HeightReference.NONE`.
    - **Trail Stability:** `clampToGround: true` with two-point minimum history for stability.
    - **Distance Configuration:**
        - **Tactical (Labels/Trails):** 300km (`TACTICAL_DISTANCE`).
        - **Horizon (Depth Test):** 1000km (`HORIZON_LIMIT`).
        - **Global Visibility (Icons):** 100,000km (`MAX_DISTANCE`).
        - **Overlay Labels:** 10,000km with scaling.
    - **Dynamic Secrets:** Randomized `SECRET_KEY` on startup to secure session cookies.
- **Security Hardening Roadmap (High Priority):**
    - [x] **Transparent Key Encryption:** Fernet-encrypted private keys on disk, RAM-only decryption.
    - [x] **Automated Enrollment Secrets:** SHA256-derived CSR passwords.
    - [x] **UX Simplification**: Removed Certificate Password from enrollment UI.
    - [x] **Automatic Re-encryption:** Force strong passwords for imported insecure certificates.
    - [ ] **Rate Limiting:** Implement rate limiting on the FastAPI backend for enrollment and CoT endpoints.
- **Session Wrap-up (2026-04-17):**
    - [x] **Callsign UI Refinement**: Reduced font size to 12px and switched to high-contrast black-on-white-smoke style.
    - [x] **Visibility Control**: Added "Show callsigns" toggle; unselected entities hide labels when toggled off.
    - [x] **Polygon Labeling**: Implemented robust geographic labeling for overlay features. Added support for Finnish/Swedish fallback attributes (`NAMEFIN`, `NAMESWE`).
    - [x] **Advanced Authentication**: Implemented manual `.p12` upload flow. 
    - [x] **Identity Automation**: Extracted username (CN) directly from uploaded certificates, simplifying the UX.
    - [x] **Secure Import:** Implemented server-side check for weak cert passwords ("atakatak", username, short), forcing re-encryption with a strong user-defined secret.
    - [x] **Backend Robustness:** Integrated `python-multipart` for reliable form/file handling.
    - [x] **UI Polish:** Placed the project logo on the authentication screen with vertical stacking and fallback logic.
    - [x] **Documentation:** Extensively updated `README.md` to reflect the new security model and features.
    - Verified `tak-webview-cesium:test` deployment.
- **Future Considerations:**
    - **High Contrast / Monochrome Icon Theme:** Implement a toggle to switch milsymbols and SVGs to a line-only, monochrome style.
    - **Rate Limiting:** Implement rate limiting on the FastAPI backend for enrollment and CoT endpoints.
    - **Backend Robustness:** Add comprehensive unit tests for CoT parsing.
    - **Frontend Polish:** Implement a more sophisticated "Entity Selection" UI with a cleaner side panel.

### Agent Coordination
- This file coordinates agent work on the tak-webview-cesium project.
- See `GEMINI.md` for persistent project context loaded into every session.
- Agent tasks should reference both this file and `GEMINI.md` for complete context.
- Recent agent-facilitated changes include: Messaging Configuration Popup (callsign, color, role dropdowns).
- **⚠️ NOTE TO FUTURE MODELS:** Don't delete working TLS/CoT implementations when "refactoring" - the previous commit 1eb5c4b replaced a fully functional RAM-only SSL context with `await asyncio.sleep(86400)`. Read the existing code FIRST. If it works, don't rewrite it unless asked.

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
