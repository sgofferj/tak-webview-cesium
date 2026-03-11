# Plan: Deep Analysis Fix for TAK-webview-cesium

## Objective
Final resolution of:
1. High-altitude icon visibility.
2. Pixelated circle icons & incorrect milsymbol mapping.
3. Browser performance/freezes.

## Deep Analysis Findings

### 1. Visibility (Occlusion/Burial)
- **Problem:** When zoomed out beyond `HORIZON_LIMIT` (even 2000km), depth testing is enabled. If `heightReference` is `NONE`, the 200m tactical offset is absolute (HAE). Any terrain higher than the unit's HAE + 200m will bury the icon.
- **Solution:** 
    - Change `heightReference` to `RELATIVE_TO_GROUND` for Billboards and Labels.
    - Set the `position` height to exactly `200.0` (tactical offset). Cesium will add this to the terrain height at that point.
    - Set `disableDepthTestDistance` back to `500000.0` (500 km) as per `GEMINI.md` to prevent "ghost" units through the earth, as icons will no longer be buried by local terrain.

### 2. Rendering (Circles vs Milsymbols)
- **Problem:** `state.lastData` retains `group_name` and `group_role` indefinitely due to sparse merging. If a TAK server heartbeat (or any previous message) set these, the unit stays a circle forever.
- **Solution:**
    - The Backend (`tak_client.py`) will explicitly send `group_name: null` and `group_role: null` if the `__group` tag is missing.
    - The Frontend (`state.js`) will allow `null` values to overwrite `state.lastData` for these specific fields.
    - **Circle Quality:** Increase `drawGroupIcon` canvas size to 256x256 and use `ctx.scale` for smoother rendering.

### 3. Performance (Freezes)
- **Problem:** `updateUnitListUI` iterates over EVERY entity and performs DOM/String operations every second (throttled).
- **Solution:** 
    - Implement a `dirtyUnits` flag. Only re-render the unit list if a unit was added, removed, or its visibility/emergency status changed.
    - Remove the duplicate polyline update logic in `state.js` (verified as still present in some form).

## Implementation Steps

### Step 1: Backend (`tak_client.py`)
- Explicitly set `data["group_role"] = data["group_name"] = None` if `__group` is missing.

### Step 2: Frontend (`state.js`)
- **Constants:** `MAX_DISTANCE = 10000000.0`, `HORIZON_LIMIT = 500000.0`.
- **Merge Logic:** Allow `null` for `group_name` and `group_role`.
- **Positioning:** Use `HeightReference.RELATIVE_TO_GROUND`. Set height to 200.
- **Unit List:** Add `dirtyUnits` flag and logic.
- **Group Icon:** Improve resolution and anti-aliasing.

### Step 3: Deployment
- Rebuild with `--no-cache` and redeploy.
