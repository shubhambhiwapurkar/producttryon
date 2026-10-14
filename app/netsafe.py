"""HTTP client for fetching URLs supplied by users (store websites, image links).

Refuses requests to private, loopback and link-local addresses so an imported
"website" cannot be used to reach internal services. Checked on every request,
including redirects.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

import httpx


class BlockedURL(httpx.RequestError):
    pass


def _check(request: httpx.Request) -> None:
    host = request.url.host
    if request.url.scheme not in ("http", "https") or not host:
        raise BlockedURL(f"Blocked URL: {request.url}", request=request)
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise httpx.ConnectError(f"Cannot resolve {host}", request=request) from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise BlockedURL(f"Blocked non-public address for {host}", request=request)


def safe_client(timeout: float = 20) -> httpx.Client:
    return httpx.Client(
        timeout=timeout,
        follow_redirects=True,
        headers={"User-Agent": "ProductTryOnImporter/0.1"},
        event_hooks={"request": [_check]},
    )


def fetch_image(client: httpx.Client, url: str, max_bytes: int) -> bytes:
    if urlsplit(url).scheme not in ("http", "https"):
        raise BlockedURL(f"Blocked URL: {url}")
    with client.stream("GET", url) as resp:
        resp.raise_for_status()
        data = bytearray()
        for chunk in resp.iter_bytes():
            data.extend(chunk)
            if len(data) > max_bytes:
                raise ValueError("Image too large")
    return bytes(data)
