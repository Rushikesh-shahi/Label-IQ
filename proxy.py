"""Label IQ dashboard on shahi-server: serves Shahi IT's Master Dashboard and forwards its read-only API calls to the
official Label IQ server (labeliq.shahi.co.in, reachable only from the Centaurus network), adding the master token
on this side. Standard library only.

  browser --(Shahi SSO, Traefik)--> this proxy --(HTTPS, Centaurus Wi-Fi, master token)--> official Label IQ server

Rules this file enforces (each one has a test in tests/test_proxy.py):
  * GET only. Nothing else is ever forwarded, so the tablets' write endpoint (POST /v1/events/batch) is unreachable.
  * Only the paths the dashboard uses are forwarded (API_PATHS). Everything else answers 404.
  * A request without the X-Shahi-Email header (set by Shahi SSO in Traefik, which a visitor cannot forge) is
    refused, so the master token is never used for a caller who did not pass the SSO check.
  * The caller's own Authorization header is ignored; the token comes only from the environment (a Kubernetes Secret).
  * The token is never logged and never sent to the browser. If the official server refuses it (401/403) the
    browser gets a 502 with a plain message, not a 401 (a 401 would sign the dashboard out).
  * Answers are cached for a few seconds and upstream calls are limited in number, so many open dashboards (each
    refreshes every 10 s) do not load the official server.
  * The official server's certificate is always verified (system roots plus the public GeoTrust intermediate in
    certs/, because that server sends only its own certificate and not the intermediate).
"""
from __future__ import annotations

import http.client
import json
import logging
import os
import re
import ssl
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import urlsplit

log = logging.getLogger("labeliq_proxy")

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

# Fixed allow-list: URL path -> (file in static/, content type). No request path is ever joined onto the disk.
STATIC_FILES = {
    "/dashboard/": ("index.html", "text/html; charset=utf-8"),
    "/dashboard/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/dashboard/app.css": ("app.css", "text/css; charset=utf-8"),
    "/dashboard/shahi_logo.png": ("shahi_logo.png", "image/png"),
    "/dashboard/sso-login.js": ("sso-login.js", "text/javascript; charset=utf-8"),
}
REDIRECTS = {"/": "/dashboard/", "/dashboard": "/dashboard/"}

# Everything the dashboard (app.js) calls, all GET. Anything else is not forwarded.
API_PATHS = frozenset({
    "/v1/devices", "/v1/builds", "/v1/scans", "/v1/sessions",
    "/v1/dashboard/overview", "/v1/dashboard/units", "/v1/dashboard/pos",
    "/v1/dashboard/fleet", "/v1/dashboard/activity",
})
HEALTH_PATH = "/v1/health"  # official server's health page; needs no token

# Same policy as the original server's dashboard.
STATIC_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
MAX_QUERY = 2000
MIN_TOKEN = 16
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass
class Config:
    upstream_host: str
    upstream_port: int = 443
    scheme: str = "https"                      # "http" only in tests
    token: str = field(default="", repr=False)  # never printed
    ca_file: Optional[str] = None
    cache_seconds: float = 5.0
    timeout: float = 15.0
    max_parallel: int = 4
    max_body: int = 16 * 1024 * 1024

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ
        token = env.get("LABELIQ_MASTER_TOKEN", "").strip()
        if len(token) < MIN_TOKEN:
            raise SystemExit("LABELIQ_MASTER_TOKEN is missing or too short (Kubernetes Secret labeliq)")
        return cls(
            upstream_host=env.get("LABELIQ_UPSTREAM_HOST", "labeliq.shahi.co.in"),
            upstream_port=int(env.get("LABELIQ_UPSTREAM_PORT", "443")),
            scheme=env.get("LABELIQ_UPSTREAM_SCHEME", "https"),
            token=token,
            ca_file=env.get("LABELIQ_CA_FILE") or None,
            cache_seconds=float(env.get("LABELIQ_CACHE_SECONDS", "5")),
            timeout=float(env.get("LABELIQ_TIMEOUT", "15")),
            max_parallel=int(env.get("LABELIQ_MAX_PARALLEL", "4")),
        )


def _read_static(static_dir: str) -> dict[str, tuple[bytes, str]]:
    out: dict[str, tuple[bytes, str]] = {}
    for url_path, (name, ctype) in STATIC_FILES.items():
        with open(os.path.join(static_dir, name), "rb") as f:  # fail at start-up if a file is missing
            out[url_path] = (f.read(), ctype)
    return out


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], cfg: Config, static_dir: str = STATIC_DIR):
        self.cfg = cfg
        self.static = _read_static(static_dir)
        self.ssl_ctx: Optional[ssl.SSLContext] = None
        if cfg.scheme == "https":
            self.ssl_ctx = ssl.create_default_context()  # verifies certificate and host name
            if cfg.ca_file:
                self.ssl_ctx.load_verify_locations(cafile=cfg.ca_file)
        self.slots = threading.BoundedSemaphore(cfg.max_parallel)
        self.cache: dict[tuple[str, bool], tuple[float, int, bytes, str]] = {}
        self.cache_lock = threading.Lock()
        super().__init__(address, Handler)

    # --- one call to the official server ---------------------------------------------------------
    def upstream_get(self, path_query: str, with_token: bool) -> tuple[int, bytes, str, str]:
        """Returns (status, body, content_type, cache_note). Never raises for network problems."""
        key = (path_query, with_token)
        now = time.monotonic()
        if self.cfg.cache_seconds > 0:
            with self.cache_lock:
                hit = self.cache.get(key)
            if hit and hit[0] > now:
                return hit[1], hit[2], hit[3], "hit"
        if not self.slots.acquire(timeout=5):
            return 503, _err("The Label IQ server is busy; retrying"), "application/json; charset=utf-8", "busy"
        try:
            status, body, ctype = self._request(path_query, with_token)
        finally:
            self.slots.release()
        if status == 200 and self.cfg.cache_seconds > 0:
            with self.cache_lock:
                if len(self.cache) > 300:
                    self.cache = {k: v for k, v in self.cache.items() if v[0] > now}
                    if len(self.cache) > 300:
                        self.cache.clear()
                self.cache[key] = (time.monotonic() + self.cfg.cache_seconds, status, body, ctype)
        return status, body, ctype, "miss"

    def _request(self, path_query: str, with_token: bool) -> tuple[int, bytes, str]:
        cfg = self.cfg
        json_type = "application/json; charset=utf-8"
        headers = {"Accept": "application/json", "User-Agent": "shahi-labeliq-proxy/1", "Connection": "close"}
        if with_token:
            headers["Authorization"] = f"Bearer {cfg.token}"
        conn: http.client.HTTPConnection
        if cfg.scheme == "https":
            conn = http.client.HTTPSConnection(cfg.upstream_host, cfg.upstream_port, timeout=cfg.timeout,
                                               context=self.ssl_ctx)
        else:
            conn = http.client.HTTPConnection(cfg.upstream_host, cfg.upstream_port, timeout=cfg.timeout)
        try:
            conn.request("GET", path_query, headers=headers)
            resp = conn.getresponse()
            body = resp.read(cfg.max_body + 1)
        except http.client.InvalidURL:
            return 400, _err("bad request"), json_type
        except ssl.SSLCertVerificationError:
            log.error("upstream certificate could not be verified")
            return 502, _err("The Label IQ server's certificate could not be verified"), json_type
        except (OSError, http.client.HTTPException) as e:
            log.warning("upstream unreachable: %s", type(e).__name__)
            return 502, _err("The Label IQ server cannot be reached from shahi-server"), json_type
        finally:
            conn.close()
        if len(body) > cfg.max_body:
            return 502, _err("The Label IQ server's answer was too large"), json_type
        if resp.status in (401, 403):
            log.error("upstream refused the master token (HTTP %d)", resp.status)
            return 502, _err("The Label IQ server did not accept shahi-server's master token"), json_type
        if resp.status >= 500:
            return 502, _err(f"The Label IQ server had an error (HTTP {resp.status})"), json_type
        ctype = resp.getheader("Content-Type") or json_type
        if not ctype.lower().startswith("application/json"):
            return 502, _err("The Label IQ server sent an unexpected answer"), json_type
        return resp.status, body, ctype


def _err(message: str) -> bytes:
    return json.dumps({"error": message}, separators=(",", ":")).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server: ProxyServer
    server_version = "ShahiLabelIQProxy/1"
    protocol_version = "HTTP/1.1"
    timeout = 30

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - we write our own access line
        return

    def log_error(self, format: str, *args) -> None:  # noqa: A002
        return

    # --- helpers ---------------------------------------------------------------------------------
    def _send(self, status: int, body: bytes, ctype: str, extra: Optional[dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status: int, message: str) -> None:
        self._send(status, _err(message), "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def _log(self, status: int, started: float, path: str, who: str, note: str = "") -> None:
        ms = int((time.monotonic() - started) * 1000)
        log.info("%s %s %d %dms user=%s%s", self.command, path, status, ms, who or "-", f" {note}" if note else "")

    # --- methods ---------------------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        started = time.monotonic()
        if not self.path.startswith("/"):
            self._json_error(400, "bad request")
            return
        url = urlsplit(self.path)
        path = url.path
        who = _CTRL.sub("", self.headers.get("X-Shahi-Email", "")).strip()[:80]

        if path == "/healthz":  # for Kubernetes probes only; answers nothing about the upstream
            self._send(200, b'{"status":"ok"}', "application/json; charset=utf-8", {"Cache-Control": "no-store"})
            return

        known = path in REDIRECTS or path in STATIC_FILES or path in API_PATHS or path == HEALTH_PATH
        if not known:
            self._json_error(404, "not found")
            self._log(404, started, path, who)
            return
        if not who:  # Traefik only forwards a request after Shahi SSO set this header
            self._json_error(401, "sign-in required")
            self._log(401, started, path, who)
            return

        if path in REDIRECTS:
            self._send(302, b"", "text/plain", {"Location": REDIRECTS[path], "Cache-Control": "no-store"})
            self._log(302, started, path, who)
            return
        if path in STATIC_FILES:
            body, ctype = self.server.static[path]
            self._send(200, body, ctype, {"Cache-Control": "no-cache", "Content-Security-Policy": STATIC_CSP})
            self._log(200, started, path, who)
            return

        if len(url.query) > MAX_QUERY or _CTRL.search(url.query):
            self._json_error(400, "bad request")
            self._log(400, started, path, who)
            return
        path_query = path + (f"?{url.query}" if url.query else "")
        status, body, ctype, note = self.server.upstream_get(path_query, with_token=(path != HEALTH_PATH))
        self._send(status, body, ctype, {"Cache-Control": "no-store"})
        self._log(status, started, path, who, note)

    def _not_allowed(self) -> None:
        self.close_connection = True  # a body we never read must not be mistaken for the next request
        self._json_error(405, "read-only: only GET is allowed")

    do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _not_allowed


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.from_env()
    port = int(os.environ.get("PORT", "8000"))
    srv = ProxyServer((os.environ.get("BIND", "0.0.0.0"), port), cfg)
    log.info("Label IQ dashboard proxy on :%d -> %s://%s:%d (cache %.0fs, max %d parallel)",
             port, cfg.scheme, cfg.upstream_host, cfg.upstream_port, cfg.cache_seconds, cfg.max_parallel)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
