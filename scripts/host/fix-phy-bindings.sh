#!/bin/sh
# seamless-wan: Fix WiFi phy-to-WAN bindings after boot
# The phyN numbering changes on every reboot (especially with USB hubs).
# This script resolves the correct phyN for each radio using UCI paths
# (which are stable) and updates network.wanX.device accordingly.
#
# Usage: fix-phy-bindings.sh [--wait]
#   --wait: wait up to 30s for WiFi interfaces to appear (for boot use)

LOG_TAG="fix-phy"

log() {
    logger -t "$LOG_TAG" "$1"
}

# Resolve UCI radio path to current phyN-sta0 interface name
# Usage: resolve_phy_iface <radio_name>
# Returns interface name on stdout, or empty string
resolve_phy_iface() {
    local radio="$1"
    local uci_path iface_mode
    uci_path=$(uci get "wireless.$radio.path" 2>/dev/null)
    [ -z "$uci_path" ] && return 1

    # Get interface mode from UCI (sta or ap)
    iface_mode=$(uci get "wireless.default_${radio}.mode" 2>/dev/null)
    [ -z "$iface_mode" ] && iface_mode="sta"

    for phy_dir in /sys/class/ieee80211/phy*; do
        [ -d "$phy_dir" ] || continue
        local phyname sysfs_path
        phyname=$(basename "$phy_dir")

        # Get sysfs device path, strip to match UCI format
        sysfs_path=$(readlink -f "$phy_dir" 2>/dev/null)
        # Remove everything up to and including "devices/platform/"
        sysfs_path=$(echo "$sysfs_path" | sed 's|.*devices/platform/||;s|/ieee80211/.*||')

        # Also try without "platform/" prefix for non-platform devices
        local uci_stripped
        uci_stripped=$(echo "$uci_path" | sed 's|^platform/||')
        local sysfs_stripped
        sysfs_stripped=$(echo "$sysfs_path" | sed 's|^platform/||')

        if [ "$sysfs_path" = "$uci_path" ] || \
           [ "$sysfs_stripped" = "$uci_stripped" ] || \
           [ "$sysfs_path" = "$uci_stripped" ] || \
           [ "$sysfs_stripped" = "$uci_path" ]; then
            # Found matching phy, look for the interface
            local suffix
            if [ "$iface_mode" = "ap" ]; then
                suffix="ap0"
            else
                suffix="sta0"
            fi
            local netif="${phyname}-${suffix}"
            if [ -e "/sys/class/net/$netif" ]; then
                echo "$netif"
                return 0
            fi
        fi
    done
    return 1
}

# Fix binding for one radio/wan pair
# Usage: fix_binding <radio> <wan>
fix_binding() {
    local radio="$1" wan="$2"
    local current_dev new_dev

    new_dev=$(resolve_phy_iface "$radio")
    if [ -z "$new_dev" ]; then
        # Interface doesn't exist yet — bring up the radio and retry
        log "$radio: interface missing, running wifi up $radio..."
        wifi up "$radio" 2>/dev/null
        sleep 5
        new_dev=$(resolve_phy_iface "$radio")
        if [ -z "$new_dev" ]; then
            log "WARNING: cannot resolve interface for $radio ($wan) even after wifi up"
            return 1
        fi
    fi

    current_dev=$(uci get "network.$wan.device" 2>/dev/null)
    if [ "$current_dev" = "$new_dev" ]; then
        log "$wan: device=$new_dev (unchanged)"
        return 0
    fi

    log "$wan: device $current_dev -> $new_dev"
    uci set "network.$wan.device=$new_dev"
    return 0
}

# --- Main ---

WAIT=0
[ "$1" = "--wait" ] && WAIT=1

# Wait for WiFi interfaces to appear (boot timing)
if [ "$WAIT" = "1" ]; then
    log "Waiting for WiFi interfaces..."
    tries=0
    while [ $tries -lt 15 ]; do
        # Check if at least one phyX-sta0 exists
        found=0
        for iface in /sys/class/net/phy*-sta0; do
            [ -e "$iface" ] && found=1 && break
        done
        [ "$found" = "1" ] && break
        tries=$((tries + 1))
        sleep 2
    done
    if [ "$found" = "0" ]; then
        log "WARNING: no WiFi STA interfaces found after 30s"
    fi
fi

log "Fixing phy bindings..."

# Ensure filesystem is writable
mount -o remount,rw / 2>/dev/null

changed=0

# radio0 = brcmfmac (built-in WiFi) -> wan2
fix_binding radio0 wan2 && changed=1

# radio1 = mt7601u (USB dongle via hub) -> wan4
fix_binding radio1 wan4 && changed=1

# Commit if anything changed
if [ "$changed" = "1" ]; then
    uci commit network
    log "Network config committed, reloading..."
    /etc/init.d/network reload
    log "Done"
else
    log "No changes needed"
fi
