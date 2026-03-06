@echo off
echo === Dashboard logs (last 30 lines) ===
ssh root@192.168.100.1 "logread | grep dashboard | tail -30"
pause
