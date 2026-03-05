SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and manage WiFi roaming (MT7601U on wan4).

Available commands:
1. **Status**: `/opt/wifi-roaming.sh status`
2. **Scan**: `/opt/wifi-roaming.sh scan` — show available networks with signal strength
3. **Connect**: `/opt/wifi-roaming.sh connect <SSID>` — connect to a known network
4. **Disconnect**: `/opt/wifi-roaming.sh disconnect`
5. **Config**: `cat /etc/wifi-roaming.conf` — show known networks
6. **Add network**: Edit `/etc/wifi-roaming.conf` (format: `SSID|key|priority`, use `open` for open networks)
7. **Logs**: `logread | grep wifi-roaming | tail -20`

IMPORTANT:
- NO auto-connect. The daemon only scans and logs.
- Train WiFi (_SNCF_*) is on wan2 (built-in WiFi), NOT on roaming.
- Always `mount -o remount,rw /` before editing config files.
