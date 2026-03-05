SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and manage WAN interfaces.

Show all WAN status:
```
for wan in wan1 wan2 wan3 wan4; do
    echo "=== $wan ==="
    ifstatus $wan 2>/dev/null | jsonfilter -e '@.up' -e '@.device' -e '@["ipv4-address"][0].address' 2>/dev/null
    echo ""
done
```

WAN mapping:
- wan1: usb0 (USB tethering, Phone 1)
- wan2: phyX-sta0 (WiFi client, built-in, ip4table=2)
- wan3: usb1 (USB tethering, Phone 2, ip4table=7)
- wan4: phyX-sta0 (MT7601U roaming, ip4table=8)

Common operations:
- Restart a WAN: `ifdown wanX && ifup wanX`
- Check multipath: `uci get network.wanX.multipath`
- Toggle multipath: `uci set network.wanX.multipath='on|off'` then `uci commit network`

IMPORTANT: Always `mount -o remount,rw /` before UCI commits.
