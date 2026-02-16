import uvicorn

from app.config import settings

if __name__ == "__main__":
    # If trusted_proxies is set, we tell uvicorn which IPs to trust for headers
    # Standard behavior is to trust all if we use "*" (careful in public nets)
    # or specific IPs.
    forwarded_ips = (
        ",".join(settings.trusted_proxies) if settings.trusted_proxies else None
    )
    
    uvicorn.run(
        "app.main:app", 
        host="0.0.0.0", 
        port=settings.port, 
        reload=False,  # Set to False for production/Docker
        proxy_headers=True,
        forwarded_allow_ips=forwarded_ips or "127.0.0.1"
    )
