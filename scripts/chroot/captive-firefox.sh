#!/bin/sh
# seamless-wan: Launch Firefox as captive user (traffic bypasses VPN, goes direct via WiFi)
exec su -l captive -c 'DISPLAY=:1 firefox-esr http://detectportal.firefox.com/canonical.html' 2>/dev/null
