# Web Dashboard

Lightweight web UI for monitoring and managing the seamless-wan router.

## Features

- **System status**: uptime, public IP, CPU temperature, power/throttling
- **WAN interfaces**: status of all 4 WANs (USB tethering + WiFi), restart
- **Glorytun tunnel**: connection status, local/remote IPs
- **WiFi roaming**: scan networks, connect/disconnect, manage known networks (CRUD)
- **Services**: status and restart for novnc, wifi-roaming, power-monitor
- **Quick links**: noVNC remote desktop, OMR LuCI admin

Auto dark/light theme, mobile-first responsive design, 5-second auto-refresh.

## Architecture

```
dashboard/
  server.py          — HTTP server (stdlib http.server, port 8080)
  auth.py            — HTTP Basic Auth + session cookies
  host_commands.py   — SSH wrapper to execute commands on OMR host
  models.py          — Dataclasses for API responses
  static/
    index.html       — Single-page dashboard
    style.css        — Dark/light theme with CSS custom properties
    dashboard.js     — Vanilla JS client (fetch API, polling)
```

The dashboard runs **inside the Alpine chroot** and communicates with the
OpenMPTCProuter host via SSH (`ssh root@127.0.0.1`).

## Installation

### 1. Copy files into the chroot

```sh
# From the host (OMR)
CHROOT=/mnt/sda3

cp -r dashboard/* $CHROOT/opt/dashboard/
cp scripts/chroot/start-dashboard.sh $CHROOT/opt/start-dashboard.sh
chmod +x $CHROOT/opt/start-dashboard.sh
```

### 2. Install the procd service

```sh
cp config/init.d/dashboard /etc/init.d/dashboard
chmod +x /etc/init.d/dashboard
service dashboard enable
service dashboard start
```

### 3. Set credentials (optional)

Default credentials are `admin` / `seamless`. Override with environment variables:

```sh
# In /opt/start-dashboard.sh or the init script:
export DASHBOARD_USER="myuser"
export DASHBOARD_PASS="mypassword"
```

### 4. Firewall

Allow port 8080 on the LAN zone if needed:

```sh
uci add firewall rule
uci set firewall.@rule[-1].name='Allow-Dashboard'
uci set firewall.@rule[-1].src='lan'
uci set firewall.@rule[-1].dest_port='8080'
uci set firewall.@rule[-1].proto='tcp'
uci set firewall.@rule[-1].target='ACCEPT'
uci commit firewall
fw4 reload
```

## Usage

Open `http://<router-ip>:8080` in a browser. Log in with your credentials.

### API

All endpoints are under `/api/` and require authentication (session cookie or Basic Auth).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Authenticate (no auth required) |
| GET | `/api/status` | Full system status (system + WANs + tunnel) |
| GET | `/api/wan` | WAN interfaces status |
| POST | `/api/wan/{name}/restart` | Restart a WAN interface |
| GET | `/api/tunnel` | Glorytun tunnel status |
| GET | `/api/roaming/status` | WiFi roaming connection status |
| POST | `/api/roaming/scan` | Scan for WiFi networks |
| POST | `/api/roaming/connect` | Connect to a known network |
| POST | `/api/roaming/disconnect` | Disconnect from WiFi |
| GET | `/api/roaming/networks` | List known networks |
| POST | `/api/roaming/networks` | Add a known network |
| PUT | `/api/roaming/networks/{ssid}` | Update a known network |
| DELETE | `/api/roaming/networks/{ssid}` | Delete a known network |
| GET | `/api/services` | Service statuses |
| POST | `/api/services/{name}/restart` | Restart a service |
