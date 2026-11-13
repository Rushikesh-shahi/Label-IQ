"""Tests for proxy.py. Standard library only:  python -m unittest discover -s tests -v   (from projects/labeliq-dashboard)."""
import hashlib
import http.client
import json
import logging
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import proxy  # noqa: E402

TOKEN = "TESTTOKEN-0123456789-abcdef"
USER = {"X-Shahi-Email": "someone@shahi.co.in"}


class FakeUpstream(ThreadingHTTPServer):
    """Stands in for the official Label IQ server and records what it receives."""
    daemon_threads = True

    def __init__(self):
        self.seen = []                      # (method, path, headers dict)
        self.reply = (200, {"items": [], "count": 0}, "application/json")
        super().__init__(("127.0.0.1", 0), self._handler())

    def _handler(outer):  # noqa: N805
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _go(self):
                outer.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}))
                status, payload, ctype = outer.reply
                body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            do_GET = do_POST = _go
        return H


def start(server):
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return t


class ProxyTests(unittest.TestCase):
    cache_seconds = 0.0

    def setUp(self):
        self.up = FakeUpstream()
        start(self.up)
        cfg = proxy.Config(upstream_host="127.0.0.1", upstream_port=self.up.server_address[1], scheme="http",
                           token=TOKEN, cache_seconds=self.cache_seconds, timeout=3, max_parallel=4)
        self.px = proxy.ProxyServer(("127.0.0.1", 0), cfg)
        start(self.px)
        self.port = self.px.server_address[1]

    def tearDown(self):
        self.px.shutdown(); self.px.server_close()
        self.up.shutdown(); self.up.server_close()

    def req(self, method, path, headers=None, body=None, raw=False):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            data = r.read()
            return r.status, dict(r.getheaders()), data
        finally:
            c.close()

    # --- who may call -----------------------------------------------------------------------------
    def test_no_sso_header_is_refused_everywhere_except_healthz(self):
        for p in ("/dashboard/", "/dashboard/app.js", "/v1/dashboard/overview", "/v1/scans", "/v1/health", "/"):
            s, _, _ = self.req("GET", p)
            self.assertEqual(s, 401, p)
        self.assertEqual(self.up.seen, [])
        s, _, b = self.req("GET", "/healthz")
        self.assertEqual((s, json.loads(b)), (200, {"status": "ok"}))

    def test_empty_sso_header_is_refused(self):
        s, _, _ = self.req("GET", "/v1/dashboard/overview", {"X-Shahi-Email": "  "})
        self.assertEqual(s, 401)
        self.assertEqual(self.up.seen, [])

    # --- what is forwarded ------------------------------------------------------------------------
    def test_api_is_forwarded_with_the_server_side_token(self):
        self.up.reply = (200, {"items": [{"a": 1}], "count": 1}, "application/json; charset=utf-8")
        s, h, b = self.req("GET", "/v1/dashboard/overview?unitId=u10&from=2026-11-01",
                           {**USER, "Authorization": "Bearer shahi-sso"})
        self.assertEqual(s, 200)
        self.assertEqual(json.loads(b)["count"], 1)
        method, path, hdrs = self.up.seen[-1]
        self.assertEqual((method, path), ("GET", "/v1/dashboard/overview?unitId=u10&from=2026-11-01"))
        self.assertEqual(hdrs["authorization"], f"Bearer {TOKEN}")   # the caller's own value is ignored
        self.assertNotIn("x-shahi-email", hdrs)                       # staff identity is not passed on
        self.assertEqual(h["Cache-Control"], "no-store")

    def test_every_dashboard_api_path_is_forwarded(self):
        for p in sorted(proxy.API_PATHS):
            s, _, _ = self.req("GET", p, USER)
            self.assertEqual(s, 200, p)
        self.assertEqual({x[1] for x in self.up.seen}, set(proxy.API_PATHS))

    def test_health_is_forwarded_without_the_token(self):
        self.up.reply = (200, {"status": "ok"}, "application/json")
        s, _, b = self.req("GET", "/v1/health", USER)
        self.assertEqual((s, json.loads(b)["status"]), (200, "ok"))
        self.assertNotIn("authorization", self.up.seen[-1][2])

    def test_everything_else_is_404_and_never_reaches_the_upstream(self):
        for p in ("/v1/events/batch", "/v1/dashboard/unknown", "/v1/devices/", "/v1/../etc/passwd",
                  "/dashboard/../proxy.py", "/dashboard/proxy.py", "/etc/passwd", "/admin", "/v1"):
            s, _, _ = self.req("GET", p, USER)
            self.assertEqual(s, 404, p)
        self.assertEqual(self.up.seen, [])

    def test_only_get_is_allowed(self):
        for m in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"):
            s, _, _ = self.req(m, "/v1/events/batch", USER, body=b"{}" if m in ("POST", "PUT", "PATCH") else None)
            self.assertEqual(s, 405, m)
        s, _, _ = self.req("POST", "/v1/dashboard/overview", USER, body=b"{}")
        self.assertEqual(s, 405)
        self.assertEqual(self.up.seen, [])

    def test_control_characters_in_the_query_are_refused(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("GET", "/v1/scans?po=a%0d%0aX-Evil:1", skip_host=False)  # percent-encoded: allowed, stays encoded
        for k, v in USER.items():
            c.putheader(k, v)
        c.endheaders()
        r = c.getresponse(); r.read(); c.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(self.up.seen[-1][1], "/v1/scans?po=a%0d%0aX-Evil:1")
        self.assertNotIn("x-evil", self.up.seen[-1][2])
        s, _, _ = self.req("GET", "/v1/scans?" + "a=" + "b" * 2100, USER)
        self.assertEqual(s, 400)

    # --- upstream problems ------------------------------------------------------------------------
    def test_upstream_refusing_the_token_is_a_502_not_a_401(self):
        for code in (401, 403):
            self.up.reply = (code, {"error": "nope"}, "application/json")
            s, _, b = self.req("GET", "/v1/dashboard/overview", USER)
            self.assertEqual(s, 502)
            self.assertNotIn(TOKEN, b.decode())
            self.assertIn("did not accept", json.loads(b)["error"])

    def test_upstream_server_error_is_a_502(self):
        self.up.reply = (500, {"error": "boom"}, "application/json")
        s, _, b = self.req("GET", "/v1/devices", USER)
        self.assertEqual(s, 502)

    def test_upstream_client_errors_pass_through(self):
        self.up.reply = (400, {"error": "unknown parameter: x"}, "application/json")
        s, _, b = self.req("GET", "/v1/scans?x=1", USER)
        self.assertEqual((s, json.loads(b)["error"]), (400, "unknown parameter: x"))

    def test_non_json_answer_is_a_502(self):
        self.up.reply = (200, b"<html>login</html>", "text/html")
        s, _, _ = self.req("GET", "/v1/devices", USER)
        self.assertEqual(s, 502)

    def test_upstream_down_is_a_502_with_a_plain_message(self):
        self.up.shutdown(); self.up.server_close()
        s, _, b = self.req("GET", "/v1/devices", USER)
        self.assertEqual(s, 502)
        self.assertIn("cannot be reached", json.loads(b)["error"])
        self.up = FakeUpstream()  # so tearDown has something to close
        start(self.up)

    # --- static files -----------------------------------------------------------------------------
    def test_dashboard_files_are_served_and_app_js_is_unchanged(self):
        s, h, b = self.req("GET", "/dashboard/", USER)
        self.assertEqual(s, 200)
        self.assertIn(b"sso-login.js", b)
        self.assertIn("default-src 'none'", h["Content-Security-Policy"])
        self.assertEqual(h["X-Frame-Options"], "DENY")
        s, _, js = self.req("GET", "/dashboard/app.js", USER)
        with open(os.path.join(proxy.STATIC_DIR, "app.js"), "rb") as f:
            self.assertEqual(hashlib.sha256(js).digest(), hashlib.sha256(f.read()).digest())
        for p in ("/dashboard/app.css", "/dashboard/shahi_logo.png", "/dashboard/sso-login.js"):
            self.assertEqual(self.req("GET", p, USER)[0], 200, p)
        for p in ("/", "/dashboard"):
            s, h, _ = self.req("GET", p, USER)
            self.assertEqual((s, h["Location"]), (302, "/dashboard/"))

    def test_token_never_appears_in_any_response_or_log(self):
        with self.assertLogs("labeliq_proxy", level="INFO") as cm:
            for p in ("/dashboard/", "/v1/dashboard/overview", "/v1/devices?x=1", "/nope"):
                s, h, b = self.req("GET", p, USER)
                self.assertNotIn(TOKEN, b.decode("latin-1"))
                self.assertNotIn(TOKEN, json.dumps(h))
            self.up.reply = (401, {}, "application/json")
            self.req("GET", "/v1/devices?y=2", USER)
        self.assertNotIn(TOKEN, "\n".join(cm.output))
        self.assertNotIn(TOKEN, repr(self.px.cfg))

    def test_access_log_names_the_user_and_path_only(self):
        with self.assertLogs("labeliq_proxy", level="INFO") as cm:
            self.req("GET", "/v1/scans?po=SECRETPO", USER)
        line = "\n".join(cm.output)
        self.assertIn("someone@shahi.co.in", line)
        self.assertIn("/v1/scans", line)
        self.assertNotIn("SECRETPO", line)   # query values (PO numbers, device ids) are not logged


class CacheTests(ProxyTests):
    cache_seconds = 0.4

    def test_identical_requests_are_served_from_cache_for_a_moment(self):
        self.assertEqual(self.req("GET", "/v1/dashboard/units", USER)[0], 200)
        self.assertEqual(self.req("GET", "/v1/dashboard/units", USER)[0], 200)
        self.assertEqual(len([x for x in self.up.seen if x[1] == "/v1/dashboard/units"]), 1)
        self.assertEqual(self.req("GET", "/v1/dashboard/units?variant=U10", USER)[0], 200)  # other query: other entry
        self.assertEqual(len(self.up.seen), 2)
        time.sleep(0.5)
        self.assertEqual(self.req("GET", "/v1/dashboard/units", USER)[0], 200)
        self.assertEqual(len(self.up.seen), 3)

    def test_errors_are_not_cached(self):
        self.up.reply = (500, {}, "application/json")
        self.req("GET", "/v1/devices", USER)
        self.up.reply = (200, {"items": [], "count": 0}, "application/json")
        self.assertEqual(self.req("GET", "/v1/devices", USER)[0], 200)

    def test_the_cache_is_shared_between_users_but_the_gate_is_not(self):
        self.req("GET", "/v1/devices", USER)
        self.assertEqual(self.req("GET", "/v1/devices")[0], 401)   # no header: refused even when cached


class ConfigTests(unittest.TestCase):
    def test_short_or_missing_token_stops_the_start(self):
        for t in ("", "short"):
            os.environ["LABELIQ_MASTER_TOKEN"] = t
            with self.assertRaises(SystemExit):
                proxy.Config.from_env()
        del os.environ["LABELIQ_MASTER_TOKEN"]
        with self.assertRaises(SystemExit):
            proxy.Config.from_env()

    def test_https_context_verifies_certificates(self):
        import ssl
        os.environ["LABELIQ_MASTER_TOKEN"] = TOKEN
        cfg = proxy.Config.from_env()
        self.assertEqual(cfg.scheme, "https")
        srv = proxy.ProxyServer(("127.0.0.1", 0), cfg)
        try:
            self.assertEqual(srv.ssl_ctx.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(srv.ssl_ctx.check_hostname)
        finally:
            srv.server_close()
            del os.environ["LABELIQ_MASTER_TOKEN"]

    def test_the_bundled_intermediate_certificate_loads(self):
        import ssl
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cafile=os.path.join(proxy.HERE, "certs", "geotrust-tls-rsa-ca-g1.pem"))


if __name__ == "__main__":
    logging.disable(logging.NOTSET)
    unittest.main()
