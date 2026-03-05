#!/bin/sh
# seamless-wan: WiFi roaming daemon for secondary WiFi adapter (MT7601U)
# Scans for known networks, logs results. Connection is MANUAL only.
# Usage: wifi-roaming.sh {status|scan|connect SSID|disconnect|daemon}

CONF="/etc/wifi-roaming.conf"
RADIO="radio1"  # UCI radio name for MT7601U
SCAN_INTERVAL=60
LOG_TAG="wifi-roaming"

# Detect the actual interface name dynamically (phyX-sta0 changes on reboot)
get_phy_iface() {
    local path
    path=$(uci get "wireless.$RADIO.path" 2>/dev/null)
    [ -z "$path" ] && return 1
    for phy in /sys/class/ieee80211/phy*; do
        phyname=$(basename "$phy")
        realpath=$(readlink -f "$phy" | sed 's|.*devices/platform/||;s|/ieee80211/.*||')
        if [ "$realpath" = "$path" ]; then
            for iface in /sys/class/net/${phyname}-sta*; do
                [ -e "$iface" ] && basename "$iface" && return 0
            done
        fi
    done
    return 1
}

# Get network interface for wan4
get_wan_iface() {
    get_phy_iface
}

# Load known networks from config
load_networks() {
    [ -f "$CONF" ] || return 1
    grep -v '^#' "$CONF" | grep -v '^$'
}

# Scan for available WiFi networks
do_scan() {
    IFACE=$(get_wan_iface)
    if [ -z "$IFACE" ]; then
        echo "ERROR: Cannot detect WiFi interface for $RADIO"
        return 1
    fi
    echo "Scanning on $IFACE..."
    iw dev "$IFACE" scan 2>/dev/null | awk '
        /^BSS / { bssid=$2; signal=""; ssid="" }
        /signal:/ { signal=$2 " " $3 }
        /SSID:/ { ssid=substr($0, index($0, ":")+2) }
        /DS Parameter set: channel/ { chan=$NF }
        bssid && ssid && signal { print signal "\t" ssid; bssid=""; signal=""; ssid="" }
    ' | sort -n
}

# Check current connection status
do_status() {
    IFACE=$(get_wan_iface)
    if [ -z "$IFACE" ]; then
        echo "Interface: not detected (radio=$RADIO)"
        return 1
    fi
    echo "Interface: $IFACE (radio=$RADIO)"
    LINK=$(iw dev "$IFACE" link 2>/dev/null)
    if echo "$LINK" | grep -q "Connected"; then
        SSID=$(echo "$LINK" | grep 'SSID:' | awk '{print $2}')
        SIGNAL=$(echo "$LINK" | grep 'signal:' | awk '{print $2, $3}')
        echo "Status: Connected to $SSID ($SIGNAL)"
        IP=$(ip addr show dev "$IFACE" 2>/dev/null | grep 'inet ' | awk '{print $2}')
        [ -n "$IP" ] && echo "IP: $IP"
    else
        echo "Status: Not connected"
    fi
    echo ""
    echo "Known networks:"
    load_networks | while IFS='|' read -r ssid key prio; do
        echo "  [$prio] $ssid"
    done
}

# Connect to a specific SSID
do_connect() {
    TARGET_SSID="$1"
    [ -z "$TARGET_SSID" ] && { echo "Usage: $0 connect <SSID>"; return 1; }

    # Look up in config
    ENTRY=$(load_networks | grep "^${TARGET_SSID}|")
    if [ -z "$ENTRY" ]; then
        echo "SSID '$TARGET_SSID' not in config. Add it to $CONF first."
        return 1
    fi

    KEY=$(echo "$ENTRY" | cut -d'|' -f2)
    IFACE=$(get_wan_iface)
    [ -z "$IFACE" ] && { echo "ERROR: Cannot detect interface"; return 1; }

    echo "Connecting to $TARGET_SSID on $IFACE..."

    # Find UCI section for this radio's STA interface
    UCI_SECTION=$(uci show wireless 2>/dev/null | grep "device='$RADIO'" | grep default_ | head -1 | cut -d. -f2 | cut -d. -f1)
    [ -z "$UCI_SECTION" ] && UCI_SECTION="default_${RADIO}"

    uci set "wireless.$UCI_SECTION.ssid=$TARGET_SSID"
    if [ "$KEY" = "open" ]; then
        uci set "wireless.$UCI_SECTION.encryption=none"
        uci delete "wireless.$UCI_SECTION.key" 2>/dev/null
    else
        uci set "wireless.$UCI_SECTION.encryption=psk2"
        uci set "wireless.$UCI_SECTION.key=$KEY"
    fi
    uci commit wireless
    wifi reload "$RADIO"
    sleep 3

    # Check result
    LINK=$(iw dev "$IFACE" link 2>/dev/null)
    if echo "$LINK" | grep -q "Connected"; then
        CONNECTED_SSID=$(echo "$LINK" | grep 'SSID:' | awk '{print $2}')
        echo "Connected to $CONNECTED_SSID"
        logger -t "$LOG_TAG" "Connected to $CONNECTED_SSID"
    else
        echo "Connection attempt sent. Check status in a few seconds."
    fi
}

# Disconnect
do_disconnect() {
    IFACE=$(get_wan_iface)
    [ -z "$IFACE" ] && { echo "ERROR: Cannot detect interface"; return 1; }
    echo "Disconnecting $IFACE..."
    uci set "wireless.default_${RADIO}.ssid=''"
    uci commit wireless
    wifi reload "$RADIO"
    echo "Disconnected"
    logger -t "$LOG_TAG" "Disconnected"
}

# Daemon mode: scan periodically and log known networks found
do_daemon() {
    logger -t "$LOG_TAG" "Daemon started (scan every ${SCAN_INTERVAL}s, NO auto-connect)"
    while true; do
        IFACE=$(get_wan_iface)
        if [ -n "$IFACE" ]; then
            # Only scan if not currently connected
            LINK=$(iw dev "$IFACE" link 2>/dev/null)
            if ! echo "$LINK" | grep -q "Connected"; then
                SCAN_RESULT=$(iw dev "$IFACE" scan 2>/dev/null)
                if [ -n "$SCAN_RESULT" ]; then
                    load_networks | while IFS='|' read -r ssid key prio; do
                        if echo "$SCAN_RESULT" | grep -q "SSID: $ssid"; then
                            SIGNAL=$(echo "$SCAN_RESULT" | grep -B5 "SSID: $ssid" | grep "signal:" | awk '{print $2}' | head -1)
                            logger -t "$LOG_TAG" "Known network available: $ssid (${SIGNAL}dBm, priority=$prio)"
                        fi
                    done
                fi
            fi
        fi
        sleep "$SCAN_INTERVAL"
    done
}

case "$1" in
    status)     do_status ;;
    scan)       do_scan ;;
    connect)    do_connect "$2" ;;
    disconnect) do_disconnect ;;
    daemon)     do_daemon ;;
    *)
        echo "Usage: $0 {status|scan|connect <SSID>|disconnect|daemon}"
        echo ""
        echo "  status      Show current connection and known networks"
        echo "  scan        Scan for available WiFi networks"
        echo "  connect     Connect to a known SSID"
        echo "  disconnect  Disconnect from current network"
        echo "  daemon      Run as background daemon (scan + log only, NO auto-connect)"
        ;;
esac
