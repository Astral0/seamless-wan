SSH to the RPi OpenMPTCProuter (root@192.168.100.1) and check USB tethering status.

1. Check USB devices: `lsusb` — Samsung phones should appear
2. Check network interfaces: `ip link show usb0`, `ip link show usb1`
3. Check wan1/wan3 status: `ifstatus wan1`, `ifstatus wan3`
4. If a phone is in modem/ACM mode instead of tethering:
   - `ls /dev/ttyACM*` — if these exist, phone is in modem mode
   - Fix: On the phone, disable then re-enable "USB tethering" in settings

Common issues:
- After RPi reboot, USB tethering must be re-enabled on both phones
- Phone may switch to charging-only mode — re-enable tethering
- usb0/usb1 assignment may swap if phones are detected in different order
