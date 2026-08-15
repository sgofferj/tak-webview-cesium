#!/usr/bin/env python3
# main.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import uvicorn

from app.config import settings

if __name__ == "__main__":
    # If trusted_proxies is set, we tell uvicorn which IPs to trust for headers
    # Standard behavior is to trust all if we use "*" (careful in public nets)
    # or specific IPs/CIDRs.
    forwarded_ips = settings.trusted_proxies if settings.trusted_proxies else None

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        proxy_headers=True if forwarded_ips else False,
        forwarded_allow_ips=forwarded_ips,
    )
