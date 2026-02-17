import json
import logging
import os
from typing import Any

import httpx
from anyio import Path
from lxml import etree

from .config import settings

logger = logging.getLogger("tak-webview.layers")

# Initialize as an empty list that we will mutate
layers_cache: list[dict[str, Any]] = []


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
                        return [float(west), float(south), float(east), float(north)]

                lat_lon_box = el.find(".//{*}LatLonBoundingBox")
                if lat_lon_box is not None:
                    minx = lat_lon_box.get("minx")
                    miny = lat_lon_box.get("miny")
                    maxx = lat_lon_box.get("maxx")
                    maxy = lat_lon_box.get("maxy")
                    if all([minx, miny, maxx, maxy]):
                        return [float(minx), float(miny), float(maxx), float(maxy)]

        return None
    except Exception as e:
        logger.error("Error discovering WMS extent for %s: %s", layer_name, e)
        return None


async def load_layers() -> None:
    """Loads customlayers.json and discovers missing extents."""
    global layers_cache
    config_filename = settings.layers_config_file
    
    # Debug current environment
    logger.info("Current working directory: %s", os.getcwd())
    
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
        layers_cache.clear()
        layers_cache.append({
            "name": "OpenStreetMap",
            "type": "xyz",
            "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "attribution": "© OpenStreetMap contributors",
            "category": "World Layers"
        })
        return

    try:
        path = Path(config_path)
        content = await path.read_text()
        layers = json.loads(content)

        processed_layers = []
        for layer in layers:
            is_wms = layer.get("type") == "wms"
            has_rect = layer.get("rectangle")
            has_layers = layer.get("layers")

            if is_wms and not has_rect and has_layers:
                logger.info("Auto-discovery of extent for: %s", layer.get("name"))
                extent = await fetch_wms_extent(layer["url"], layer["layers"])
                if extent:
                    logger.info(
                        "Discovered extent for %s: %s", layer.get("name"), extent
                    )
                    layer["rectangle"] = extent
                else:
                    logger.warning(
                        "Could not discover extent for %s.", layer.get("name")
                    )

            processed_layers.append(layer)

        # Update the global list in-place
        layers_cache.clear()
        layers_cache.extend(processed_layers)
        logger.info("Loaded %s imagery layers from %s", len(layers_cache), config_path)
    except Exception as e:
        logger.error("Failed to load layers config: %s", e)
        layers_cache.clear()
