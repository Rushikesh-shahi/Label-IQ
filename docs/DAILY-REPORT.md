# Daily WhatsApp report (`report.py`)

A scheduled job (Kubernetes CronJob `labeliq-report`, **suspended until activated**) that sends, per unit:

- tablets used **out of** tablets allocated,
- the scans of **each tablet**,
- **total scans** today (all tablets of the unit together),
- **which hours each tablet scanned** (scans per hour; an idle hour between the first and last scan shows as 0).

It reads the official server read-only (same master token, same certificate rules as the proxy) and sends through the
**same WhatsApp gateway and number** as the Garment Tracker alerts (`wa-gateway.order-desk`, send-text call).

Sample (Unit 21, real data of 13 Nov 2026 up to 16:10; the tablet name and "of 1" come from the system, a friendly name
and the allocated number can be set in the settings):

```
*Label IQ · Daily report*
Fri 13 Nov 2026 · till 16:10

*Unit 21*
Tablets used: *1 of 1*
Total scans today: *551*

*1. U21-b91f55e9* · 551 scans
10–11: 52 · 11–12: 118 · 12–13: 147 · 13–14: 63 · 14–15: 65 · 15–16: 106
```

A person with several units gets **one** message with an "All units" summary line and every unit below it. The match /
mismatch / incomplete line is **off** by default (`LABELIQ_REPORT_QUALITY=on` adds it).

## How the numbers are counted

- "Today" is the official server's own day (the same as its dashboard); hours are Indian time (IST) from the tablet's scan time.
- A **tablet** is a physical tablet (its hardware id), not an app install: a reinstall or a second app on the same tablet is one
  tablet. Its name is the label of its newest install (e.g. `U44-603ec46d`) unless a friendly name is set (`names`).
- **Used** = at least one scan today. **Allocated** = the number set for the unit in `allocated`; if none is set, the
  tablets of that unit that reported in the last 7 days (the message then says so). "Used" is never shown above "allocated".
- **Scans = MATCH scans only** (the valid ones, as the tablets count POs): per tablet, per hour and in the total, so the tablets add up to the total. `LABELIQ_REPORT_COUNT=all` counts every scan event instead. A tablet that scanned only mismatches still counts as used.
- Left out: demo builds (variant contains "Demo") and installs whose label starts with `PC-` (test PCs).

## Settings: Secret `labeliq-report` (never in git)

Keys: `report.json` and `WHATSAPP_API_KEY` (a copy of the gateway key, as the tracker holds one). `report.json`:

```json
{"mode": "off",
 "demo_to": ["91XXXXXXXXXX"],
 "allocated": {"u10": 4, "u21": 6, "u35": 8, "u44": 5},
 "names": {"U44-603ec46d": "Tab 1"},
 "people": [{"name": "A", "role": "PM", "phone": "91XXXXXXXXXX", "units": ["u10", "u21"], "live": true},
            {"name": "B", "role": "GM", "phone": "91XXXXXXXXXX", "units": "all", "live": true}]}
```

`mode`: `off` does nothing (the default, also when the Secret is missing); `demo` sends every person's message **only to the
`demo_to` numbers**, prefixed with who it is for; `live` sends to the people with `"live": true`.

## Switching it on (each step is a deliberate act)

1. Create the Secret (people, numbers, `allocated`, `names`, mode `demo`; gateway key copied from the Order Desk secret).
   Staff numbers never go into git.
2. Order Desk repo: add this pod to the gateway's `wa-gateway-in` NetworkPolicy
   (namespace `labeliq`, pod label `app.kubernetes.io/name: labeliq-report`, port 2785); PR and merge there.
3. `kubectl -n labeliq create job report-test --from=cronjob/labeliq-report`, then `kubectl -n labeliq logs job/report-test`.
   In `demo` mode the owner receives everything; check the wording and the numbers.
4. Set `"mode": "live"` in the Secret and the real time in the CronJob (`schedule`, IST), then `suspend: false` (PR + sync).
5. Look at the first live run's log; failed recipients are listed (numbers are masked in logs).

`python report.py --print` prints every unit's text and sends nothing (it needs the same environment as the job).
