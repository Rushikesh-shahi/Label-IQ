"""Label IQ daily WhatsApp report, per unit, from the official Label IQ server (read-only).

For every unit: how many tablets were used out of the tablets allocated, the scans of each tablet, the total scans
today, and in which hours each tablet scanned. Sent through the same WhatsApp gateway as the Garment Tracker alerts.

  python report.py --print      show every unit's text and what each person would get; sends nothing
  python report.py --week       weekly summary (Monday to today), one message per unit; same modes as below;
                                  add --print to only show it
  python report.py              the scheduled run (Kubernetes CronJob): mode comes from report.json
                                  off  = does nothing (default), demo = sends only to the demo numbers,
                                  live = sends to the people with "live": true

report.json (Kubernetes Secret labeliq-report, never in git):
  {"mode": "off|demo|live", "demo_to": ["91XXXXXXXXXX"],
   "allocated": {"u10": 4, "u21": 6, "u35": 8, "u44": 5},          # tablets allocated per unit (optional)
   "names": {"U44-603ec46d": "Tab 1", "U44-60016181": "Tab 2"},    # friendly names for tablets (optional)
   "people": [{"name": "...", "role": "...", "phone": "91XXXXXXXXXX", "units": ["u10", "u21"] or "all", "live": true}]}
Without an "allocated" number a unit's allocation is the tablets that reported in the last LABELIQ_ACTIVE_DAYS days.
"""
from __future__ import annotations

import collections
import datetime
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from proxy import Config
from upstream import Upstream, UpstreamError

log = logging.getLogger("labeliq_report")

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
PAGE = 1000
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---- helpers -------------------------------------------------------------------------------------------------------
def chat_id(phone: Any) -> Optional[str]:
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) == 10:
        digits = "91" + digits
    if len(digits) < 11 or set(digits[-10:]) == {"0"}:      # too short, or a placeholder such as 0000000000
        return None
    return f"{digits}@c.us"


def masked(chat: str) -> str:
    digits = chat.split("@")[0]
    return f"{digits[:2]}…{digits[-3:]}"


def unit_title(unit_id: str) -> str:
    digits = re.sub(r"\D", "", unit_id)
    return f"Unit {digits}" if digits else unit_id.upper()


def unit_sort(unit_id: str) -> tuple[int, str]:
    digits = re.sub(r"\D", "", unit_id)
    return (int(digits) if digits else 10 ** 6, unit_id)


def hour_range(h: int) -> str:
    return f"{h:02d}–{(h + 1) % 24:02d}"


# ---- the numbers ---------------------------------------------------------------------------------------------------
def tablet_key(device: dict) -> str:
    """Same rule as the dashboard: the hardware id, or the install when a tablet reports none."""
    return device.get("androidIdHash") or f"install:{device.get('installId')}"


def keep(variant: Any, label: Any, exclude_prefixes: tuple[str, ...]) -> bool:
    """Demo builds and PC test installs are not production tablets."""
    if "demo" in str(variant or "").lower():
        return False
    return not any(str(label or "").upper().startswith(p.upper()) for p in exclude_prefixes if p)


def build_units(fleet: dict, scans: list[dict], now_ms: int, active_days: int = 7,
                exclude_prefixes: tuple[str, ...] = ("PC-",), allocated: Optional[dict] = None,
                names: Optional[dict] = None, count: str = "match") -> dict[str, dict]:
    """Per unit id: tablets (scans, results, hours), used, allocated, totals. Pure function (tested).
    count="match" (default): the numbers shown (per tablet, per hour, total) are MATCH scans only, as the tablets'
    own PO counting does. count="all": every scan event. A tablet counts as used when it scanned anything at all."""
    allocated = allocated or {}
    names = {str(k).strip(): str(v).strip() for k, v in (names or {}).items() if str(v).strip()}
    recent_ms = now_ms - active_days * 86400 * 1000
    units: dict[str, dict] = {}

    def unit(uid: str) -> dict:
        return units.setdefault(uid, {"tablets": {}, "known": set()})

    def tablet(uid: str, key: str) -> dict:
        t = unit(uid)["tablets"].get(key)
        if t is None:
            t = {"key": key, "label": "", "label_ts": -1, "scans": 0, "match": 0, "mismatch": 0, "incomplete": 0,
                 "hours": collections.Counter()}
            unit(uid)["tablets"][key] = t
        return t

    for it in fleet.get("items", []):
        uid = str(it.get("unitId") or "").lower()
        if not uid or not keep(it.get("variant"), it.get("deviceLabel"), exclude_prefixes):
            continue
        key = it.get("tabletKey") or tablet_key(it)
        t = tablet(uid, key)
        ls = int(it.get("lastSeen") or 0)
        if ls > t["label_ts"] and it.get("deviceLabel"):
            t["label"], t["label_ts"] = str(it["deviceLabel"]), ls
        if ls >= recent_ms:
            unit(uid)["known"].add(key)

    for r in scans:
        uid = str(r.get("unitId") or "").lower()
        dev = r.get("device") or {}
        if not uid or not keep(r.get("variant"), dev.get("label"), exclude_prefixes):
            continue
        t = tablet(uid, tablet_key(dev))
        if not t["label"] and dev.get("label"):
            t["label"] = str(dev["label"])
        t["scans"] += 1
        result = str((r.get("scan") or {}).get("result") or "").upper()
        if result == "MATCH":
            t["match"] += 1
        elif result == "MISMATCH":
            t["mismatch"] += 1
        else:
            t["incomplete"] += 1
        ts = r.get("tsDevice")
        if isinstance(ts, (int, float)) and (count == "all" or result == "MATCH"):
            t["hours"][datetime.datetime.fromtimestamp(ts / 1000, IST).hour] += 1
        unit(uid)["known"].add(tablet_key(dev))

    out: dict[str, dict] = {}
    for uid, u in units.items():
        for t in u["tablets"].values():
            t["counted"] = t["scans"] if count == "all" else t["match"]
        tabs = sorted(u["tablets"].values(), key=lambda t: (-t["counted"], t["label"] or t["key"]))
        for t in tabs:
            t["label"] = names.get(t["label"]) or names.get(t["key"]) or t["label"] or "tablet"
        used = [t for t in tabs if t["scans"] > 0]
        configured = allocated.get(uid)
        n_alloc = int(configured) if isinstance(configured, (int, float)) and configured > 0 else len(u["known"])
        out[uid] = {
            "unit": uid, "title": unit_title(uid), "tablets": tabs, "used": used,
            "unused": [t for t in tabs if t["scans"] == 0 and t["key"] in u["known"]],
            "allocated": max(n_alloc, len(used)), "allocated_configured": configured is not None,
            "counted": sum(t["counted"] for t in tabs),
            "scans": sum(t["scans"] for t in tabs), "match": sum(t["match"] for t in tabs),
            "mismatch": sum(t["mismatch"] for t in tabs), "incomplete": sum(t["incomplete"] for t in tabs),
        }
    return out


# ---- the messages --------------------------------------------------------------------------------------------------
def hours_line(t: dict) -> str:
    hs = sorted(t["hours"])
    if not hs:
        return ""
    return " · ".join(f"{hour_range(h)}: {t['hours'].get(h, 0)}" for h in range(hs[0], hs[-1] + 1))


def date_text(day: str, till: str) -> str:
    d = datetime.date.fromisoformat(day)
    return f"{DAYS[d.weekday()]} {d.day} {MONTHS[d.month - 1]} {d.year} · till {till}"


def unit_text(u: dict, show_quality: bool = False, with_note: bool = True) -> str:
    lines = [f"*{u['title']}*", f"Tablets used: *{len(u['used'])} of {u['allocated']}*",
             f"Total scans today: *{u['counted']}*"]
    if show_quality and u["scans"]:
        lines.append(f"✔ Match {u['match']} · ✖ Mismatch {u['mismatch']} · ◌ Incomplete {u['incomplete']}")
    for i, t in enumerate(u["used"], 1):
        n = t["counted"]
        lines += ["", f"*{i}. {t['label']}* · {n} scan{'s' if n != 1 else ''}", hours_line(t)]
    if u["unused"]:
        lines += ["", f"Not used today ({len(u['unused'])}): " + ", ".join(t["label"] for t in u["unused"])]
    elif not u["used"]:
        lines += ["", "No tablet scanned today."]
    if with_note and not u["allocated_configured"]:
        lines += ["", "_Allocated = tablets that reported in the last 7 days._"]
    return "\n".join(lines)


def message_for(units: list[dict], day: str, till: str, show_quality: bool = False) -> str:
    head = f"*Label IQ · Daily report*\n{date_text(day, till)}"
    if len(units) == 1:
        return head + "\n\n" + unit_text(units[0], show_quality)
    used = sum(len(u["used"]) for u in units)
    alloc = sum(u["allocated"] for u in units)
    total = sum(u["counted"] for u in units)
    summary = f"All units: tablets used *{used} of {alloc}* · total scans *{total}*"
    body = ("\n\n— — —\n\n").join(unit_text(u, show_quality, with_note=(i == len(units) - 1))
                                 for i, u in enumerate(units))
    return f"{head}\n\n{summary}\n\n— — —\n\n{body}"


# ---- who gets what -------------------------------------------------------------------------------------------------
def load_settings(path: str) -> dict:
    if not path or not os.path.exists(path):
        return {"mode": "off", "demo_to": [], "allocated": {}, "people": []}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    mode = str(raw.get("mode", "off")).lower()
    if mode not in ("off", "demo", "live"):
        mode = "off"
    allocated = {str(k).lower(): v for k, v in (raw.get("allocated") or {}).items()}
    demo_to = [c for c in (chat_id(x) for x in raw.get("demo_to") or []) if c]
    people = []
    for p in raw.get("people") or []:
        to = chat_id(p.get("phone"))
        units = p.get("units")
        every = units == "all" or p.get("all") is True
        wanted = sorted({str(x).lower() for x in units}) if isinstance(units, list) else []
        if to and (every or wanted):
            people.append({"name": str(p.get("name", "")).strip(), "role": str(p.get("role", "")).strip(), "to": to,
                           "units": wanted, "all": every, "live": p.get("live", True) is not False})
    return {"mode": mode, "demo_to": demo_to, "allocated": allocated, "people": people,
            "names": {str(k): str(v) for k, v in (raw.get("names") or {}).items()}}


def units_for(person: dict, all_units: dict[str, dict]) -> list[dict]:
    ids = sorted(all_units, key=unit_sort) if person["all"] else [u for u in person["units"] if u in all_units]
    chosen = [all_units[i] for i in sorted(set(ids), key=unit_sort)]
    # A person assigned a unit that has no data at all still gets a message that says so.
    if not person["all"]:
        for uid in person["units"]:
            if uid not in all_units:
                chosen.append({"unit": uid, "title": unit_title(uid), "tablets": [], "used": [], "unused": [],
                               "allocated": 0, "allocated_configured": True, "scans": 0, "counted": 0, "match": 0,
                               "mismatch": 0, "incomplete": 0})
        chosen.sort(key=lambda u: unit_sort(u["unit"]))
    return chosen


# ---- WhatsApp ------------------------------------------------------------------------------------------------------
def send_text(base_url: str, api_key: str, session: str, to: str, text: str, tries: int = 3,
              pause: float = 2.0) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}/sessions/{session}/messages/send-text"
    body = json.dumps({"chatId": to, "text": text}).encode("utf-8")
    last = "not tried"
    for n in range(tries):
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"X-API-Key": api_key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                if 200 <= r.status < 300:
                    return True, f"accepted ({r.status})"
                last = f"refused ({r.status})"
        except urllib.error.HTTPError as e:
            last = f"refused ({e.code})"
            if e.code < 500:           # a refusal such as 401 will not get better by retrying
                return False, last
        except (urllib.error.URLError, OSError) as e:
            last = f"not reachable ({type(getattr(e, 'reason', e)).__name__})"
        if n + 1 < tries:
            time.sleep(pause)
    return False, last


# ---- data ----------------------------------------------------------------------------------------------------------
def fetch(up: Upstream, start: Optional[str] = None, end: Optional[str] = None) -> tuple[dict, list[dict]]:
    """The fleet and the scans from start to end (YYYY-MM-DD, whole days; default: the server's day)."""
    fleet = up.get_json(f"/v1/dashboard/fleet?limit={PAGE}")
    start = start or fleet["day"]
    end = end or start
    scans: list[dict] = []
    offset = 0
    while True:
        page = up.get_json(f"/v1/scans?from={start}&to={end}&limit={PAGE}&offset={offset}")
        scans += page.get("items", [])
        if not page.get("hasMore"):
            break
        offset += PAGE
        if offset > 50 * PAGE:       # safety stop
            raise UpstreamError("too many scans for one report")
    return fleet, scans


# ---- weekly summary ------------------------------------------------------------------------------------------------
def week_days(today: datetime.date) -> list[str]:
    """Monday of this week up to today, as YYYY-MM-DD."""
    monday = today - datetime.timedelta(days=today.weekday())
    return [(monday + datetime.timedelta(days=i)).isoformat() for i in range((today - monday).days + 1)]


def day_label(day: str) -> str:
    d = datetime.date.fromisoformat(day)
    return f"{DAYS[d.weekday()]} {d.day}"


def build_week(fleet: dict, scans: list[dict], days: list[str], exclude_prefixes: tuple[str, ...] = ("PC-",),
               names: Optional[dict] = None, count: str = "match") -> dict[str, dict]:
    """Per unit: scans per day, per tablet (total + per day), per hour over the week, tablets used and registered.
    Numbers are MATCH scans (count="match") or every scan event (count="all"). Pure function (tested)."""
    names = {str(k).strip(): str(v).strip() for k, v in (names or {}).items() if str(v).strip()}
    wanted = set(days)
    units: dict[str, dict] = {}

    def unit(uid: str) -> dict:
        return units.setdefault(uid, {"tablets": {}, "registered": set(), "days": collections.Counter(),
                                      "hours": collections.Counter(), "events": 0})

    def tablet(uid: str, key: str) -> dict:
        t = unit(uid)["tablets"].get(key)
        if t is None:
            t = {"key": key, "label": "", "label_ts": -1, "events": 0, "days": collections.Counter()}
            unit(uid)["tablets"][key] = t
        return t

    for it in fleet.get("items", []):
        uid = str(it.get("unitId") or "").lower()
        if not uid or not keep(it.get("variant"), it.get("deviceLabel"), exclude_prefixes):
            continue
        key = it.get("tabletKey") or tablet_key(it)
        t = tablet(uid, key)
        ls = int(it.get("lastSeen") or 0)
        if ls > t["label_ts"] and it.get("deviceLabel"):
            t["label"], t["label_ts"] = str(it["deviceLabel"]), ls
        unit(uid)["registered"].add(key)

    for r in scans:
        uid = str(r.get("unitId") or "").lower()
        dev = r.get("device") or {}
        ts = r.get("tsDevice")
        if not uid or not isinstance(ts, (int, float)) or not keep(r.get("variant"), dev.get("label"), exclude_prefixes):
            continue
        when = datetime.datetime.fromtimestamp(ts / 1000, IST)
        day = when.date().isoformat()
        if day not in wanted:
            continue
        t = tablet(uid, tablet_key(dev))
        if not t["label"] and dev.get("label"):
            t["label"] = str(dev["label"])
        t["events"] += 1
        unit(uid)["events"] += 1
        if count == "all" or str((r.get("scan") or {}).get("result") or "").upper() == "MATCH":
            t["days"][day] += 1
            unit(uid)["days"][day] += 1
            unit(uid)["hours"][when.hour] += 1

    out: dict[str, dict] = {}
    for uid, u in units.items():
        for t in u["tablets"].values():
            t["total"] = sum(t["days"].values())
        tabs = sorted(u["tablets"].values(), key=lambda t: (-t["total"], t["label"] or t["key"]))
        for t in tabs:
            t["label"] = names.get(t["label"]) or names.get(t["key"]) or t["label"] or "tablet"
        used = [t for t in tabs if t["events"] > 0]
        out[uid] = {"unit": uid, "title": unit_title(uid), "days_list": days, "tablets": used,
                    "used": len(used), "registered": max(len(u["registered"]), len(used)),
                    "total": sum(u["days"].values()), "days": u["days"], "hours": u["hours"]}
    return out


def week_title(days: list[str]) -> str:
    a, b = datetime.date.fromisoformat(days[0]), datetime.date.fromisoformat(days[-1])
    if a == b:
        return f"{DAYS[a.weekday()]} {a.day} {MONTHS[a.month - 1]} {a.year}"
    first = f"{DAYS[a.weekday()]} {a.day}" + (f" {MONTHS[a.month - 1]}" if a.month != b.month else "")
    return f"{first} – {DAYS[b.weekday()]} {b.day} {MONTHS[b.month - 1]} {b.year}"


def week_text(u: dict, till: str) -> str:
    days = u["days_list"]
    lines = ["*Label IQ · Weekly summary*", f"{week_title(days)} · till {till}", "", f"*{u['title']}*",
             f"Total scans this week: *{u['total']}*",
             f"Tablets used: *{u['used']}* ({u['registered']} registered for this unit)", "",
             "*By day*", " · ".join(f"{day_label(d)}: {u['days'].get(d, 0)}" for d in days)]
    for i, t in enumerate(u["tablets"], 1):
        active = sum(1 for d in days if t["days"].get(d, 0) > 0)
        lines += ["", f"*{i}. {t['label']}* · {t['total']} scan{'s' if t['total'] != 1 else ''}"
                      f" · active {active} of {len(days)} days",
                  " · ".join(f"{day_label(d)}: {t['days'].get(d, 0)}" for d in days)]
    hs = sorted(u["hours"])
    if hs:
        lines += ["", "*By hour (all days together)*",
                  " · ".join(f"{hour_range(h)}: {u['hours'].get(h, 0)}" for h in range(hs[0], hs[-1] + 1))]
    elif not u["tablets"]:
        lines += ["", "No tablet scanned this week."]
    return "\n".join(lines)


def run_week(cfg: Config, settings: dict, wa_url: str, wa_key: str, wa_session: str = "default",
             print_only: bool = False, now: Optional[datetime.datetime] = None,
             exclude_prefixes: tuple[str, ...] = ("PC-",), count: str = "match", out=sys.stdout) -> int:
    """Weekly summary, one message per unit. In demo mode it goes only to the demo numbers; live mode sends each
    person the units they have (one message per unit). Never sent unless the mode says so."""
    now = now or datetime.datetime.now(IST)
    days = week_days(now.date())
    fleet, scans = fetch(Upstream(cfg), days[0], days[-1])
    units = build_week(fleet, scans, days, exclude_prefixes, settings.get("names"), count)
    till = now.strftime("%H:%M")
    log.info("weekly summary %s .. %s: %d units, %d scans fetched", days[0], days[-1], len(units), len(scans))
    order = sorted(units, key=unit_sort)
    if print_only:
        for uid in order:
            print(week_text(units[uid], till), file=out)
            print("\n" + "=" * 40 + "\n", file=out)
        return 0
    mode = settings["mode"]
    if mode == "off":
        log.info("mode is off: nothing sent")
        return 0
    failures = 0
    if mode == "demo":
        if not settings["demo_to"]:
            log.error("demo mode but no demo number in report.json")
            return 1
        for uid in order:
            for to in settings["demo_to"]:
                ok, detail = send_text(wa_url, wa_key, wa_session, to, week_text(units[uid], till))
                log.info("weekly %s -> %s: %s", units[uid]["title"], masked(to), detail)
                failures += 0 if ok else 1
        return 1 if failures else 0
    for p in settings["people"]:
        if not p["live"]:
            continue
        for uid in order:
            if p["all"] or uid in p["units"]:
                ok, detail = send_text(wa_url, wa_key, wa_session, p["to"], week_text(units[uid], till))
                log.info("weekly %s -> %s (%s): %s", units[uid]["title"], p["name"] or "?", masked(p["to"]), detail)
                failures += 0 if ok else 1
    return 1 if failures else 0


# ---- run -----------------------------------------------------------------------------------------------------------
def run(cfg: Config, settings: dict, wa_url: str, wa_key: str, wa_session: str = "default", print_only: bool = False,
        now: Optional[datetime.datetime] = None, show_quality: bool = False, active_days: int = 7,
        exclude_prefixes: tuple[str, ...] = ("PC-",), count: str = "match", out=sys.stdout) -> int:
    now = now or datetime.datetime.now(IST)
    up = Upstream(cfg)
    fleet, scans = fetch(up)
    units = build_units(fleet, scans, int(now.timestamp() * 1000), active_days, exclude_prefixes,
                        settings.get("allocated"), settings.get("names"), count)
    day, till = fleet["day"], now.strftime("%H:%M")
    log.info("report for %s: %d units, %d scans", day, len(units), len(scans))

    if print_only:
        for uid in sorted(units, key=unit_sort):
            print(message_for([units[uid]], day, till, show_quality), file=out)
            print("\n" + "=" * 40 + "\n", file=out)
        if len(units) > 1:
            print("[a person who gets all units receives:]\n", file=out)
            print(message_for([units[u] for u in sorted(units, key=unit_sort)], day, till, show_quality), file=out)
        for p in settings["people"]:
            print(f"\n[{p['name'] or 'person'} ({p['role']}) -> units {'all' if p['all'] else p['units']},"
                  f" live={p['live']}]", file=out)
        return 0

    mode = settings["mode"]
    if mode == "off":
        log.info("mode is off: nothing sent")
        return 0
    failures = 0
    if mode == "demo":
        if not settings["demo_to"]:
            log.error("demo mode but no demo number in report.json")
            return 1
        for p in settings["people"]:
            text = (f"[DEMO] This is what *{p['name'] or 'this person'}* ({p['role'] or 'recipient'}) "
                    f"would receive:\n\n" + message_for(units_for(p, units), day, till, show_quality))
            for to in settings["demo_to"]:
                ok, detail = send_text(wa_url, wa_key, wa_session, to, text)
                log.info("demo for %s -> %s: %s", p["name"] or "?", masked(to), detail)
                failures += 0 if ok else 1
        return 1 if failures else 0
    for p in settings["people"]:        # live
        if not p["live"]:
            log.info("skipped %s: not live yet", p["name"] or "?")
            continue
        ok, detail = send_text(wa_url, wa_key, wa_session, p["to"],
                               message_for(units_for(p, units), day, till, show_quality))
        log.info("sent to %s (%s): %s", p["name"] or "?", masked(p["to"]), detail)
        failures += 0 if ok else 1
    return 1 if failures else 0


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(message)s")
    args = argv if argv is not None else sys.argv[1:]
    env = os.environ
    try:
        cfg = Config.from_env()
        settings = load_settings(env.get("LABELIQ_REPORT_FILE", "/etc/labeliq-report/report.json"))
        if "--week" in args:
            return run_week(cfg, settings, env.get("WHATSAPP_URL", ""), env.get("WHATSAPP_API_KEY", ""),
                            env.get("WHATSAPP_SESSION", "default"), print_only="--print" in args,
                            count=("all" if env.get("LABELIQ_REPORT_COUNT", "match") == "all" else "match"),
                            exclude_prefixes=tuple(x for x in env.get("LABELIQ_EXCLUDE_LABELS", "PC-").split(",") if x))
        return run(cfg, settings, env.get("WHATSAPP_URL", ""), env.get("WHATSAPP_API_KEY", ""),
                   env.get("WHATSAPP_SESSION", "default"), print_only="--print" in args,
                   show_quality=env.get("LABELIQ_REPORT_QUALITY", "off") == "on",
                   count=("all" if env.get("LABELIQ_REPORT_COUNT", "match") == "all" else "match"),
                   active_days=int(env.get("LABELIQ_ACTIVE_DAYS", "7")),
                   exclude_prefixes=tuple(x for x in env.get("LABELIQ_EXCLUDE_LABELS", "PC-").split(",") if x))
    except UpstreamError as e:
        log.error("report not sent: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
