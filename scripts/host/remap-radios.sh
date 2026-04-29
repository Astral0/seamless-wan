#!/bin/sh
# seamless-wan: Re-detect USB WiFi dongles and remap UCI radio paths
#
# Each radio is identified by its kernel driver (which is stable per dongle
# model). When a dongle is moved to another USB port, its sysfs path changes
# but its driver does not, so we find it again and rewrite the UCI path.
#
# After updating paths, wifi is reloaded (to recreate phyN-staX interfaces
# matching the new phy numbering) and fix-phy-bindings.sh is invoked to
# update network.wanX.device with the resulting interface names.
#
# Usage: remap-radios.sh
# Output: human-readable JSON-ish status on stdout, errors on stderr

LOG_TAG="remap-radios"

log() {
    logger -t "$LOG_TAG" "$1"
    echo "$1"
}

# Radio -> expected kernel driver
# Edit here when adding a new dongle.
radio_driver() {
    case "$1" in
        radio0) echo "brcmfmac" ;;     # RPi 4 built-in WiFi
        radio1) echo "mt7601u" ;;      # MT7601U dongle (roaming)
        radio2) echo "ath9k_htc" ;;    # AR9271 dongle (AP)
        *) return 1 ;;
    esac
}

# Find the current sysfs path of the (unique) phy that uses a given driver.
# Returns the UCI-style path on stdout, or empty string + nonzero exit.
find_phy_path_by_driver() {
    local driver="$1"
    for phy_dir in /sys/class/ieee80211/phy*; do
        [ -d "$phy_dir" ] || continue
        local d
        d=$(readlink "$phy_dir/device/driver" 2>/dev/null | xargs -r basename)
        if [ "$d" = "$driver" ]; then
            local sysfs_path
            sysfs_path=$(readlink -f "$phy_dir" 2>/dev/null)
            sysfs_path=$(echo "$sysfs_path" | sed 's|.*devices/platform/||;s|/ieee80211/.*||')
            echo "$sysfs_path"
            return 0
        fi
    done
    return 1
}

# Compare two UCI paths, accepting an optional leading "platform/"
paths_equal() {
    local a="$1" b="$2"
    [ "$a" = "$b" ] && return 0
    [ "${a#platform/}" = "${b#platform/}" ] && return 0
    return 1
}

# --- Main ---

mount -o remount,rw / 2>/dev/null

log "Scanning USB WiFi dongles..."

changed_paths=0
detected=""
missing=""

for radio in radio0 radio1 radio2 radio3 radio4; do
    # Skip radios that aren't configured
    uci -q get "wireless.$radio.path" >/dev/null || continue

    driver=$(radio_driver "$radio") || {
        log "$radio: no driver mapping defined, skipping"
        continue
    }

    new_path=$(find_phy_path_by_driver "$driver")
    if [ -z "$new_path" ]; then
        log "$radio ($driver): no phy found — dongle missing?"
        missing="$missing $radio($driver)"
        continue
    fi

    cur_path=$(uci get "wireless.$radio.path" 2>/dev/null)
    detected="$detected $radio=$driver@$new_path"

    if paths_equal "$cur_path" "$new_path"; then
        log "$radio ($driver): path unchanged"
        continue
    fi

    log "$radio ($driver): path $cur_path -> $new_path"
    uci set "wireless.$radio.path=$new_path"
    changed_paths=$((changed_paths + 1))
done

# Clean up duplicate auto-detected radios: any radio not in our managed
# map whose path equals one of our managed paths is a stale duplicate
# created by OpenWrt's wifi auto-detect. Removing it prevents conflicts.
removed_dupes=0
for radio_section in $(uci -q show wireless | sed -n "s/^wireless\.\(radio[0-9]\+\)=wifi-device$/\1/p"); do
    radio_driver "$radio_section" >/dev/null && continue
    dup_path=$(uci -q get "wireless.$radio_section.path")
    [ -z "$dup_path" ] && continue
    # Is this path one of our managed radios?
    for managed in radio0 radio1 radio2; do
        managed_path=$(uci -q get "wireless.$managed.path")
        [ -z "$managed_path" ] && continue
        if paths_equal "$dup_path" "$managed_path"; then
            log "Removing duplicate $radio_section (same path as $managed)"
            uci delete "wireless.$radio_section" 2>/dev/null
            uci delete "wireless.default_$radio_section" 2>/dev/null
            removed_dupes=$((removed_dupes + 1))
            changed_paths=$((changed_paths + 1))
            break
        fi
    done
done

if [ "$changed_paths" -gt 0 ]; then
    log "Committing wireless config ($changed_paths change(s), $removed_dupes duplicate(s) removed)"
    uci commit wireless

    log "Reloading wifi..."
    wifi reload 2>&1 | sed 's/^/  /' || true

    # Give the kernel a moment to recreate phyN-staX interfaces
    sleep 4
fi

# Always rebind WAN devices: even when paths didn't change, phy numbering
# may have shifted (e.g. dongle was unplugged and replugged on same port).
if [ -x /opt/fix-phy-bindings.sh ]; then
    log "Rebinding WAN devices..."
    /opt/fix-phy-bindings.sh 2>&1 | sed 's/^/  /' || true
fi

echo
echo "Detected:$detected"
[ -n "$missing" ] && echo "Missing:$missing"
echo "Changes: $changed_paths (duplicates removed: $removed_dupes)"
