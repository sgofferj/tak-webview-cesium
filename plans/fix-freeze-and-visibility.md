# Plan: Fix Performance Freeze and High-Altitude Visibility in TAK-webview-cesium

## Objective
Address the following critical issues:
1.  **Browser Tab Freeze:** Tab becomes unresponsive within seconds.
2.  **High-Altitude Visibility:** Icons (billboards) are hidden from high altitudes while labels are visible.

## Background & Analysis
- **Performance Freeze:**
    - **Unstable State Key:** `backend/app/tak_client.py` explicitly sets `group_name`, `group_role`, etc. to `None` if they are missing from the current XML. This causes `Object.assign` in the frontend to flicker between valid and null states, triggering `toDataURL` and image regeneration on every message.
    - **Redundant Property Updates:** `frontend/state.js` sets `disableDepthTestDistance` and other properties on every update. Assigning a raw number to a Cesium `Property` repeatedly is computationally expensive.
    - **`toDataURL` Overhead:** Converting canvas to base64 strings frequently is very slow. Cesium can accept the canvas directly.
- **High-Altitude Visibility:**
    - **Distance Constants:** `MAX_DISTANCE` (10,000 km) might be too small for some "high altitude" views (e.g., GPS orbit is 20,000 km).
    - **Horizon Limit:** `HORIZON_LIMIT` (500 km) is the distance from camera to unit. At 1000km altitude, depth testing is enabled. If the unit is at 200m altitude and there is terrain at 1000m, the unit is BURIED and hidden. Labels might be passing depth tests due to different rendering biases or offsets. Increasing `HORIZON_LIMIT` to 2000km allows visibility from higher altitudes without showing units "through" the earth.

## Key Files & Context
- `backend/app/tak_client.py`: CoT parsing and minification.
- `frontend/state.js`: Core entity creation and update logic.

## Proposed Changes

### 1. Refactor `backend/app/tak_client.py` (Sparse Updates)
- Modify `parse_cot` to **only** include keys in the `data` dictionary if they are actually found in the XML message.
- Remove `else: data[...] = None` blocks to prevent wiping previous frontend state.
- Ensure `uid`, `type`, `how`, `lat`, `lon`, and `stale` are always present (mandatory).

### 2. Optimize `frontend/state.js` (Performance)
- **Stable Merge:** In `updateEntity`, perform a sparse merge: `if (data[k] !== null && data[k] !== undefined) state.lastData[k] = data[k];`
- **Efficient Image Updates:**
    - Remove `toDataURL()`. Assign the `iconCanvas` directly to `billboard.image`.
    - Ensure `stateKey` is as stable as possible.
- **Minimal Property Updates:**
    - Only set `disableDepthTestDistance` and `distanceDisplayCondition` once during creation.
    - Check if `position`, `description`, etc. have changed before assigning them (Cesium handles some of this, but absolute values are better).
    - Use `if (!state.entity.polyline.material.color.equals(effectiveColor))` check.

### 3. Adjust Visibility Constants (High Altitude)
- Increase `MAX_DISTANCE` to `40000000.0` (40,000 km) to support geostationary altitudes.
- Increase `HORIZON_LIMIT` to `2000000.0` (2,000 km) to allow units to be visible from higher up without being occluded by terrain.

## Implementation Plan

### Step 1: Update `backend/app/tak_client.py`
- Refactor `parse_cot` to remove explicit `None` assignments for optional fields (contact, group, track, remarks, link, color, usericon, emergency).

### Step 2: Update `frontend/state.js`
- Update constants (`MAX_DISTANCE`, `HORIZON_LIMIT`).
- Refactor the state merge logic in `updateEntity`.
- Update property assignment logic to be more conservative.
- Update image assignment to use `iconCanvas` instead of `toDataURL()`.

### Step 3: Deployment & Verification
- Rebuild container and redeploy to `nostromo`.
- Verify performance (no freezes).
- Verify icons and labels are visible from high altitudes.
