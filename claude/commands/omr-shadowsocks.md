SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and manage Shadowsocks configuration.

Check current status:
```
uci get openmptcprouter.settings.shadowsocks_disable
uci show shadowsocks-libev 2>/dev/null || uci show shadowsocks 2>/dev/null
ps | grep -i shadow
```

Shadowsocks is currently DISABLED (we use Glorytun TCP only).

To re-enable if needed:
```
mount -o remount,rw /
uci set openmptcprouter.settings.shadowsocks_disable='0'
uci commit openmptcprouter
# Then configure via OMR web UI or UCI
```

IMPORTANT: Do NOT use manager mode on the VPS (causes auth errors with sslocal-rust). Use direct mode only.
