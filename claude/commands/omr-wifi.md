SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and manage WiFi configuration.

Show current WiFi config:
1. `uci show wireless` — all radio and interface settings
2. `iw dev` — detected interfaces
3. For each interface, `iw dev <iface> link` — connection status
4. `iwinfo` if available — signal strength and channel info

If user asks to change WiFi settings, use UCI commands:
- Always `mount -o remount,rw /` before writing
- `uci set wireless.<section>.<key>=<value>`
- `uci commit wireless`
- `wifi reload`

IMPORTANT: WiFi interface names (phyX-sta0) change on reboot depending on USB detection order. Always verify with `iw dev` first.
