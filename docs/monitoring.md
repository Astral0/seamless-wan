# Monitoring & Auto-recovery

OpenMPTCProuter's built-in `omr-tracker` only checks reachability to the VPS, so a WAN that has lost actual internet (captive portal expired, DHCP lease lost, phone tether glitch) silently drops out and nothing brings it back. seamless-wan adds two daemons and an aggregator to detect, alert, and self-heal.

## Architecture

```
┌──────────────────┐  /tmp/wan-monitor.json
│  wan-monitor.sh  │ ───────────────────────────┐
│  (every 30s)     │                            │
└──────────────────┘                            ▼
                                       ┌─────────────────┐
┌──────────────────┐  /tmp/service-    │ Dashboard       │  Banner alerts
│ service-monitor  │   monitor.json    │   /api/alerts   │  + action buttons
│  (every 30s)     │ ─────────────────▶│   /api/events   │
└──────────────────┘                   │   /api/wan/probes│
                                       └─────────────────┘
                          vcgencmd ─────────▲
                          power flags
```

## wan-monitor.sh

Probes each WAN interface every 30s by issuing an HTTP request bound to the WAN's source interface:

```sh
curl --interface usb0 http://connectivitycheck.gstatic.com/generate_204
```

Results are classified:

| Status | HTTP code | Meaning |
|--------|-----------|---------|
| `internet` | 204 | Working — Google's standard "no captive portal" response |
| `captive` | 200 / 3xx | Captive portal serving login page or redirecting |
| `timeout` | 000 | No response within 5s |
| `no_ip` | n/a | Interface up but DHCP not yet acquired |
| `no_device` | n/a | Configured WAN with no network device |
| `error_<code>` | other | Unexpected HTTP code |

It also probes the tunnel (3-ping burst over 3s, accepts if ≥1 returns) and DNS (`nslookup ... 127.0.0.1`). Both apply two-cycle hysteresis to avoid spurious alerts on transient failures.

### State transitions

For each WAN, it tracks `since` (last status change), `last_internet` (timestamp of last `internet` probe), and emits a syslog event on every transition. The `internet → captive` transition is special: if `AUTO_CAPTIVE=1` (default) the daemon launches `captive-firefox` in the noVNC chroot once, with a 5-minute cooldown to prevent loops if the portal flaps.

### Auto-recovery

After 3 consecutive `timeout` or `error_*` results on an interface that still has a device, the daemon runs `ifup wanX` to renew the DHCP lease.

### Output

`/tmp/wan-monitor.json` (rewritten atomically every cycle):

```json
{
  "timestamp": 1777138089,
  "tunnel": "up",
  "dns": "up",
  "wans": [
    {"name":"wan1","device":"usb0","ip":"10.103.242.146","link":"yes",
     "status":"internet","failures":0,"since":0,"last_internet":1777138089,"last_recover":0}
  ]
}
```

### Tunable env vars

| Variable | Default | Meaning |
|----------|---------|---------|
| `PROBE_URL` | `http://connectivitycheck.gstatic.com/generate_204` | HTTP endpoint to test |
| `INTERVAL` | `30` | Seconds between probe cycles |
| `RECOVER_AFTER` | `3` | Consecutive failures before `ifup` |
| `AUTO_CAPTIVE` | `1` | Set to `0` to disable auto-launch of captive Firefox |
| `CAPTIVE_COOLDOWN` | `300` | Seconds between auto-launches |

## service-monitor.sh

Probes critical services every 30s:

| Service | Probe |
|---------|-------|
| dnsmasq | `pidof dnsmasq` |
| glorytun | `pidof glorytun` |
| omr-tracker | `pidof omr-tracker` |
| hostapd | `pidof hostapd` AND any `phyN-ap0` interface is `UP` |

After 2 consecutive failures, runs `/etc/init.d/<service> restart`. To prevent restart loops, the daemon caps restarts at **4 per service per hour**. Beyond that, the service is left in a "capped" state and the dashboard shows a critical alert asking for manual intervention.

### Output

`/tmp/service-monitor.json`:

```json
{
  "timestamp": 1777135134,
  "services": [
    {"name":"dnsmasq","status":"running","failures":0,"since":1777134961,
     "last_restart":0,"recent_restarts":0,"capped":false}
  ]
}
```

> **Note**: BusyBox's `pgrep -x` does not match the same way GNU `pgrep -x` does, so the probes use `pidof <name>` which reliably matches the binary basename.

### Tunable env vars

| Variable | Default | Meaning |
|----------|---------|---------|
| `INTERVAL` | `30` | Seconds between probe cycles |
| `RESTART_AFTER` | `2` | Consecutive failures before restart |
| `MAX_RESTARTS` | `4` | Max restarts within `COOLDOWN` window |
| `COOLDOWN` | `3600` | Restart-counter window in seconds |

## Alert aggregator (in dashboard)

The dashboard's `/api/alerts` endpoint combines wan-monitor + service-monitor + `vcgencmd get_throttled` flags into a flat list:

```json
{"alerts":[
  {"id":"wan-wan2-captive","severity":"warning",
   "message":"wan2 captive portal (lost internet 8 min ago)",
   "action":"captive_portal","since":1777138024}
]}
```

`severity` is `critical`, `warning`, or `info`. The dashboard renders a colored banner at the top of the page when any alert is present, with a one-click action button:

- `captive_portal` → re-launches captive Firefox in noVNC
- `restart_wan` → calls `ifup wan*`
- `restart_service` → calls `/etc/init.d/* restart`

## Event timeline

`/api/events` parses `logread` filtered to seamless-wan tags (`wan-monitor`, `service-monitor`, `captive-firefox`, `captive-routing`, `fix-phy`) and returns the most recent transitions, restarts, and auto-actions. The dashboard exposes them in a collapsible "Recent Events" panel — useful to understand why a recovery happened or what flapped.

The event log is **not persisted across reboots** — it lives in OpenWrt's syslog ring buffer (~16 KB).

## Throughput

`/api/throughput` returns a `/proc/net/dev` snapshot. The dashboard polls every 2s and computes per-interface bps deltas client-side, then renders a single mirror chart:

- RX above the X axis (download direction from device perspective)
- TX below the X axis
- One color per series, with toggleable pills (Tunnel + WAN total visible by default)
- 60 samples × 2s = 2-minute window

Why the numbers don't add up exactly:

- **WAN total > Tunnel** — Glorytun adds ~30-50% overhead for encryption (ChaCha20), TCP/IP framing, and MPTCP signaling.
- **AP TX > Tunnel RX** — the AP has constant beacon and management frames (~5-10 Kb/s) independent of clients.
- **eth0 TX ≠ Tunnel RX** — local LAN traffic (dashboard polls, noVNC websocket, mDNS) never reaches the WAN.

## Installation

### Deploy the daemons

```sh
# From the seamless-wan repo (adjust REPO_DIR to your clone path)
REPO_DIR=/root/seamless-wan

mount -o remount,rw /
cp $REPO_DIR/scripts/host/wan-monitor.sh     /opt/wan-monitor.sh
cp $REPO_DIR/scripts/host/service-monitor.sh /opt/service-monitor.sh
chmod +x /opt/wan-monitor.sh /opt/service-monitor.sh

cp $REPO_DIR/config/init.d/wan-monitor     /etc/init.d/wan-monitor
cp $REPO_DIR/config/init.d/service-monitor /etc/init.d/service-monitor
chmod +x /etc/init.d/wan-monitor /etc/init.d/service-monitor

/etc/init.d/wan-monitor enable && /etc/init.d/wan-monitor start
/etc/init.d/service-monitor enable && /etc/init.d/service-monitor start
```

### Verify

```sh
# Wait ~30s after start, then:
cat /tmp/wan-monitor.json     # should have "internet" or "captive" per WAN
cat /tmp/service-monitor.json # should have "running" for all 4 services
logread | grep -E 'wan-monitor|service-monitor' | tail -10
```

### Disable auto-actions

If you prefer manual control, override the procd start command via env vars or edit the init.d files:

```sh
# Disable auto-captive-firefox launch
echo 'export AUTO_CAPTIVE=0' >> /etc/profile.d/wan-monitor.sh

# Or just disable the daemon
/etc/init.d/wan-monitor disable
```
