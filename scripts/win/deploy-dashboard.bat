@echo off
echo Deploying dashboard files to RPi...
cd /d %~dp0..\..

echo [1/3] Copying backend files...
scp -O dashboard/host_commands.py dashboard/models.py dashboard/server.py dashboard/auth.py root@192.168.100.1:/mnt/data/opt/dashboard/

echo [2/3] Copying frontend files...
scp -O dashboard/static/dashboard.js dashboard/static/index.html dashboard/static/style.css root@192.168.100.1:/mnt/data/opt/dashboard/static/

echo [3/3] Fixing CRLF and restarting...
ssh root@192.168.100.1 "sed -i 's/\r//' /mnt/data/opt/dashboard/*.py /mnt/data/opt/dashboard/static/*.js /mnt/data/opt/dashboard/static/*.html /mnt/data/opt/dashboard/static/*.css && service dashboard restart"

timeout /t 2 >nul
ssh root@192.168.100.1 "service dashboard status"
echo Done.
pause
