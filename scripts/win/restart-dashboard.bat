@echo off
echo Restarting dashboard on RPi...
ssh root@192.168.100.1 "service dashboard restart"
timeout /t 2 >nul
ssh root@192.168.100.1 "service dashboard status"
pause
