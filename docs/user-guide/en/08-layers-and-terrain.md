# Chapter 8 — Maps, Overlays and Terrain

Open the **layer picker** panel to control what the map shows underneath
the unit symbols.

## Choosing a base map

The top section lists available base maps as picture tiles, grouped by
category (for example *World Layers*, or national map sets your unit added).
Click one to switch. Your choice is remembered for next time.

## Switching overlays on and off

Below the base maps is the overlay grid — extra information drawn on top
of the map:

- **Web overlays** — semi-transparent layers like sea marks, provided by
  external servers.
- **Local files** — your unit's own map data (GeoJSON, KML), listed under
  their names. These can include area boundaries, routes, points of
  interest and similar.

Click an overlay to switch it on; click again to switch it off. The tile
with the Ø symbol turns everything off at once.

## Styling local file overlays

Right-click a local file overlay in the list to open its style editor.
You can change:

- **Line color, width and style** (solid, dashed, dotted) — or hide the
  border completely
- **Fill color and transparency** — or no fill at all

Click **Save** to apply. Styles are kept per layer in your browser, so
your colors come back the next time you enable the layer.

Polygons are labeled with their name at their center automatically, so you
can identify areas without opening them.

## Terrain

If your administrator configured an elevation model, the terrain section
offers two choices: flat (**WGS84 Ellipsoid**) or real **Terrain** with
mountains and valleys. Real terrain makes a noticeable difference when
working in 3D view.

## Elevation contours

With terrain enabled and a dark base map active, an **Analysis** option
appears: elevation contours drawn directly on the ground, in cyan.

![Contours option](../images/contours-thumbnail.png)

Use
the −/+ stepper to change contour spacing (for example every 50 m or every
200 m). Contours turn off automatically if you switch to a light map or
back to flat terrain.

> **Why dark maps only?** Contour lines are calibrated against dark
> imagery; on light maps they would be hard to read, so the option hides
> itself.

## Dark maps

Base maps with "dark" or "night" in their name switch the whole scene to a
night-friendly look — black background, no atmospheric glow. Useful for
low-light operations.
