# Label IQ Master Dashboard on shahi-server

The Label IQ dashboard (Shahi IT's "Master Dashboard" for the factory scanner tablets) shown at
**https://labeliq.shahi-ai.in** behind Shahi SSO. The real data stays on the official Label IQ server
(`labeliq.shahi.co.in`, reachable only from the Centaurus network). This project only shows it.

```
 staff browser
   |  https, Cloudflare tunnel, Shahi SSO check (Traefik)
   v
 this proxy  (namespace labeliq, pod labeliq-dashboard)
   |  serves the dashboard pages; forwards the dashboard's read-only API calls
   |  https to 172.20.50.61 (labeliq.shahi.co.in), master token added HERE
   |  over the server's Centaurus Wi-Fi dongle
   v
 official Label IQ server  (Shahi IT)  ->  its database (telemetry.db)
```

## What is in this repo

| Path | What |
|---|---|
| `proxy.py` | The proxy (Python standard library only). Rules are listed at the top of the file. |
| `static/` | The dashboard from Shahi IT: `app.js`, `app.css`, `shahi_logo.png` are **unchanged**; `index.html` has one extra line; `sso-login.js` is ours (signs the page in through Shahi SSO, hides the sign-out button). |
| `certs/geotrust-tls-rsa-ca-g1.pem` | Public intermediate certificate (see "Certificate"). Not a secret. |
| `tests/test_proxy.py` | 38 tests. |
| `deploy/labeliq-dashboard.yaml` | Namespace, Deployment, Service, NetworkPolicy. |
| `Dockerfile` | `python:3.11-slim`, user 10001. |

## What the proxy allows (and nothing else)

- **GET only.** POST/PUT/DELETE answer 405 and never leave the pod. The tablets' write endpoint
  (`POST /v1/events/batch`) is therefore unreachable from here; the master token cannot write anyway.
- Only the paths the dashboard uses: `/v1/devices`, `/v1/builds`, `/v1/scans`, `/v1/sessions`,
  `/v1/dashboard/overview|units|pos|fleet|activity`, plus the official `/v1/health`. Everything else is 404.
- A request without the `X-Shahi-Email` header is refused (401). Shahi SSO sets that header in Traefik and a
  visitor cannot forge it, so the master token is never used for someone who did not pass the SSO check.
- The caller's own `Authorization` header is ignored. The token comes only from the Secret.
- The token is never logged and never sent to the browser. If the official server refuses it, the browser
  gets 502 "did not accept shahi-server's master token", not 401 (a 401 would sign the page out).
- Answers are cached 5 seconds and at most 4 calls run at once, so many open dashboards (each refreshes every
  10 seconds) do not load the official server.
- The access log has the user's email, path, status and time; **not** query values (PO numbers, device ids)
  and never the token.

## Network (how the server reaches the official server)

`labeliq.shahi.co.in` is an **internal name**: only the office DNS (`172.20.150.9`, `10.10.19.5`) knows it
(answer `172.20.50.61`, checked 13 Nov 2026). shahi-server's main network is the `Board-Room` Wi-Fi; the
Centaurus network is joined by the USB dongle `wlx5091e381459d` (NetworkManager profile `centaurus-dongle`,
gateway `172.20.18.6`), which carries only a few host routes. Therefore:

1. The node needs a route `172.20.50.61/32 via 172.20.18.6 dev wlx5091e381459d`, stored in the NetworkManager
   profile so it survives reboots (same way as the two existing CRM routes):
   `nmcli connection modify centaurus-dongle +ipv4.routes "172.20.50.61/32 172.20.18.6"` then
   `nmcli device reapply wlx5091e381459d`. Check: `ip route get 172.20.50.61`.
2. The pod does not use DNS: `hostAliases` in the Deployment maps the name to the address.
3. The NetworkPolicy lets the pod call only `172.20.50.61:443`.

If IT changes the address: update the three places (route, hostAliases, NetworkPolicy). Quick test from the
server: `curl -s --interface wlx5091e381459d --resolve labeliq.shahi.co.in:443:172.20.50.61 https://labeliq.shahi.co.in/v1/health`
(works after the route exists; add `-k` only to see the body when the certificate check complains).

## Certificate

The official server sends only its own certificate (`*.shahi.co.in`, DigiCert/GeoTrust, valid to 7 Dec 2026)
and **not** the intermediate "GeoTrust TLS RSA CA G1" that browsers fetch by themselves. Python does not, so
the intermediate is bundled in `certs/` (downloaded from the address inside the certificate,
`http://cacerts.geotrust.com/GeoTrustTLSRSACAG1.crt`; valid to 2 Nov 2027; sha256
`C0:6E:30:7F:7C:FC:1D:32:FA:72:A4:C0:33:C8:7B:90:01:9A:F2:16:F0:77:5D:64:97:8A:2E:CA:6C:8A:23:0E`).
Certificate checking is **never turned off** (the master token travels on this connection).

When the certificate is renewed (before 7 Dec 2026): if the dashboard shows "certificate could not be
verified", IT used a different intermediate; ask IT for the chain (or read the issuer with
`openssl s_client -connect 172.20.50.61:443 -servername labeliq.shahi.co.in`) and replace the file in `certs/`.
Better still: ask IT to make the server send the full chain; then nothing needs bundling.

## Secret (never in git)

Kubernetes Secret `labeliq` in namespace `labeliq`, key `LABELIQ_MASTER_TOKEN` = one of the `masterTokens` of the
official server (`tokens.json`, kept by IT). Created by hand on the server. To change it, update the Secret and
`kubectl -n labeliq rollout restart deploy/labeliq-dashboard`. A master token can read every unit and cannot
write. If IT rotates the token the dashboard shows the 502 message above until the Secret is updated.

## Deploy (by hand, owner's order: branch, tests, PR, merge, deploy)

```bash
# tests (standard library only)
podman run --rm -v "$PWD":/w:ro -w /w docker.io/library/python:3.11-slim python -m unittest discover -s tests -v
# image on the server, imported into K3s
podman build -t localhost/labeliq-dashboard:latest .
podman save localhost/labeliq-dashboard:latest | sudo k3s ctr images import -
# one time: the Secret (value from the owner's env file; never printed or pasted into chat)
# apply the manifest, then publish the site (infra repo, platform/publish/shahi-publish.py labeliq ...)
sudo kubectl apply -f deploy/labeliq-dashboard.yaml
sudo kubectl -n labeliq rollout restart deploy/labeliq-dashboard   # after a new image
```

## Updating the dashboard when Shahi IT ships a new version

Replace `static/app.js`, `static/app.css`, `static/shahi_logo.png` and `static/index.html` with the new
files, then re-add the one line `<script src="sso-login.js" defer></script>` before the `app.js` script tag in
`index.html`. If the new `app.js` calls an API path that is not in `API_PATHS` in `proxy.py`, add it there (read-only
GET paths only) and add it to the test. Run the tests (one test checks that `app.js` is served byte for byte).

Files received on 13 Nov 2026 (`LabelIQ_Server_IT_Deployment.zip`, `telemetry_server/dashboard_static/`), first
8 bytes of sha256 as recorded then: `app.css f71018b0`, `app.js dfe3618b`, `index.html 90eeca93`, `shahi_logo.png 0bd4f6cc`.

## Troubleshooting

| Dashboard shows | Meaning | Check |
|---|---|---|
| "Server unreachable" / 502 "cannot be reached" | the pod cannot reach 172.20.50.61:443 | route (`ip route get 172.20.50.61`), the Centaurus dongle (`nmcli dev`), NetworkPolicy, official server up |
| 502 "certificate could not be verified" | certificate chain changed | section Certificate |
| 502 "did not accept shahi-server's master token" | token rotated or revoked | section Secret |
| Page reloads to the Shahi sign-in | SSO session ended | sign in again |
| 503 "busy" | many calls at once | wait; raise `LABELIQ_MAX_PARALLEL` only with IT's OK |

## Daily WhatsApp report

Per unit: tablets used out of allocated, scans per tablet, total scans, scans per hour per tablet, sent through the same
WhatsApp gateway as the tracker alerts. Suspended until the recipients are known. Full description, settings and the
switch-on steps: [docs/DAILY-REPORT.md](docs/DAILY-REPORT.md).
