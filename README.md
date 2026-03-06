# seamless-wan

A mobile multi-WAN toolkit for [OpenMPTCProuter](https://www.openmptcprouter.com/) — WiFi roaming, captive portal handling, power monitoring, and a web dashboard for Raspberry Pi.

## Overview

**seamless-wan** is an overlay toolkit for OpenMPTCProuter that turns a Raspberry Pi into a robust mobile router with always-on connectivity. Designed for use on trains, in hotels, or anywhere with unreliable networks.

## Features

- **Multi-WAN aggregation** — Combine USB tethering (phones), WiFi client, and USB WiFi dongles via MPTCP
- **WiFi roaming** — Scan and manually connect to known networks on a secondary WiFi adapter
- **Captive portal support** — UID-based policy routing with a dedicated browser (via noVNC) that bypasses the VPN tunnel
- **Power & USB monitoring** — Real-time undervoltage, temperature, and USB error detection with LED alerts
- **Web dashboard** — Lightweight web UI for system status, WiFi roaming management, and WAN monitoring
- **Remote desktop** — noVNC-based remote access running in an Alpine Linux chroot (for captive portal auth and more)
- **Claude Code integration** — AI-powered router management with custom slash commands for automated configuration, diagnostics, and troubleshooting

## Hardware

| Component | Role | Notes |
|-----------|------|-------|
| Raspberry Pi 4 (4GB) | Router | Running OpenMPTCProuter v0.63 (ext4) |
| Powered USB hub (2A+) | USB expansion | Required for MT7601U stability |
| AR9271 USB dongle | WiFi access point | 2.4GHz, ath9k_htc, AP mode |
| MT7601U USB dongle | WiFi roaming client | 2.4GHz only, managed mode only |
| Phone 1 (USB tethering) | WAN1 | 4G/5G via USB |
| Phone 2 (USB tethering) | WAN2 | 4G/5G via USB |
| VPS | Tunnel endpoint | Glorytun TCP, public exit IP |

### USB Topology

```
RPi 4 USB ports
├── 1-1.1: Powered USB hub
│   ├── 1-1.1.1: Phone 2 (usb1, wan3)
│   ├── 1-1.1.2: Phone 1 (usb0, wan1)
│   └── 1-1.1.3: MT7601U (wan4, WiFi roaming)
└── 1-1.4: AR9271 (WiFi AP)
```

## Network Architecture

```
                    ┌─────────────────┐
                    │       VPS       │
                    │  (Public exit)  │
                    │  Glorytun TCP   │
                    └────────┬────────┘
                             │ Tunnel (10.255.255.x)
                             │
              ┌──────────────┴──────────────┐
              │     Raspberry Pi 4          │
              │     OpenMPTCProuter         │
              │                             │
              │  wan1: USB tethering (4G)   │
              │  wan2: WiFi client (5+2.4G) │
              │  wan3: USB tethering (4G)   │
              │  wan4: WiFi roaming (2.4G)  │
              │                             │
              │  AP: OMR-WiFi (192.168.200) │
              │  LAN: eth0 (192.168.100)    │
              └─────────────────────────────┘
```

All WAN interfaces are aggregated via MPTCP through the Glorytun tunnel. Clients connected to the WiFi AP or LAN get internet through the VPS exit IP.

## Project Structure

```
seamless-wan/
├── README.md
├── LICENSE
├── docs/
│   ├── install.md          # Step-by-step installation guide
│   ├── architecture.md     # Detailed network architecture
│   └── hardware.md         # Bill of materials and wiring
├── scripts/
│   ├── host/               # Scripts for the OMR host (ash shell)
│   │   ├── wifi-roaming.sh
│   │   ├── power-monitor.sh
│   │   ├── start-novnc.sh
│   │   ├── alpine-enter.sh
│   │   └── claude-launcher.sh
│   └── chroot/             # Scripts for the Alpine chroot
│       ├── start-novnc.sh
│       ├── start-dashboard.sh
│       └── captive-firefox.sh
├── config/
│   ├── hotplug/            # OpenWrt hotplug scripts
│   │   ├── 99-tun0-mtu
│   │   └── 99-captive-routing
│   ├── init.d/             # procd service definitions
│   │   ├── novnc
│   │   ├── dashboard
│   │   ├── wifi-roaming
│   │   └── power-monitor
│   ├── openbox/            # Openbox window manager config
│   │   └── menu.xml
│   └── wifi-roaming.conf   # Known WiFi networks
├── dashboard/              # Web dashboard
│   ├── server.py           # HTTP server (port 8080)
│   ├── auth.py             # Basic Auth + sessions
│   ├── host_commands.py    # SSH command wrapper
│   ├── models.py           # API response dataclasses
│   └── static/             # HTML/CSS/JS frontend
└── claude/                 # Claude Code integration
    ├── CLAUDE.md           # Instructions for embedded Claude
    └── skills/             # Slash command skills (/omr-*)
        ├── omr-status/
        ├── omr-wifi/
        ├── omr-tethering/
        ├── omr-diagnose/
        ├── omr-shadowsocks/
        ├── omr-wan/
        ├── omr-reboot/
        └── omr-roaming/
```

## Quick Start

See [docs/install.md](docs/install.md) for the full installation guide.

### Prerequisites

- Raspberry Pi 4 (4GB recommended)
- OpenMPTCProuter v0.63+ (ext4 image, **not** squashfs)
- A VPS with Glorytun configured
- 64GB+ SD card
- Powered USB hub (for multiple USB devices)

### Overview

1. Flash OpenMPTCProuter on the SD card
2. Resize partitions (rootfs 8GB + alpine-data on remaining space)
3. Configure VPS connection (Glorytun tunnel)
4. Set up WAN interfaces (USB tethering + WiFi)
5. Install Alpine chroot (noVNC + Claude Code)
6. Deploy seamless-wan scripts and services
7. Configure WiFi AP and captive portal routing

## Important Warnings

- **Never bridge eth0** (`br-lan`) — breaks WAN macvlan interfaces
- **Never modify VPS iptables** without `iptables-save` afterwards
- OMR filesystem can go **read-only** — run `mount -o remount,rw /` before writing
- WiFi interface names (`phyX-sta0`) **change on reboot** — scripts detect them dynamically
- MT7601U requires a **powered USB hub** (USB error -71 without it)
- OMR uses `ash` shell — **no bashisms** (no brace expansion, no arrays)

## License

[MIT](LICENSE)
