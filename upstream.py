"""Read-only client for the official Label IQ server, used by the daily report (report.py).

Same rules as the proxy: GET only, the master token only from the environment, the certificate is always verified
(system roots plus the bundled public intermediate). Standard library only.
"""
from __future__ import annotations

import http.client
import json
import ssl
from typing import Any

from proxy import Config


class UpstreamError(Exception):
    """A readable reason; never contains the token."""


class Upstream:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.ctx = None
        if cfg.scheme == "https":
            self.ctx = ssl.create_default_context()
            if cfg.ca_file:
                self.ctx.load_verify_locations(cafile=cfg.ca_file)

    def get_json(self, path_query: str) -> Any:
        cfg = self.cfg
        if cfg.scheme == "https":
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                cfg.upstream_host, cfg.upstream_port, timeout=cfg.timeout, context=self.ctx)
        else:
            conn = http.client.HTTPConnection(cfg.upstream_host, cfg.upstream_port, timeout=cfg.timeout)
        try:
            conn.request("GET", path_query, headers={
                "Accept": "application/json", "User-Agent": "shahi-labeliq-report/1", "Connection": "close",
                "Authorization": f"Bearer {cfg.token}"})
            resp = conn.getresponse()
            body = resp.read(cfg.max_body + 1)
        except ssl.SSLCertVerificationError:
            raise UpstreamError("the Label IQ server's certificate could not be verified") from None
        except (OSError, http.client.HTTPException) as e:
            raise UpstreamError(f"the Label IQ server cannot be reached ({type(e).__name__})") from None
        finally:
            conn.close()
        if len(body) > cfg.max_body:
            raise UpstreamError("the Label IQ server's answer was too large")
        if resp.status in (401, 403):
            raise UpstreamError(f"the Label IQ server did not accept the master token (HTTP {resp.status})")
        if resp.status != 200:
            raise UpstreamError(f"the Label IQ server answered HTTP {resp.status} for {path_query.split('?')[0]}")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise UpstreamError("the Label IQ server sent an answer that is not JSON") from None
