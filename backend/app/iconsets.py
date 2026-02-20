#!/usr/bin/env python3
# iconsets.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import logging
import os
from typing import Any

from lxml import etree

logger = logging.getLogger("tak-webview.iconsets")

iconsets_cache: dict[str, dict[str, Any]] = {}


def load_iconsets(directory: str, base_url_path: str) -> dict[str, str]:
    """Scan a directory for iconset.xml files and cache them.
    Returns a mapping of UUID to absolute filesystem path for mounting."""
    mounts: dict[str, str] = {}
    if not os.path.exists(directory):
        logger.warning(f"Iconset directory does not exist: {directory}")
        return mounts

    for root, _, files in os.walk(directory):
        if "iconset.xml" in files:
            try:
                path = os.path.join(root, "iconset.xml")
                tree = etree.parse(path)
                iconset = tree.getroot()
                uid = iconset.get("uid")
                name = iconset.get("name")
                if uid:
                    type_map: dict[str, str] = {}
                    for icon in iconset.findall(".//icon"):
                        type_attr = icon.get("type")
                        src_attr = icon.get("src")
                        name_attr = icon.get("name")
                        group_attr = icon.get("groupName")

                        # Handle both <icon type="..." src="..." />
                        # and <icon name="..." groupName="..." />
                        if type_attr and src_attr:
                            type_map[type_attr] = src_attr
                        elif name_attr and group_attr:
                            # Map group/name to name for generic icons
                            type_map[f"{group_attr}/{name_attr}"] = (
                                f"{group_attr}/{name_attr}"
                            )

                    iconsets_cache[uid] = {
                        "name": name or uid,
                        "url_path": f"{base_url_path}/{uid}",
                        "type_map": type_map,
                    }
                    mounts[uid] = root
                    logger.info(f"Loaded iconset: {name or uid} ({uid})")
            except Exception as e:
                logger.error(f"Failed to load iconset in {root}: {e}")
    return mounts
