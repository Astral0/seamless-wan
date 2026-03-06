@echo off
echo === WiFi roaming logs (last 30 lines) ===
ssh root@192.168.100.1 "logread | grep wifi-roaming | tail -30"
pause
