#!/bin/sh
# seamless-wan: WAN monitor + auto-recovery
# - Probes each WAN's actual internet connectivity (not just link layer)
# - Detects captive portals (redirect / HTML page instead of HTTP 204)
# - Auto-runs `ifup wanX` after N consecutive failures (renews DHCP, etc.)
# - Writes status JSON to /tmp/wan-monitor.json for the dashboard

PROBE_URL="${PROBE_URL:-http://connectivitycheck.gstatic.com/generate_204}"
INTERVAL="${INTERVAL:-30}"
RECOVER_AFTER="${RECOVER_AFTER:-3}"
STATE_FILE="${STATE_FILE:-/tmp/wan-monitor.json}"
WORK_DIR="${WORK_DIR:-/tmp/wan-monitor}"

mkdir -p "$WORK_DIR"

# Probe one interface. Echoes one of:
#   internet | captive | timeout | no_device | no_ip | error
probe_wan() {
    wan=$1
    dev=$2
    [ -z "$dev" ] && { echo no_device; return; }
    [ -e "/sys/class/net/$dev" ] || { echo no_device; return; }

    ip=$(ip -4 addr show "$dev" 2>/dev/null | awk '/inet /{print $2; exit}')
    [ -z "$ip" ] && { echo no_ip; return; }

    body="$WORK_DIR/probe-$wan.body"
    code=$(curl -s -o "$body" -w "%{http_code}" \
        --max-time 5 --interface "$dev" "$PROBE_URL" 2>/dev/null)

    case "$code" in
        204)
            # Google's standard "no captive portal" response
            echo internet
            ;;
        200)
            # Got HTML — captive portal serving a login page
            echo captive
            ;;
        3??)
            # Redirect (typical captive portal)
            echo captive
            ;;
        000)
            echo timeout
            ;;
        *)
            echo "error_$code"
            ;;
    esac
}

# Build the JSON status file consumed by the dashboard.
build_json() {
    now=$(date +%s)
    {
        echo -n "{\"timestamp\":$now,\"wans\":["
        first=1
        for w in $WANS; do
            [ $first -eq 0 ] && echo -n ","
            first=0
            dev=$(uci get network.$w.device 2>/dev/null)
            link=no
            [ -n "$dev" ] && [ -e "/sys/class/net/$dev" ] && link=yes
            wan_ip=$(ubus call network.interface.$w status 2>/dev/null | jsonfilter -e '@.ipv4-address[0].address' 2>/dev/null)
            status=$(cat "$WORK_DIR/status-$w" 2>/dev/null || echo unknown)
            fails=$(cat "$WORK_DIR/fails-$w" 2>/dev/null || echo 0)
            last_recover=$(cat "$WORK_DIR/last-recover-$w" 2>/dev/null || echo 0)
            printf '{"name":"%s","device":"%s","ip":"%s","link":"%s","status":"%s","failures":%s,"last_recover":%s}' \
                "$w" "$dev" "$wan_ip" "$link" "$status" "$fails" "$last_recover"
        done
        echo "]}"
    } > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Discover WAN interfaces from UCI
WANS=$(uci show network 2>/dev/null | awk -F'[.=]' '/=interface/{print $2}' | grep '^wan')

logger -t wan-monitor "Started, watching: $WANS, probe=$PROBE_URL, interval=${INTERVAL}s"

while true; do
    for w in $WANS; do
        dev=$(uci get network.$w.device 2>/dev/null)
        result=$(probe_wan "$w" "$dev")
        echo "$result" > "$WORK_DIR/status-$w"

        # Healthy states reset the failure counter
        case "$result" in
            internet|captive)
                echo 0 > "$WORK_DIR/fails-$w"
                ;;
            timeout|error_*)
                fails=$(cat "$WORK_DIR/fails-$w" 2>/dev/null || echo 0)
                fails=$((fails + 1))
                echo $fails > "$WORK_DIR/fails-$w"

                # Only attempt recovery on a real interface (skip no_device)
                if [ "$fails" -ge "$RECOVER_AFTER" ] \
                    && [ -n "$dev" ] \
                    && [ -e "/sys/class/net/$dev" ]; then
                    logger -t wan-monitor "$w ($dev) failed ${fails}x ($result), running ifup..."
                    ifup "$w" >/dev/null 2>&1
                    date +%s > "$WORK_DIR/last-recover-$w"
                    echo 0 > "$WORK_DIR/fails-$w"
                fi
                ;;
            *)
                # no_device / no_ip — don't recover, nothing to recover
                ;;
        esac
    done
    build_json
    sleep "$INTERVAL"
done
