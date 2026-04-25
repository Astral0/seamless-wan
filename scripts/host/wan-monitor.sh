#!/bin/sh
# seamless-wan: WAN monitor + auto-recovery
# - Probes each WAN's actual internet connectivity (not just link layer)
# - Detects captive portals (HTTP 200/3xx instead of 204)
# - Tracks state transitions: when did each WAN last have internet?
# - Auto-runs `ifup wanX` after N consecutive failures
# - Probes the VPN tunnel and DNS resolver too
# - Writes status JSON to /tmp/wan-monitor.json for the dashboard

PROBE_URL="${PROBE_URL:-http://connectivitycheck.gstatic.com/generate_204}"
INTERVAL="${INTERVAL:-30}"
RECOVER_AFTER="${RECOVER_AFTER:-3}"
STATE_FILE="${STATE_FILE:-/tmp/wan-monitor.json}"
WORK_DIR="${WORK_DIR:-/tmp/wan-monitor}"

mkdir -p "$WORK_DIR"

# Probe one interface. Echoes one of:
#   internet | captive | timeout | no_device | no_ip | error_<code>
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
        204) echo internet ;;
        200) echo captive ;;
        3??) echo captive ;;
        000) echo timeout ;;
        *)   echo "error_$code" ;;
    esac
}

# Probe the tunnel (ping the peer). Echoes "up" or "down".
probe_tunnel() {
    if [ ! -e /sys/class/net/tun0 ]; then echo down; return; fi
    if ping -c 1 -W 2 -I tun0 10.255.255.1 >/dev/null 2>&1; then
        echo up
    else
        echo down
    fi
}

# Probe DNS via local dnsmasq. Echoes "up" or "down".
probe_dns() {
    if nslookup connectivitycheck.gstatic.com 127.0.0.1 >/dev/null 2>&1; then
        echo up
    else
        echo down
    fi
}

# Read previous saved value or default
read_or() {
    [ -f "$1" ] && cat "$1" || echo "$2"
}

# Build the JSON consumed by the dashboard.
build_json() {
    now=$(date +%s)
    {
        printf '{"timestamp":%s,"tunnel":"%s","dns":"%s","wans":[' \
            "$now" "$(read_or $WORK_DIR/tunnel down)" "$(read_or $WORK_DIR/dns down)"
        first=1
        for w in $WANS; do
            [ $first -eq 0 ] && printf ','
            first=0
            dev=$(uci get network.$w.device 2>/dev/null)
            link=no
            [ -n "$dev" ] && [ -e "/sys/class/net/$dev" ] && link=yes
            wan_ip=$(ubus call network.interface.$w status 2>/dev/null | jsonfilter -e '@.ipv4-address[0].address' 2>/dev/null)
            status=$(read_or "$WORK_DIR/status-$w" unknown)
            fails=$(read_or "$WORK_DIR/fails-$w" 0)
            since=$(read_or "$WORK_DIR/since-$w" 0)
            last_internet=$(read_or "$WORK_DIR/last-internet-$w" 0)
            last_recover=$(read_or "$WORK_DIR/last-recover-$w" 0)
            printf '{"name":"%s","device":"%s","ip":"%s","link":"%s","status":"%s","failures":%s,"since":%s,"last_internet":%s,"last_recover":%s}' \
                "$w" "$dev" "$wan_ip" "$link" "$status" "$fails" "$since" "$last_internet" "$last_recover"
        done
        printf ']}'
    } > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Discover WAN interfaces from UCI
WANS=$(uci show network 2>/dev/null | awk -F'[.=]' '/=interface/{print $2}' | grep '^wan')

logger -t wan-monitor "Started, watching: $WANS, probe=$PROBE_URL, interval=${INTERVAL}s"

while true; do
    now=$(date +%s)

    for w in $WANS; do
        dev=$(uci get network.$w.device 2>/dev/null)
        result=$(probe_wan "$w" "$dev")

        # Track status transitions: when did "since" last change?
        prev=$(read_or "$WORK_DIR/status-$w" "")
        if [ "$prev" != "$result" ]; then
            echo "$now" > "$WORK_DIR/since-$w"
            logger -t wan-monitor "$w: $prev -> $result"
        fi
        echo "$result" > "$WORK_DIR/status-$w"

        # Healthy states reset the failure counter
        case "$result" in
            internet)
                echo 0 > "$WORK_DIR/fails-$w"
                echo "$now" > "$WORK_DIR/last-internet-$w"
                ;;
            captive)
                echo 0 > "$WORK_DIR/fails-$w"
                ;;
            timeout|error_*)
                fails=$(read_or "$WORK_DIR/fails-$w" 0)
                fails=$((fails + 1))
                echo $fails > "$WORK_DIR/fails-$w"

                if [ "$fails" -ge "$RECOVER_AFTER" ] \
                    && [ -n "$dev" ] \
                    && [ -e "/sys/class/net/$dev" ]; then
                    logger -t wan-monitor "$w ($dev) failed ${fails}x ($result), running ifup..."
                    ifup "$w" >/dev/null 2>&1
                    echo "$now" > "$WORK_DIR/last-recover-$w"
                    echo 0 > "$WORK_DIR/fails-$w"
                fi
                ;;
        esac
    done

    probe_tunnel > "$WORK_DIR/tunnel"
    probe_dns > "$WORK_DIR/dns"

    build_json
    sleep "$INTERVAL"
done
