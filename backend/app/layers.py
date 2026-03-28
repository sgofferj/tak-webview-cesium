#!/usr/bin/env python3
# layers.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import json
import logging
import os
from typing import Any

import httpx
from anyio import Path
from lxml import etree

from .config import settings
from .iconsets import iconsets_cache

logger = logging.getLogger("tak-webview.layers")

layers_cache: list[dict[str, Any]] = []
overlay_layers_cache: list[dict[str, Any]] = []
file_overlays_cache: list[dict[str, Any]] = []


async def scan_file_overlays() -> list[dict[str, Any]]:
    """Scans the overlays directory for GeoJSON, KML, and CZML files."""
    overlays: list[dict[str, Any]] = []
    directory = settings.overlays_dir
    if not os.path.exists(directory):
        return overlays

    for filename in os.listdir(directory):
        ext = filename.lower().split(".")[-1]
        if ext in ["geojson", "json", "kml", "czml"]:
            overlays.append(
                {
                    "name": filename,
                    "type": "file",
                    "url": f"/api/overlays/{filename}",
                    "file_type": ext if ext != "json" else "geojson",
                    "category": "Local Files",
                    "overlay": True,
                }
            )
    return overlays


async def fetch_wms_extent(url: str, layer_name: str) -> list[float] | None:
    """Fetches GetCapabilities from WMS and extracts the bounding box."""
    try:
        separator = "&" if "?" in url else "?"
        cap_url = f"{url}{separator}SERVICE=WMS&REQUEST=GetCapabilities"

        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            response = await client.get(cap_url)
            if response.status_code != 200:
                logger.warning(
                    "Failed to fetch WMS capabilities for %s: %s",
                    url,
                    response.status_code,
                )
                return None

            root = etree.fromstring(response.content)
            ns = {"wms": root.nsmap.get(None, "")}

            xpath_query = f"//wms:Layer[wms:Name='{layer_name}']"
            layer_el = root.xpath(xpath_query, namespaces=ns)

            if not layer_el:
                xpath_query = f"//Layer[Name='{layer_name}']"
                layer_el = root.xpath(xpath_query)

            if layer_el:
                el = layer_el[0]
                geo_box = el.find(".//{*}EX_GeographicBoundingBox")
                if geo_box is not None:
                    west = geo_box.findtext("{*}westBoundLongitude")
                    east = geo_box.findtext("{*}eastBoundLongitude")
                    south = geo_box.findtext("{*}southBoundLatitude")
                    north = geo_box.findtext("{*}northBoundLatitude")
                    if all([west, east, south, north]):
                        return [
                            float(west),
                            float(south),
                            float(east),
                            float(north),
                        ]

                lat_lon_box = el.find(".//{*}LatLonBoundingBox")
                if lat_lon_box is not None:
                    minx = lat_lon_box.get("minx")
                    miny = lat_lon_box.get("miny")
                    maxx = lat_lon_box.get("maxx")
                    maxy = lat_lon_box.get("maxy")
                    if all([minx, miny, maxx, maxy]):
                        return [
                            float(minx),
                            float(miny),
                            float(maxx),
                            float(maxy),
                        ]

        return None
    except (httpx.RequestError, etree.LxmlError, ValueError) as e:
        logger.error("Error discovering WMS extent for %s: %s", layer_name, e)
        return None


async def load_layers() -> None:
    """Loads customlayers.json and discovers missing extents."""
    global layers_cache, overlay_layers_cache, file_overlays_cache

    file_overlays_cache = await scan_file_overlays()

    config_filename = settings.layers_config_file

    # Search logic
    config_path = config_filename
    if not await Path(config_path).exists():
        parent_path = os.path.join("..", config_filename)
        if await Path(parent_path).exists():
            config_path = parent_path
            logger.info("Found config at %s", config_path)

    if not await Path(config_path).exists():
        logger.warning(
            "Layer config file %s not found in . or .. . Using OSM fallback.",
            config_filename,
        )
        layers_cache = [
            {
                "name": "OpenStreetMap",
                "type": "xyz",
                "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                "attribution": "© OpenStreetMap contributors",
                "category": "World Layers",
            }
        ]
        overlay_layers_cache = []
        return

    try:
        path = Path(config_path)
        content = await path.read_text()
        layers = json.loads(content)

        processed_base = []
        processed_overlays = []
        for layer in layers:
            is_wms = layer.get("type") == "wms"
            has_rect = layer.get("rectangle")
            has_layers = layer.get("layers")

            if is_wms and not has_rect and has_layers:
                logger.info("Auto-discovery of extent for: %s", layer.get("name"))
                extent = await fetch_wms_extent(layer["url"], layer["layers"])
                if extent:
                    logger.info(
                        "Discovered extent for %s: %s",
                        layer.get("name"),
                        extent,
                    )
                    layer["rectangle"] = extent
                else:
                    logger.warning(
                        "Could not discover extent for %s.", layer.get("name")
                    )

            # Check for both "overlay" and "is_overlay" keys
            if layer.get("overlay") or layer.get("is_overlay"):
                # Normalize key for frontend
                layer["overlay"] = True
                processed_overlays.append(layer)
            else:
                processed_base.append(layer)

        layers_cache = processed_base
        overlay_layers_cache = processed_overlays
        logger.info(
            "Loaded %s base maps and %s overlays from %s",
            len(layers_cache),
            len(overlay_layers_cache),
            config_path,
        )
    except (OSError, json.JSONDecodeError) as e:
        logger.error(f"Failed to load layers config: {e}")
        layers_cache = []
        overlay_layers_cache = []


async def get_app_config() -> dict[str, Any]:
    """Gather all frontend configuration."""
    return {
        "app_title": settings.app_title,
        "center_alert": settings.center_alert,
        "initial_lat": settings.initial_lat,
        "initial_lon": settings.initial_lon,
        "iconsets": iconsets_cache,
        "terrain_url": settings.terrain_url,
        "terrain_exaggeration": settings.terrain_exaggeration,
        "imagery_layers": layers_cache,
        "overlay_layers": overlay_layers_cache + file_overlays_cache,
        "cesium_ion_token": settings.cesium_ion_token,
        "logo": settings.logo,
        "logo_position": settings.logo_position,
        "tak_staff_comments": settings.tak_staff_comments,
    }
