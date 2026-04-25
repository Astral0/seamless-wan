#!/bin/sh
# seamless-wan: monitor critical services and auto-restart with backoff.
# Watches dnsmasq, glorytun, omr-tracker, hostapd. If a service is down for
# RESTART_AFTER consecutive checks, restart it (capped at MAX_RESTARTS per hour
# to avoid loops). Writes /tmp/service-monitor.json.

INTERVAL="${INTERVAL:-30}"
RESTART_AFTER="${RESTART_AFTER:-2}"   # consecutive checks down before restart
MAX_RESTARTS="${MAX_RESTARTS:-4}"      # within COOLDOWN window
COOLDOWN="${COOLDOWN:-3600}"           # seconds
STATE_FILE="${STATE_FILE:-/tmp/service-monitor.json}"
WORK_DIR="${WORK_DIR:-/tmp/service-monitor}"

mkdir -p "$WORK_DIR"

# Each entry: name|init_d|probe_command (use pidof — busybox pgrep -x is unreliable)
SERVICES="dnsmasq|dnsmasq|pidof dnsmasq >/dev/null
glorytun|glorytun|pidof glorytun >/dev/null
omr-tracker|omr-tracker|pidof omr-tracker >/dev/null
hostapd|network|pidof hostapd >/dev/null && ip -br link | grep -q 'phy.*-ap0.*UP'"

read_or() {
    [ -f "$1" ] && cat "$1" || echo "$2"
}

# Count restart timestamps within the cooldown window.
restart_count() {
    name=$1
    file="$WORK_DIR/restarts-$name"
    [ -f "$file" ] || { echo 0; return; }
    now=$(date +%s)
    cutoff=$((now - COOLDOWN))
    awk -v c="$cutoff" '$1 >= c' "$file" | wc -l
}

# Append a restart timestamp and prune old entries.
record_restart() {
    name=$1
    now=$(date +%s)
    cutoff=$((now - COOLDOWN))
    file="$WORK_DIR/restarts-$name"
    echo "$now" >> "$file"
    awk -v c="$cutoff" '$1 >= c' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

# Try to restart a service. Returns 0 if attempted, 1 if blocked by cooldown.
try_restart() {
    name=$1
    init_d=$2
    count=$(restart_count "$name")
    if [ "$count" -ge "$MAX_RESTARTS" ]; then
        logger -t service-monitor "$name: restart capped (${count}/${MAX_RESTARTS} in ${COOLDOWN}s window)"
        return 1
    fi
    logger -t service-monitor "$name: restarting (${count}/${MAX_RESTARTS} attempts so far)"
    /etc/init.d/"$init_d" restart >/dev/null 2>&1
    record_restart "$name"
    return 0
}

build_json() {
    now=$(date +%s)
    {
        printf '{"timestamp":%s,"services":[' "$now"
        first=1
        echo "$SERVICES" | while IFS= read -r line; do
            [ -z "$line" ] && continue
            name=$(echo "$line" | cut -d'|' -f1)
            status=$(read_or "$WORK_DIR/status-$name" unknown)
            fails=$(read_or "$WORK_DIR/fails-$name" 0)
            last_restart=$(read_or "$WORK_DIR/last-restart-$name" 0)
            since=$(read_or "$WORK_DIR/since-$name" 0)
            count=$(restart_count "$name")
            [ $first -eq 0 ] && printf ','
            first=0
            printf '{"name":"%s","status":"%s","failures":%s,"since":%s,"last_restart":%s,"recent_restarts":%s,"capped":%s}' \
                "$name" "$status" "$fails" "$since" "$last_restart" "$count" \
                "$([ "$count" -ge "$MAX_RESTARTS" ] && echo true || echo false)"
        done
        printf ']}'
    } > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

logger -t service-monitor "Started, interval=${INTERVAL}s, restart after ${RESTART_AFTER} fails (max ${MAX_RESTARTS}/${COOLDOWN}s)"

while true; do
    now=$(date +%s)

    echo "$SERVICES" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        name=$(echo "$line" | cut -d'|' -f1)
        init_d=$(echo "$line" | cut -d'|' -f2)
        probe=$(echo "$line" | cut -d'|' -f3-)

        if eval "$probe"; then
            new_status=running
        else
            new_status=down
        fi

        prev=$(read_or "$WORK_DIR/status-$name" "")
        if [ "$prev" != "$new_status" ]; then
            echo "$now" > "$WORK_DIR/since-$name"
            logger -t service-monitor "$name: $prev -> $new_status"
        fi
        echo "$new_status" > "$WORK_DIR/status-$name"

        if [ "$new_status" = "running" ]; then
            echo 0 > "$WORK_DIR/fails-$name"
        else
            fails=$(read_or "$WORK_DIR/fails-$name" 0)
            fails=$((fails + 1))
            echo $fails > "$WORK_DIR/fails-$name"

            if [ "$fails" -ge "$RESTART_AFTER" ]; then
                if try_restart "$name" "$init_d"; then
                    echo "$now" > "$WORK_DIR/last-restart-$name"
                    echo 0 > "$WORK_DIR/fails-$name"
                fi
            fi
        fi
    done

    build_json
    sleep "$INTERVAL"
done
