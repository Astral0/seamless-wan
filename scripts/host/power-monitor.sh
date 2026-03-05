#!/bin/sh
# seamless-wan: Power and USB monitoring daemon for Raspberry Pi
# Monitors undervoltage, temperature, and USB errors with LED alerts.
# LED signals: solid=OK, slow blink (500ms)=warning, fast blink (100ms)=alert

LOG_TAG="power-monitor"
PWR_LED="/sys/class/leds/PWR"
CHECK_INTERVAL=10
USB_ERROR_COUNT=0

led_normal() {
    echo default-on > "$PWR_LED/trigger"
}

led_alert() {
    echo timer > "$PWR_LED/trigger"
    echo 100 > "$PWR_LED/delay_on"
    echo 100 > "$PWR_LED/delay_off"
}

led_warn() {
    echo timer > "$PWR_LED/trigger"
    echo 500 > "$PWR_LED/delay_on"
    echo 500 > "$PWR_LED/delay_off"
}

led_normal
logger -t "$LOG_TAG" "Power monitor started"

while true; do
    ALERT=0
    WARN=0
    REASONS=""

    # Check throttling (undervoltage, frequency capping, etc.)
    THROTTLE=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
    if [ "$THROTTLE" != "0x0" ] && [ -n "$THROTTLE" ]; then
        ALERT=1
        REASONS="${REASONS}throttle=$THROTTLE "
    fi

    # Check CPU temperature
    TEMP=$(($(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null) / 1000))
    if [ "$TEMP" -gt 80 ]; then
        ALERT=1
        REASONS="${REASONS}temp=${TEMP}C "
    elif [ "$TEMP" -gt 70 ]; then
        WARN=1
        REASONS="${REASONS}temp=${TEMP}C "
    fi

    # Check for new USB errors in dmesg
    NEW_ERRORS=$(dmesg | grep -ciE 'overcurrent|error.*-71|usb.*error|usb.*failed|undervolt')
    if [ "$NEW_ERRORS" -gt "$USB_ERROR_COUNT" ]; then
        DIFF=$((NEW_ERRORS - USB_ERROR_COUNT))
        ALERT=1
        REASONS="${REASONS}usb_errors=+$DIFF "
        USB_ERROR_COUNT=$NEW_ERRORS
    fi

    # Set LED state
    if [ $ALERT -eq 1 ]; then
        led_alert
        logger -t "$LOG_TAG" "ALERT: $REASONS"
    elif [ $WARN -eq 1 ]; then
        led_warn
        logger -t "$LOG_TAG" "WARN: $REASONS"
    else
        led_normal
    fi

    sleep "$CHECK_INTERVAL"
done
