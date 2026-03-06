@echo off
echo Restarting wifi-roaming on RPi...
ssh root@192.168.100.1 "service wifi-roaming restart"
timeout /t 2 >nul
ssh root@192.168.100.1 "service wifi-roaming status"
pause
