#!/bin/sh
# Detect WAN gateway by looking at the WAN routing table (not the global table)
# This avoids picking up the VPN tunnel gateway by mistake.
GW=""

# Try each WAN interface's routing table (5=wan1, 7=wan2, 8=wan4)
for table in 7 5 8; do
    GW=$(ip route show table $table 2>/dev/null | awk '/^default/ {print $3; exit}')
    [ -n "$GW" ] && break
done

# Fallback: read from file written by host hotplug
if [ -z "$GW" ]; then
    [ -f /tmp/captive-gw ] && GW=$(cat /tmp/captive-gw)
fi

# Last resort: launch Firefox without DNS fix
if [ -z "$GW" ]; then
    exec su -l captive -c 'DISPLAY=:1 firefox-esr http://detectportal.firefox.com/canonical.html'
fi

# Set DNS to WAN gateway (bypasses dnsmasq rebind protection for captive portals)
cp /etc/resolv.conf /etc/resolv.conf.bak 2>/dev/null
echo "nameserver $GW" > /etc/resolv.conf

# Launch Firefox as captive user (uid 15, routed direct via WAN table)
su -l captive -c 'DISPLAY=:1 firefox-esr http://detectportal.firefox.com/canonical.html' 2>/dev/null

# Restore DNS
if [ -f /etc/resolv.conf.bak ]; then
    mv /etc/resolv.conf.bak /etc/resolv.conf
else
    echo "nameserver 127.0.0.1" > /etc/resolv.conf
fi
