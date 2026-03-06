@echo off
echo Restarting all services on RPi...
ssh root@192.168.100.1 "service dashboard restart; service wifi-roaming restart; service novnc restart"
timeout /t 2 >nul
echo.
echo === Service status ===
ssh root@192.168.100.1 "for s in dashboard wifi-roaming novnc; do printf '%-20s ' $s; service $s status; done"
pause
