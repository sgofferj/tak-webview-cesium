import logging
import os
from typing import Any

from lxml import etree

logger = logging.getLogger("tak-webview.iconsets")

iconsets_cache: dict[str, dict[str, Any]] = {}

def load_iconsets(directory: str, mount_prefix: str) -> None:
    """Scans the given directory for iconset.xml files and builds a UID mapping."""
    if not os.path.exists(directory):
        logger.info("Directory %s not found. Skipping.", directory)
        return

    logger.info("Scanning for iconsets in %s...", directory)
    for root, _, files in os.walk(directory):
        if "iconset.xml" in files:
            xml_path = os.path.join(root, "iconset.xml")
            try:
                tree = etree.parse(xml_path)
                iconset_el = tree.getroot()
                uid = iconset_el.get("uid")
                name = iconset_el.get("name")
                if uid:
                    rel_path = os.path.relpath(root, directory)
                    if rel_path == ".":
                        url_path = mount_prefix
                    else:
                        url_path = f"{mount_prefix}/{rel_path}"

                    iconsets_cache[uid] = {
                        "name": name or "Unknown",
                        "url_path": url_path,
                        "icons": {},
                        "type_map": {},
                    }
                    for icon in iconset_el.findall("icon"):
                        icon_name = icon.get("name")
                        type2525b = icon.get("type2525b")
                        if icon_name:
                            iconsets_cache[uid]["icons"][icon_name] = icon_name
                            if type2525b:
                                iconsets_cache[uid]["type_map"][type2525b] = icon_name
                    logger.info("Loaded iconset: %s (UID: %s) from %s", name, uid, root)
            except Exception as exc:
                logger.error("Error parsing iconset at %s: %s", xml_path, exc)
