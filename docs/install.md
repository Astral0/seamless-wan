# Installation Guide

Step-by-step guide to set up seamless-wan on a Raspberry Pi 4 with OpenMPTCProuter.

## Prerequisites

- Raspberry Pi 4 (4GB recommended)
- 64GB+ SD card
- Powered USB hub (2A+, required for MT7601U stability)
- AR9271 USB WiFi dongle (for AP mode)
- MT7601U USB WiFi dongle (for roaming, optional)
- 1-2 smartphones for USB tethering
- A VPS with Glorytun server configured
- A second RPi or Linux PC for partition resizing (optional but recommended)

## Phase 1 — Flash OpenMPTCProuter

1. Download the OMR image for RPi4:
   - URL: https://www.openmptcprouter.com/download
   - Choose: RPi4 64-bit, **ext4-factory** (NOT squashfs)
   - ext4 allows partition resizing later

2. Flash to SD card:
   ```bash
   gunzip -k openmptcprouter-v0.63-*.img.gz
   dd if=openmptcprouter-v0.63-*.img of=/dev/sdX bs=4M status=progress
   sync
   ```

3. Insert SD into RPi4, connect eth0 to local network, power on

4. Access web UI at https://192.168.100.1, set root password, add SSH key

## Phase 2 — Resize Partitions

Use a second RPi or Linux PC to resize the SD card:

```bash
# Resize partition 2 (rootfs): 512MB → 8GB
fdisk /dev/sdX
# p (note start sector of partition 2)
# d → 2
# n → primary → 2 → same start sector → +8G
# w

e2fsck -fy /dev/sdX2
resize2fs /dev/sdX2

# Create partition 3 (alpine-data) on remaining space
fdisk /dev/sdX
# n → primary → 3 → default start → default end
# w

mkfs.ext4 -L alpine-data /dev/sdX3
```

## Phase 3 — Configure VPS Connection

```bash
# Set VPS server
uci set openmptcprouter.server1.ip='YOUR_VPS_IP'
uci set openmptcprouter.server1.port='YOUR_VPS_SSH_PORT'
uci set openmptcprouter.server1.master='1'
uci set openmptcprouter.settings.master='server1'
uci set openmptcprouter.settings.api_key='YOUR_API_KEY'
uci set openmptcprouter.settings.shadowsocks_disable='1'
uci commit openmptcprouter

# Configure Glorytun tunnel
uci set glorytun.vpn.host='YOUR_VPS_IP'
uci set glorytun.vpn.port='65001'
uci set glorytun.vpn.key='YOUR_GLORYTUN_KEY'
uci commit glorytun
/etc/init.d/glorytun restart
```

> Note: The init script is `/etc/init.d/glorytun` (NOT glorytun-tcp)

## Phase 4 — Configure WAN Interfaces

### wan1 — USB Tethering (Phone 1)

**Important**: wan1 defaults to macvlan/static on eth0. Must be reconfigured.

```bash
mount -o remount,rw /
uci set network.wan1.device='usb0'
uci set network.wan1.proto='dhcp'
uci delete network.wan1.type 2>/dev/null
uci delete network.wan1.masterintf 2>/dev/null
uci delete network.wan1_dev 2>/dev/null
uci commit network
```

### wan2 — WiFi Client (built-in dual-band)

**Important**: wan2 also defaults to macvlan/static on eth0.

```bash
# Check actual interface name with: iw dev
uci set network.wan2.proto='dhcp'
uci set network.wan2.device='phy1-sta0'  # Adapt to your phyX-sta0
uci set network.wan2.ip4table='2'
uci delete network.wan2.ipaddr 2>/dev/null
uci delete network.wan2.netmask 2>/dev/null
uci commit network

uci set wireless.radio0.band='2g'
uci set wireless.radio0.channel='auto'
uci set wireless.radio0.disabled='0'
uci set wireless.default_radio0.ssid='YOUR_WIFI_SSID'
uci set wireless.default_radio0.encryption='psk2'
uci set wireless.default_radio0.key='YOUR_WIFI_KEY'
uci set wireless.default_radio0.network='wan2'
uci set wireless.default_radio0.mode='sta'
uci commit wireless
wifi
```

### wan3 — USB Tethering (Phone 2)

```bash
uci set network.wan3=interface
uci set network.wan3.device='usb1'
uci set network.wan3.proto='dhcp'
uci set network.wan3.metric='7'
uci set network.wan3.ip4table='7'
uci set network.wan3.multipath='on'

CURRENT_WAN=$(uci get firewall.@zone[1].network)
uci set firewall.@zone[1].network="$CURRENT_WAN wan3"

uci set openmptcprouter.wan3=interface
uci set openmptcprouter.wan3.multipath='on'

uci commit network && uci commit firewall && uci commit openmptcprouter
ifup wan3
/etc/init.d/firewall reload
/etc/init.d/omr-tracker restart
```

### wan4 — WiFi Roaming (MT7601U, optional)

Requires powered USB hub. See the [hardware guide](hardware.md) for USB topology.

```bash
# Adapt radioX to your MT7601U radio number
uci set wireless.radioX.disabled='0'
uci set wireless.default_radioX.network='wan4'
uci set wireless.default_radioX.mode='sta'
uci commit wireless

uci set network.wan4=interface
uci set network.wan4.proto='dhcp'
uci set network.wan4.metric='8'
uci set network.wan4.ip4table='8'
uci set network.wan4.multipath='on'

# Add to firewall wan zone and OMR config (same pattern as wan3)
uci commit network && uci commit firewall && uci commit openmptcprouter
wifi reload radioX && ifup wan4
```

## Phase 5 — WiFi Access Point (AR9271)

**Never bridge eth0** (`br-lan`) — this breaks WAN macvlan interfaces.

```bash
# Wireless AP config (adapt radio number)
uci set wireless.radio2.disabled='0'
uci set wireless.radio2.channel='auto'
uci set wireless.radio2.country='FR'
uci set wireless.default_radio2.ssid='OMR-WiFi'
uci set wireless.default_radio2.encryption='psk2'
uci set wireless.default_radio2.key='YOUR_WIFI_AP_KEY'
uci set wireless.default_radio2.network='wifilan'
uci set wireless.default_radio2.mode='ap'
uci commit wireless

# Network interface
uci set network.wifilan=interface
uci set network.wifilan.proto='static'
uci set network.wifilan.ipaddr='192.168.200.1'
uci set network.wifilan.netmask='255.255.255.0'
uci commit network

# DHCP
uci set dhcp.wifilan=dhcp
uci set dhcp.wifilan.interface='wifilan'
uci set dhcp.wifilan.start='100'
uci set dhcp.wifilan.limit='150'
uci set dhcp.wifilan.leasetime='12h'
uci set dhcp.wifilan.dhcpv4='server'
uci set dhcp.wifilan.force='1'
uci add_list dhcp.wifilan.dhcp_option='6,192.168.200.1'
uci commit dhcp

# Add to lan zone (CRITICAL: must be lan zone for VPN routing)
uci add_list firewall.zone_lan.network='wifilan'
uci commit firewall
/etc/init.d/firewall reload
wifi
```

## Phase 6 — Alpine Linux Chroot

### Auto-mount partition 3

```bash
uci add fstab mount
uci set fstab.@mount[-1].target='/mnt/data'
uci set fstab.@mount[-1].device='/dev/mmcblk0p3'
uci set fstab.@mount[-1].fstype='ext4'
uci set fstab.@mount[-1].enabled='1'
uci commit fstab
mkdir -p /mnt/data
mount /dev/mmcblk0p3 /mnt/data
```

### Install Alpine chroot

```bash
cd /tmp
wget https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/alpine-minirootfs-3.21.3-aarch64.tar.gz
tar xzf alpine-minirootfs-*.tar.gz -C /mnt/data/

# Prepare and enter chroot
mount -t proc proc /mnt/data/proc
mount -o bind /dev /mnt/data/dev
mount -o bind /dev/pts /mnt/data/dev/pts
mount -t sysfs sys /mnt/data/sys
echo "nameserver 8.8.8.8" > /mnt/data/etc/resolv.conf

chroot /mnt/data /bin/sh -c "
apk update
apk add bash nodejs npm openssh-client iproute2
apk add xvfb openbox x11vnc websockify firefox-esr xterm font-noto novnc xdpyinfo
ln -sf /usr/bin/firefox-esr /usr/bin/firefox
adduser -D -s /bin/bash claude
adduser -D -s /bin/sh captive
# Alpine edge repo for musl 1.2.5+ (required by Claude Code native binary)
echo 'https://dl-cdn.alpinelinux.org/alpine/edge/main' >> /etc/apk/repositories
apk update && apk upgrade musl
"
```

### Install Claude Code (optional)

```bash
# Generate SSH key for claude user
chroot /mnt/data /bin/su -l claude -c 'ssh-keygen -t ed25519 -f /home/claude/.ssh/id_ed25519 -N "" -q'

# Add key to host authorized_keys
cat /mnt/data/home/claude/.ssh/id_ed25519.pub >> /etc/dropbear/authorized_keys

# Install Claude Code (native method)
chroot /mnt/data /bin/su -l claude -c 'npm install -g @anthropic-ai/claude-code && claude install'
# Binary will be at ~/.local/bin/claude
```

### Install OMR slash commands for Claude Code

The `/omr-*` slash commands allow Claude Code on the RPi to manage OMR directly. They must be installed into the `claude` user's `.claude/commands/` directory inside the chroot:

```bash
# From the seamless-wan repo root (on your dev machine or on the RPi)
mkdir -p /mnt/data/home/claude/.claude/commands
cp claude/commands/omr-*.md /mnt/data/home/claude/.claude/commands/
chown -R 1000:1000 /mnt/data/home/claude/.claude
```

Once installed, launching Claude Code on the RPi (`/opt/claude`) will make these commands available:
- `/omr-status` — Full system status overview
- `/omr-wifi` — WiFi configuration management
- `/omr-roaming` — WiFi roaming (scan, connect, config)
- `/omr-wan` — WAN interface management
- `/omr-diagnose` — Systematic diagnostics
- `/omr-tethering` — USB tethering status and troubleshooting
- `/omr-reboot` — Controlled reboot with pre/post checks
- `/omr-shadowsocks` — Shadowsocks configuration

## Phase 7 — Deploy seamless-wan Scripts

```bash
mount -o remount,rw /
mkdir -p /opt

# Copy host scripts
cp scripts/host/wifi-roaming.sh /opt/
cp scripts/host/power-monitor.sh /opt/
cp scripts/host/start-novnc.sh /opt/
cp scripts/host/alpine-enter.sh /opt/
cp scripts/host/claude-launcher.sh /opt/claude
chmod +x /opt/*

# Copy chroot scripts
cp scripts/chroot/start-novnc.sh /mnt/data/root/
cp scripts/chroot/captive-firefox.sh /mnt/data/usr/local/bin/captive-firefox
chmod +x /mnt/data/root/start-novnc.sh /mnt/data/usr/local/bin/captive-firefox

# Copy hotplug scripts
cp config/hotplug/99-tun0-mtu /etc/hotplug.d/iface/
cp config/hotplug/99-captive-routing /etc/hotplug.d/iface/
chmod +x /etc/hotplug.d/iface/99-*

# Copy init scripts
cp config/init.d/novnc /etc/init.d/
cp config/init.d/wifi-roaming /etc/init.d/
cp config/init.d/power-monitor /etc/init.d/
chmod +x /etc/init.d/novnc /etc/init.d/wifi-roaming /etc/init.d/power-monitor

# Copy configs
cp config/wifi-roaming.conf /etc/
cp config/openbox/menu.xml /mnt/data/etc/xdg/openbox/

# Enable services
/etc/init.d/power-monitor enable
/etc/init.d/wifi-roaming enable
/etc/init.d/novnc enable

# Start services
/etc/init.d/power-monitor start
/etc/init.d/wifi-roaming start
/etc/init.d/novnc start
```

## Phase 7b — Monitoring & auto-recovery

Two procd daemons watch the WANs and the critical services, and write status JSON files consumed by the dashboard. See [monitoring.md](monitoring.md) for full details.

```sh
mount -o remount,rw /
REPO_DIR=/root/seamless-wan   # adjust to where this repo is cloned

# Daemons
cp $REPO_DIR/scripts/host/wan-monitor.sh     /opt/wan-monitor.sh
cp $REPO_DIR/scripts/host/service-monitor.sh /opt/service-monitor.sh
cp $REPO_DIR/scripts/host/fix-phy-bindings.sh /opt/fix-phy-bindings.sh
chmod +x /opt/wan-monitor.sh /opt/service-monitor.sh /opt/fix-phy-bindings.sh

# Init scripts
cp $REPO_DIR/config/init.d/wan-monitor       /etc/init.d/wan-monitor
cp $REPO_DIR/config/init.d/service-monitor   /etc/init.d/service-monitor
cp $REPO_DIR/config/init.d/fix-phy-bindings  /etc/init.d/fix-phy-bindings
chmod +x /etc/init.d/wan-monitor /etc/init.d/service-monitor /etc/init.d/fix-phy-bindings

/etc/init.d/wan-monitor enable     && /etc/init.d/wan-monitor start
/etc/init.d/service-monitor enable && /etc/init.d/service-monitor start
/etc/init.d/fix-phy-bindings enable
```

Tunable via env vars in the init.d service files (cf. `monitoring.md`).

## Phase 7c — Web dashboard

The dashboard runs inside the Alpine chroot on port 8080. Default login: `admin` / `seamless` (override with `DASHBOARD_USER` / `DASHBOARD_PASS` env vars).

```sh
CHROOT=/mnt/data
mkdir -p $CHROOT/opt/dashboard/static
cp $REPO_DIR/dashboard/*.py        $CHROOT/opt/dashboard/
cp $REPO_DIR/dashboard/static/*    $CHROOT/opt/dashboard/static/
cp $REPO_DIR/scripts/chroot/start-dashboard.sh $CHROOT/opt/start-dashboard.sh
chmod +x $CHROOT/opt/start-dashboard.sh

cp $REPO_DIR/config/init.d/dashboard /etc/init.d/dashboard
chmod +x /etc/init.d/dashboard
/etc/init.d/dashboard enable
/etc/init.d/dashboard start
```

The dashboard talks to the host via SSH. Make sure the chroot's `claude` user (or whoever runs the dashboard) has its public key in the host's `/etc/dropbear/authorized_keys`. (Phase 6 already does this for the `claude` user.)

Open `http://192.168.100.1:8080` from the LAN. See [dashboard.md](dashboard.md) for the full API and [monitoring.md](monitoring.md) for the alerts/events it surfaces.

## Phase 8 — Verification

Run these checks to verify everything works:

1. **Partition**: `mount | grep mnt/data` → ext4 mounted
2. **noVNC**: Open http://192.168.100.1:6080/vnc.html
3. **Dashboard**: Open http://192.168.100.1:8080 → login admin/seamless
4. **wan1**: `ip addr show usb0` → has IP
5. **wan2**: `iw dev phyX-sta0 link` → Connected
6. **wan3**: `ip addr show usb1` → has IP (tethering must be enabled on phone)
7. **wan4**: `/opt/wifi-roaming.sh status`
8. **Tunnel**: `ping -c 2 10.255.255.1`
9. **Internet**: `curl -s http://icanhazip.com` → should show VPS IP
10. **Trackers**: `ps | grep omr-tracker`
11. **Captive portal**: `chroot /mnt/data su -l captive -c 'wget -qO- http://icanhazip.com'` → should show WiFi IP (not VPS)
12. **wan-monitor**: `cat /tmp/wan-monitor.json` → each WAN should be `internet` or `captive`
13. **service-monitor**: `cat /tmp/service-monitor.json` → all 4 services `running`
14. **Power monitor**: `logread | grep power-monitor`

## Important Notes

- USB tethering must be re-enabled on phones after each RPi reboot
- WiFi interface names (`phyX-sta0`) change depending on USB detection order — `fix-phy-bindings` (Phase 7b) re-resolves them at boot from stable UCI radio paths
- OMR filesystem can go read-only — always `mount -o remount,rw /` before writing
- OMR uses `ash` shell — no bashisms (no `{a,b}`, no arrays); use `pidof` instead of `pgrep -x` (BusyBox `pgrep -x` does not match like GNU)
- DNS issues after reboot: `/etc/init.d/unbound restart` (or just rely on service-monitor to do it)
- After `ifup wanX`, OMR may reset `peerdns` to `0` — re-enable it with `uci set network.wanX.peerdns=1 && uci commit network && ifup wanX`
- VPS NAT for the Glorytun TCP tunnel must masquerade `10.255.255.0/30` → `eth0`. With Shorewall disabled in the LXC, persist the rule with `iptables-save > /etc/iptables.rules` (loaded by `/etc/network/if-up.d/iptables`)
