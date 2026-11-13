"""Tests for report.py and upstream.py. Standard library only:  python -m unittest discover -s tests -v"""
import datetime
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import proxy  # noqa: E402
import report  # noqa: E402
import upstream  # noqa: E402

IST = report.IST
TOKEN = "TESTTOKEN-0123456789-abcdef"
WA_KEY = "WAKEY-abcdef-0123456789"
DAY = "2026-11-13"
NOW = datetime.datetime(2026, 11, 13, 18, 30, tzinfo=IST)


def ts(hour, minute=0):
    return int(datetime.datetime(2026, 11, 13, hour, minute, tzinfo=IST).timestamp() * 1000)


NOW_MS = int(NOW.timestamp() * 1000)
DAYS = 86400 * 1000


def item(unit, label, key, last_seen=NOW_MS - 3600_000, variant=None):
    return {"unitId": unit, "variant": variant or unit.upper(), "deviceLabel": label, "tabletKey": key,
            "lastSeen": last_seen}


def scan(unit, label, key, hour, result="MATCH", variant=None, minute=5):
    return {"unitId": unit, "variant": variant or unit.upper(), "tsDevice": ts(hour, minute),
            "device": {"installId": "i-" + label, "androidIdHash": key, "label": label},
            "scan": {"result": result}}


FLEET = {"day": DAY, "items": [
    item("u44", "U44-old", "A", last_seen=NOW_MS - 5 * DAYS),        # same tablet, older label
    item("u44", "U44-aaa", "A"),
    item("u44", "U44-bbb", "B"),
    item("u44", "U44-ccc", "C"),                                      # recent, no scans today
    item("u44", "U44-ddd", "D", last_seen=NOW_MS - 30 * DAYS),        # stale: not allocated
    item("u10", "U10-xxx", "X"),
    item("u35", "U35-demo", "Z", variant="uniqloU35Demo"),
    item("u35", "PC-DIAG", "P"),
    item("u35", "U35-real", "R"),
]}
SCANS = [
    scan("u44", "U44-aaa", "A", 9), scan("u44", "U44-aaa", "A", 9, "MISMATCH"), scan("u44", "U44-aaa", "A", 11, "INCOMPLETE"),
    scan("u44", "U44-bbb", "B", 15),
    scan("u10", "U10-xxx", "X", 10), scan("u10", "U10-xxx", "X", 10),
    scan("u35", "U35-demo", "Z", 10, variant="uniqloU35Demo"),
    scan("u35", "PC-DIAG", "P", 10),
]


class Fake(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, handler_cls):
        super().__init__(("127.0.0.1", 0), handler_cls)
        self.log = []
        self.statuses = []           # gateway: statuses to answer in order, then 200

    @property
    def port(self):
        return self.server_address[1]


def make_upstream(fleet, scans):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            u = urlsplit(self.path); q = parse_qs(u.query)
            self.server.log.append((u.path, dict(self.headers.items()), q))
            if u.path == "/v1/dashboard/fleet":
                body = fleet
            elif u.path == "/v1/scans":
                lim, off = int(q["limit"][0]), int(q["offset"][0])
                body = {"items": scans[off:off + lim], "hasMore": off + lim < len(scans)}
            else:
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
            data = json.dumps(body).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    return Fake(H)


def make_gateway():
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n))
            self.server.log.append((self.path, dict(self.headers.items()), body))
            status = self.server.statuses.pop(0) if self.server.statuses else 200
            self.send_response(status); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
    return Fake(H)


def serve(s):
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


class Base(unittest.TestCase):
    def setUp(self):
        self.up = serve(make_upstream(FLEET, SCANS))
        self.gw = serve(make_gateway())
        self.cfg = proxy.Config(upstream_host="127.0.0.1", upstream_port=self.up.port, scheme="http", token=TOKEN,
                                timeout=3)
        self.wa = f"http://127.0.0.1:{self.gw.port}/api"

    def tearDown(self):
        for s in (self.up, self.gw):
            s.shutdown(); s.server_close()

    def units(self, allocated=None, scans=SCANS, fleet=FLEET):
        return report.build_units(fleet, scans, NOW_MS, 7, ("PC-",), allocated)

    def go(self, settings, **kw):
        out = io.StringIO()
        code = report.run(self.cfg, settings, self.wa, WA_KEY, "default", now=NOW, out=out, **kw)
        return code, out.getvalue()


class CountingTests(Base):
    def test_tablets_used_allocated_scans_and_hours(self):
        u = self.units()
        self.assertEqual(set(u), {"u44", "u10", "u35"})
        u44 = u["u44"]
        self.assertEqual([t["label"] for t in u44["used"]], ["U44-aaa", "U44-bbb"])   # newest label, most scans first
        self.assertEqual((u44["scans"], u44["match"], u44["mismatch"], u44["incomplete"]), (4, 2, 1, 1))
        self.assertEqual(len(u44["used"]), 2)
        self.assertEqual(u44["allocated"], 3)                       # A, B, C recently seen; D is stale
        self.assertEqual([t["label"] for t in u44["unused"]], ["U44-ccc"])
        a = u44["used"][0]
        self.assertEqual(dict(a["hours"]), {9: 2, 11: 1})
        self.assertEqual(report.hours_line(a), "09–10: 2 · 10–11: 0 · 11–12: 1")   # idle hour in between shows as 0

    def test_demo_builds_and_pc_installs_are_left_out(self):
        u35 = self.units()["u35"]
        self.assertEqual([t["label"] for t in u35["tablets"]], ["U35-real"])
        self.assertEqual(u35["scans"], 0)

    def test_configured_allocation_wins_and_never_below_used(self):
        self.assertEqual(self.units({"u44": 6})["u44"]["allocated"], 6)
        self.assertTrue(self.units({"u44": 6})["u44"]["allocated_configured"])
        self.assertEqual(self.units({"u44": 1})["u44"]["allocated"], 2)      # 2 tablets did scan

    def test_hours_use_indian_time_not_utc(self):
        s = scan("u10", "U10-xxx", "X", 0, minute=10)          # 00:10 IST = 18:40 UTC the day before
        u = self.units(scans=[s])
        self.assertEqual(dict(u["u10"]["used"][0]["hours"]), {0: 1})

    def test_friendly_names_replace_labels(self):
        u = report.build_units(FLEET, SCANS, NOW_MS, 7, ("PC-",), None, {"U44-aaa": "Tab 1", "B": "Tab 2", "x": ""})
        self.assertEqual([t["label"] for t in u["u44"]["used"]], ["Tab 1", "Tab 2"])   # by label, or by tablet key
        self.assertIn("*1. Tab 1* · 3 scans", report.unit_text(u["u44"]))

    def test_names_come_from_the_settings_file(self):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump({"names": {"U44-aaa": "Tab 1"}}, f); f.close()
        self.addCleanup(os.unlink, f.name)
        self.assertEqual(report.load_settings(f.name)["names"], {"U44-aaa": "Tab 1"})

    def test_a_tablet_without_hardware_id_is_keyed_by_install(self):
        s = scan("u10", "U10-xxx", None, 10)
        self.assertEqual(report.tablet_key(s["device"]), "install:i-U10-xxx")


class TextTests(Base):
    def test_unit_text(self):
        t = report.unit_text(self.units()["u44"])
        for part in ("*Unit 44*", "Tablets used: *2 of 3*", "Total scans today: *4*", "✔ Match 2 · ✖ Mismatch 1 · ◌ Incomplete 1",
                     "*1. U44-aaa* · 3 scans", "09–10: 2 · 10–11: 0 · 11–12: 1", "*2. U44-bbb* · 1 scans",
                     "15–16: 1", "Not used today (1): U44-ccc", "_Allocated = tablets that reported in the last 7 days._"):
            self.assertIn(part, t)

    def test_no_note_when_allocation_is_configured_and_quality_line_can_be_off(self):
        t = report.unit_text(self.units({"u44": 3})["u44"], show_quality=False)
        self.assertNotIn("Allocated =", t)
        self.assertNotIn("Match", t)

    def test_quiet_unit(self):
        t = report.unit_text(self.units()["u35"])
        self.assertIn("Tablets used: *0 of 1*", t)
        self.assertIn("Total scans today: *0*", t)

    def test_message_for_several_units_has_a_summary(self):
        u = self.units({"u44": 3, "u10": 2, "u35": 1})
        m = report.message_for([u["u10"], u["u44"]], DAY, "18:30")
        self.assertIn("Fri 13 Nov 2026 · till 18:30", m)
        self.assertIn("All units: tablets used *3 of 5* · total scans *6*", m)
        self.assertLess(m.index("*Unit 10*"), m.index("*Unit 44*"))
        self.assertEqual(m.count("Allocated ="), 0)


class SettingsTests(unittest.TestCase):
    def write(self, data):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, f); f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_missing_file_means_off(self):
        self.assertEqual(report.load_settings("/nonexistent/x.json")["mode"], "off")

    def test_people_are_validated(self):
        s = report.load_settings(self.write({"mode": "LIVE", "demo_to": ["9876543210", "abc"], "allocated": {"U44": 5},
            "people": [{"name": "A", "phone": "9876543210", "units": ["U44", "u10"]},
                       {"name": "B", "phone": "123", "units": ["u10"]},             # bad number
                       {"name": "C", "phone": "919876543211", "units": []},         # no unit
                       {"name": "D", "phone": "919876543212", "units": "all", "live": False}]}))
        self.assertEqual(s["mode"], "live")
        self.assertEqual(s["demo_to"], ["919876543210@c.us"])
        self.assertEqual(s["allocated"], {"u44": 5})
        self.assertEqual([p["name"] for p in s["people"]], ["A", "D"])
        self.assertEqual(s["people"][0]["units"], ["u10", "u44"])
        self.assertTrue(s["people"][1]["all"] and not s["people"][1]["live"])

    def test_unknown_mode_means_off(self):
        self.assertEqual(report.load_settings(self.write({"mode": "yes please"}))["mode"], "off")

    def test_chat_id(self):
        self.assertEqual(report.chat_id("98765 43210"), "919876543210@c.us")
        self.assertEqual(report.chat_id("+91 98765-43210"), "919876543210@c.us")
        self.assertIsNone(report.chat_id("0000000000"))
        self.assertIsNone(report.chat_id(None))


class RunTests(Base):
    PEOPLE = [{"name": "Asha", "role": "PM", "to": "919000000001@c.us", "units": ["u44"], "all": False, "live": True},
              {"name": "Boss", "role": "GM", "to": "919000000002@c.us", "units": [], "all": True, "live": True},
              {"name": "Later", "role": "QA", "to": "919000000003@c.us", "units": ["u10"], "all": False, "live": False}]

    def settings(self, mode, **kw):
        return {"mode": mode, "demo_to": ["919999999999@c.us"], "allocated": {}, "people": self.PEOPLE, **kw}

    def test_upstream_calls_are_read_only_gets_with_the_token(self):
        self.go(self.settings("off"))
        paths = [p for p, _, _ in self.up.log]
        self.assertEqual(paths, ["/v1/dashboard/fleet", "/v1/scans"])
        self.assertTrue(all(h["Authorization"] == f"Bearer {TOKEN}" for _, h, _ in self.up.log))
        self.assertEqual(self.up.log[1][2]["from"], [DAY])
        self.assertEqual(self.gw.log, [])

    def test_scans_are_fetched_page_by_page(self):
        old = report.PAGE
        report.PAGE = 3
        try:
            self.go(self.settings("off"))
        finally:
            report.PAGE = old
        pages = [q["offset"][0] for p, _, q in self.up.log if p == "/v1/scans"]
        self.assertEqual(pages, ["0", "3", "6"])

    def test_off_sends_nothing(self):
        self.assertEqual(self.go(self.settings("off"))[0], 0)
        self.assertEqual(self.gw.log, [])

    def test_print_sends_nothing_and_shows_every_unit(self):
        code, out = self.go(self.settings("live"), print_only=True)
        self.assertEqual(code, 0)
        self.assertEqual(self.gw.log, [])
        for part in ("*Unit 10*", "*Unit 44*", "a person who gets all units receives"):
            self.assertIn(part, out)

    def test_demo_goes_only_to_the_demo_number_one_message_per_person(self):
        code, _ = self.go(self.settings("demo"))
        self.assertEqual(code, 0)
        self.assertEqual({b["chatId"] for _, _, b in self.gw.log}, {"919999999999@c.us"})
        self.assertEqual(len(self.gw.log), 3)                       # all three people, including the not-live one
        texts = [b["text"] for _, _, b in self.gw.log]
        self.assertTrue(all(t.startswith("[DEMO] This is what *") for t in texts))
        self.assertIn("*Asha* (PM)", texts[0])
        path, headers, _ = self.gw.log[0]
        self.assertEqual(path, "/api/sessions/default/messages/send-text")
        self.assertEqual({k.lower(): v for k, v in headers.items()}["x-api-key"], WA_KEY)

    def test_demo_without_a_demo_number_fails_safely(self):
        self.assertEqual(self.go(self.settings("demo", demo_to=[]))[0], 1)
        self.assertEqual(self.gw.log, [])

    def test_live_sends_to_each_live_person_only_their_units(self):
        code, _ = self.go(self.settings("live"))
        self.assertEqual(code, 0)
        sent = {b["chatId"]: b["text"] for _, _, b in self.gw.log}
        self.assertEqual(set(sent), {"919000000001@c.us", "919000000002@c.us"})   # "Later" is not live
        self.assertIn("*Unit 44*", sent["919000000001@c.us"])
        self.assertNotIn("*Unit 10*", sent["919000000001@c.us"])
        self.assertIn("*Unit 10*", sent["919000000002@c.us"])
        self.assertIn("All units:", sent["919000000002@c.us"])
        self.assertNotIn("[DEMO]", sent["919000000001@c.us"])

    def test_a_unit_without_any_data_still_gets_a_message(self):
        p = [{"name": "N", "role": "", "to": "919000000004@c.us", "units": ["u99"], "all": False, "live": True}]
        self.go({"mode": "live", "demo_to": [], "allocated": {}, "people": p})
        self.assertIn("Total scans today: *0*", self.gw.log[0][2]["text"])

    def test_gateway_hiccup_is_retried(self):
        self.gw.statuses = [500, 200]
        old = report.send_text.__defaults__
        report.send_text.__defaults__ = (3, 0.01)
        try:
            code, _ = self.go(self.settings("live", people=self.PEOPLE[:1]))
        finally:
            report.send_text.__defaults__ = old
        self.assertEqual(code, 0)
        self.assertEqual(len(self.gw.log), 2)

    def test_refusal_is_not_retried_and_fails_the_run(self):
        self.gw.statuses = [401]
        code, _ = self.go(self.settings("live", people=self.PEOPLE[:1]))
        self.assertEqual(code, 1)
        self.assertEqual(len(self.gw.log), 1)

    def test_upstream_down_is_an_error_not_a_crash(self):
        self.up.shutdown(); self.up.server_close()
        self.up = serve(make_upstream(FLEET, SCANS))              # so tearDown has something to close
        self.cfg.upstream_port = 1                                 # nothing listens there
        with self.assertRaises(upstream.UpstreamError):
            self.go(self.settings("live"))

    def test_secrets_and_numbers_are_not_logged(self):
        with self.assertLogs("labeliq_report", level="INFO") as cm:
            self.go(self.settings("live"))
        text = "\n".join(cm.output)
        for secret in (TOKEN, WA_KEY, "919000000001", "919000000002"):
            self.assertNotIn(secret, text)
        self.assertIn("sent to Asha", text)


class UpstreamTests(Base):
    def test_token_refused_gives_a_clear_error_without_the_token(self):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers()
        s = serve(Fake(H))
        try:
            cfg = proxy.Config(upstream_host="127.0.0.1", upstream_port=s.port, scheme="http", token=TOKEN, timeout=3)
            with self.assertRaises(upstream.UpstreamError) as cm:
                upstream.Upstream(cfg).get_json("/v1/devices")
            self.assertIn("did not accept the master token", str(cm.exception))
            self.assertNotIn(TOKEN, str(cm.exception))
        finally:
            s.shutdown(); s.server_close()

    def test_https_context_verifies(self):
        import ssl
        cfg = proxy.Config(upstream_host="labeliq.shahi.co.in", token=TOKEN,
                           ca_file=os.path.join(proxy.HERE, "certs", "geotrust-tls-rsa-ca-g1.pem"))
        up = upstream.Upstream(cfg)
        self.assertEqual(up.ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(up.ctx.check_hostname)


if __name__ == "__main__":
    unittest.main()
