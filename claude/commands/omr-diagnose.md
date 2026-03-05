SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and run diagnostics.

Check each layer systematically:

1. **Physical**: `lsusb`, USB errors (`dmesg | grep -i 'usb.*error\|overcurrent' | tail -10`), power (`vcgencmd get_throttled`)
2. **Network interfaces**: `ip addr show`, check each wan device exists
3. **WAN connectivity**: For each wan (1-4): `ifstatus wanX | grep -E 'up|address|device'`
4. **DNS**: `nslookup google.com`, if failing: `/etc/init.d/unbound restart`
5. **Tunnel**: `ping -c 2 10.255.255.1`, `ip link show tun0`, MTU check
6. **VPN routing**: `curl -s http://icanhazip.com` — should return VPS IP (178.16.170.46)
7. **MPTCP**: `ip mptcp endpoint show`
8. **Services**: Check all daemons are running
9. **Captive portal**: `ip rule show | grep uidrange` — should have uid 15 rule
10. **Logs**: `logread | tail -30` — recent errors

Present a diagnosis with any issues found and suggested fixes.
