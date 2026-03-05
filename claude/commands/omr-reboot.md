SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and perform a controlled reboot.

Before rebooting:
1. Warn the user that USB tethering will need to be re-enabled on phones after reboot
2. Warn that WiFi interface names (phyX) may change

Reboot command:
```
reboot
```

After reboot (wait ~60 seconds, then reconnect):
1. Check all services started: `ps | grep -E 'wifi-roaming|power-monitor|novnc'`
2. Check WANs: `ifstatus wan1`, `ifstatus wan2`
3. Check tunnel: `ping -c 1 10.255.255.1`
4. Check noVNC: `curl -s http://localhost:6080 | head -1`
5. If DNS issues: `/etc/init.d/unbound restart`

Ask for user confirmation before rebooting.
