SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and show a complete system status:

1. WAN interfaces status (wan1, wan2, wan3, wan4): `ifstatus wan1`, `ifstatus wan2`, etc. Show IP, device, uptime
2. Tunnel status: `ping -c 1 10.255.255.1` and `ip link show tun0`
3. Public IP: `curl -s http://icanhazip.com`
4. WiFi connections: `iw dev` then `iw dev <iface> link` for each STA interface
5. Services: `ps | grep -E 'wifi-roaming|power-monitor|novnc|x11vnc|websockify'`
6. System: `uptime`, `free`, CPU temp from `/sys/class/thermal/thermal_zone0/temp`
7. USB devices: `lsusb` or `cat /sys/bus/usb/devices/*/product`
8. Power status: `vcgencmd get_throttled`

Present results in a clear summary table.
