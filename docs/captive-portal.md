# Captive Portal Support

OpenMPTCProuter does not natively support captive portals (hotel WiFi, train WiFi, etc.). This project implements a workaround.

## The Problem

1. OMR's dnsmasq has `rebind_protection` enabled, which blocks DNS responses pointing to private IPs (e.g. `wifi.sncf` → `10.113.0.1`)
2. All captive portals use private IPs
3. The VPN tunnel captures all traffic, preventing direct access to the portal page
4. Without validating the portal, there's no internet, so the tunnel can't work either

## The Solution

A dedicated Firefox instance runs as a special user (`captive`, uid 15) whose traffic is routed directly through the WiFi interface, bypassing the VPN tunnel. The DNS is temporarily pointed at the WAN gateway instead of dnsmasq.

### Components

- **`/mnt/data/usr/local/bin/captive-firefox`** (chroot) — Reads the WAN gateway from `/tmp/captive-gw`, sets it as DNS, launches Firefox, restores DNS on exit
- **`/etc/hotplug.d/iface/99-captive-routing`** (host) — On WAN ifup: adds `ip rule` for uid 15 → WAN routing table, writes gateway IP to `/mnt/data/tmp/captive-gw`
- **User `captive`** (uid 15) in Alpine chroot — Dedicated user for policy routing
- **Openbox menu** — "Firefox Captive Portal" entry in right-click menu

### User Flow

1. Power on the RPi
2. Connect to a WiFi network via LuCI (`http://192.168.100.1`)
3. Open noVNC (`http://192.168.100.1:6080/vnc.html`)
4. Right-click → **Firefox Captive Portal**
5. The captive portal page loads → accept terms
6. Internet is now available → the VPN tunnel establishes automatically

### Technical Details

Routing rule:
```
ip rule add uidrange 15-15 table <wan_table> prio 5000
```

DNS bypass (temporary, while Firefox is open):
```
# Before: nameserver 127.0.0.1 (dnsmasq with rebind protection)
# During: nameserver <wan_gateway> (direct, no filtering)
# After:  nameserver 127.0.0.1 (restored)
```
