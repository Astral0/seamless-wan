# Web Dashboard

Lightweight web UI for monitoring and managing the seamless-wan router.

## Features

- **System status**: uptime, public IP, CPU temperature, power/throttling
- **WAN interfaces**: status of all 4 WANs (USB tethering + WiFi), restart
- **Glorytun tunnel**: connection status, local/remote IPs
- **WiFi roaming**: scan networks, connect/disconnect, manage known networks (CRUD), connect to unknown networks from scan results (auto-add + rollback on failure), auto/manual connect flag per network
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

## Deployment

### Quick deploy (from the seamless-wan repo on the RPi)

```sh
# Variables
CHROOT=/mnt/data
REPO_DIR=/root/seamless-wan   # adjust to where the repo is cloned

# Ensure the chroot filesystem is writable
mount -o remount,rw /
mount -o remount,rw $CHROOT 2>/dev/null

# 1. Create dashboard directory in chroot and copy files
mkdir -p $CHROOT/opt/dashboard/static
cp $REPO_DIR/dashboard/server.py $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/auth.py $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/host_commands.py $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/models.py $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/static/* $CHROOT/opt/dashboard/static/

# 2. Install the chroot launcher
cp $REPO_DIR/scripts/chroot/start-dashboard.sh $CHROOT/opt/start-dashboard.sh
chmod +x $CHROOT/opt/start-dashboard.sh

# 3. Install the procd service on the host
cp $REPO_DIR/config/init.d/dashboard /etc/init.d/dashboard
chmod +x /etc/init.d/dashboard
service dashboard enable
service dashboard start
```

### Manual install (step by step)

#### 1. Copy files into the chroot

```sh
# From the host (OMR)
CHROOT=/mnt/data

mkdir -p $CHROOT/opt/dashboard/static
cp -r dashboard/*.py $CHROOT/opt/dashboard/
cp -r dashboard/static/* $CHROOT/opt/dashboard/static/
cp scripts/chroot/start-dashboard.sh $CHROOT/opt/start-dashboard.sh
chmod +x $CHROOT/opt/start-dashboard.sh
```

#### 2. Install the procd service

```sh
cp config/init.d/dashboard /etc/init.d/dashboard
chmod +x /etc/init.d/dashboard
service dashboard enable
service dashboard start
```

#### 3. Set credentials (optional)

Default credentials are `admin` / `seamless`. Override with environment variables
in `/mnt/sda3/opt/start-dashboard.sh`:

```sh
#!/bin/sh
export DASHBOARD_USER="myuser"
export DASHBOARD_PASS="mypassword"
cd /opt/dashboard || exit 1
exec python3 server.py
```

#### 4. Firewall (if needed)

Allow port 8080 on the LAN zone:

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

### Update (after git pull)

```sh
CHROOT=/mnt/data
REPO_DIR=/root/seamless-wan

mount -o remount,rw /
cp $REPO_DIR/dashboard/*.py $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/static/* $CHROOT/opt/dashboard/static/
service dashboard restart
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
| POST | `/api/roaming/connect-and-add` | Connect to unknown network (add to config, rollback on failure) |
| POST | `/api/roaming/disconnect` | Disconnect from WiFi |
| GET | `/api/roaming/networks` | List known networks (includes `autoconnect` flag) |
| POST | `/api/roaming/networks` | Add a known network (`autoconnect` param, default true) |
| PUT | `/api/roaming/networks/{ssid}` | Update a known network (`autoconnect` param) |
| DELETE | `/api/roaming/networks/{ssid}` | Delete a known network |
| GET | `/api/services` | Service statuses |
| POST | `/api/services/{name}/restart` | Restart a service |
