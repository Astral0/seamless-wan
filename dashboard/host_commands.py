"""SSH command execution wrapper for communicating with the OMR host."""

import re
import subprocess
import threading
import time

from models import (
    CommandResult, WANStatus, TunnelStatus, SystemStatus,
    WifiNetwork, KnownNetwork, RoamingStatus, ServiceStatus,
)

SSH_KEY = "/home/claude/.ssh/id_ed25519"
SSH_HOST = "root@127.0.0.1"
SSH_OPTS = [
    "-i", SSH_KEY,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
]

# Global lock for write operations (UCI, config file)
_write_lock = threading.Lock()

# Valid characters for SSID (reject pipe to avoid config parsing issues)
SSID_PATTERN = re.compile(r'^[a-zA-Z0-9 _\-\.@#&!+()]{1,32}$')
# Priority must be 1-100
PRIORITY_RANGE = range(1, 101)


def run_ssh(cmd: str, timeout: int = 30) -> CommandResult:
    """Execute a command on the OMR host via SSH."""
    try:
        result = subprocess.run(
            ["ssh"] + SSH_OPTS + [SSH_HOST, cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        return CommandResult(
            stdout=result.stdout.strip(),
            stderr=result.stderr.strip(),
            returncode=result.returncode,
        )
    except subprocess.TimeoutExpired:
        return CommandResult(stderr="SSH command timed out", returncode=-1)
    except FileNotFoundError:
        return CommandResult(stderr="SSH client not found", returncode=-2)
    except Exception as e:
        return CommandResult(stderr=str(e), returncode=-3)


def validate_ssid(ssid: str) -> str | None:
    """Validate SSID. Returns error message or None if valid."""
    if not ssid:
        return "SSID is required"
    if "|" in ssid:
        return "SSID cannot contain pipe character (|)"
    if len(ssid) > 32:
        return "SSID must be 32 characters or less"
    return None


def validate_priority(priority: int) -> str | None:
    """Validate priority. Returns error message or None if valid."""
    if priority not in PRIORITY_RANGE:
        return "Priority must be between 1 and 100"
    return None


def shell_escape(s: str) -> str:
    """Escape a string for safe use in shell commands via SSH."""
    return s.replace("'", "'\\''")


# --- Status commands ---

def get_system_status() -> SystemStatus:
    """Get system status (uptime, temp, throttling, public IP)."""
    status = SystemStatus()

    # Single SSH call for local system info (fast)
    r = run_ssh(
        "echo \"UP=$(uptime | sed 's/.*up //' | sed 's/,.*load.*//')\";"
        "echo \"TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\";"
        "echo \"THROT=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)\"",
        timeout=10,
    )
    if r.ok:
        for line in r.stdout.splitlines():
            if line.startswith("UP="):
                status.uptime = line[3:].strip()
            elif line.startswith("TEMP="):
                try:
                    status.temp_celsius = int(line[5:].strip()) // 1000
                except ValueError:
                    pass
            elif line.startswith("THROT="):
                status.throttled = line[6:].strip() or "0x0"
                status.throttled_ok = status.throttled == "0x0"

    # Public IP in separate call (can be slow, non-critical)
    r = run_ssh("curl -s --max-time 4 ifconfig.me 2>/dev/null", timeout=8)
    if r.ok and r.stdout:
        status.public_ip = r.stdout.strip()

    return status


def get_wan_status() -> list[WANStatus]:
    """Get status of all WAN interfaces dynamically from UCI."""
    # Single SSH call: discover WANs, get device/type, check IP & link status
    r = run_ssh(
        r"""
        for iface in $(uci show network 2>/dev/null | grep '=interface' | cut -d. -f2 | cut -d= -f1 | grep '^wan'); do
            dev=$(uci get network.$iface.device 2>/dev/null)
            # Detect device type from device name
            case "$dev" in
                usb*) dtype="usb_tethering" ;;
                phy*-sta*) dtype="wifi" ;;
                "") dtype="unknown" ;;
                *) dtype="other" ;;
            esac
            # For wifi_roaming (wan with no device but linked to radio1 STA)
            if [ -z "$dev" ]; then
                # Try dynamic detection via wifi-roaming script
                dev=$(/opt/wifi-roaming.sh status 2>/dev/null | head -1 | awk '{print $2}')
                [ -n "$dev" ] && dtype="wifi_roaming"
            fi
            # Get IP
            ip=""
            up="no"
            if [ -n "$dev" ]; then
                ip=$(ip addr show dev "$dev" 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
                if [ -n "$ip" ]; then
                    up="yes"
                elif ip link show "$dev" 2>/dev/null | grep -q UP; then
                    up="yes"
                fi
            fi
            echo "$iface|$dev|$dtype|$ip|$up"
        done
        """,
        timeout=15,
    )

    wans = []
    if r.ok:
        for line in r.stdout.splitlines():
            parts = line.strip().split("|")
            if len(parts) >= 5:
                wans.append(WANStatus(
                    name=parts[0],
                    interface=parts[1],
                    device_type=parts[2],
                    ip=parts[3],
                    up=parts[4] == "yes",
                ))

    return wans


def get_wan_public_ips() -> dict[str, str]:
    """Get public IP for each WAN from OMR config (instant, no curl)."""
    r = run_ssh(
        r"""
        for iface in $(uci show network 2>/dev/null | grep '=interface' | cut -d. -f2 | cut -d= -f1 | grep '^wan'); do
            pip=$(uci get openmptcprouter.$iface.publicip 2>/dev/null)
            [ -n "$pip" ] && echo "$iface|$pip"
        done
        """,
        timeout=5,
    )
    result = {}
    if r.ok:
        for line in r.stdout.splitlines():
            parts = line.strip().split("|", 1)
            if len(parts) == 2 and parts[1]:
                result[parts[0]] = parts[1]
    return result


def get_tunnel_status() -> TunnelStatus:
    """Get Glorytun tunnel status."""
    tunnel = TunnelStatus()

    r = run_ssh(
        "ip addr show tun0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1",
        timeout=5,
    )
    if r.ok and r.stdout:
        tunnel.up = True
        tunnel.local_ip = r.stdout.strip()
        # Remote is always .1 if local is .2
        if tunnel.local_ip.endswith(".2"):
            tunnel.remote_ip = tunnel.local_ip[:-1] + "1"

    return tunnel


# --- WiFi Roaming commands ---

def get_roaming_status() -> RoamingStatus:
    """Get WiFi roaming status."""
    status = RoamingStatus()

    r = run_ssh("/opt/wifi-roaming.sh status", timeout=15)
    if not r.ok:
        return status

    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("Interface:"):
            status.interface = line.split(":", 1)[1].strip().split(" ")[0]
        elif line.startswith("Status: Connected"):
            status.connected = True
            # "Status: Connected to SSID (-XXdBm)"
            parts = line.split("Connected to ", 1)
            if len(parts) > 1:
                rest = parts[1]
                # Extract SSID and signal
                paren = rest.rfind("(")
                if paren > 0:
                    status.ssid = rest[:paren].strip()
                    sig = rest[paren + 1:].rstrip(")")
                    try:
                        status.signal_dbm = int(sig.split()[0])
                    except (ValueError, IndexError):
                        pass
                else:
                    status.ssid = rest.strip()
        elif line.startswith("IP:"):
            status.ip = line.split(":", 1)[1].strip()

    # Check daemon status
    r2 = run_ssh("pgrep -f 'wifi-roaming.sh daemon' >/dev/null 2>&1 && echo running", timeout=5)
    status.daemon_running = r2.ok and "running" in r2.stdout

    return status


def scan_wifi() -> list[WifiNetwork]:
    """Scan for available WiFi networks on wan4."""
    r = run_ssh("/opt/wifi-roaming.sh scan", timeout=30)
    if not r.ok:
        return []

    networks = []
    known = {n.ssid for n in get_known_networks()}

    for line in r.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("Scanning"):
            continue
        # Format from wifi-roaming.sh: "-XX dBm\tSSID"
        parts = line.split("\t", 1)
        if len(parts) == 2:
            signal_str, ssid = parts
            ssid = ssid.strip()
            if not ssid:
                continue
            try:
                dbm = int(float(signal_str.strip().split()[0]))
            except (ValueError, IndexError):
                dbm = -100
            networks.append(WifiNetwork(
                ssid=ssid,
                signal_dbm=dbm,
                known=ssid in known,
            ))

    return networks


def connect_wifi(ssid: str) -> CommandResult:
    """Connect to a known WiFi network."""
    err = validate_ssid(ssid)
    if err:
        return CommandResult(stderr=err, returncode=1)

    with _write_lock:
        return run_ssh(f"/opt/wifi-roaming.sh connect '{shell_escape(ssid)}'", timeout=20)


def disconnect_wifi() -> CommandResult:
    """Disconnect from current WiFi network."""
    with _write_lock:
        return run_ssh("/opt/wifi-roaming.sh disconnect", timeout=10)


# --- Known networks CRUD ---

def get_known_networks() -> list[KnownNetwork]:
    """Read known networks from wifi-roaming.conf."""
    r = run_ssh("cat /etc/wifi-roaming.conf", timeout=5)
    if not r.ok:
        return []

    networks = []
    for line in r.stdout.splitlines():
        line = line.strip().replace("\r", "")
        if not line or line.startswith("#"):
            continue
        parts = line.split("|")
        if len(parts) >= 3:
            try:
                priority = int(parts[2])
            except ValueError:
                priority = 10
            autoconnect = True
            if len(parts) >= 4:
                autoconnect = parts[3].strip().lower() != "manual"
            networks.append(KnownNetwork(
                ssid=parts[0],
                key=parts[1],
                priority=priority,
                autoconnect=autoconnect,
            ))

    return networks


def _auto_flag(autoconnect: bool) -> str:
    return "auto" if autoconnect else "manual"


def add_known_network(ssid: str, key: str, priority: int, autoconnect: bool = True) -> CommandResult:
    """Add a network to wifi-roaming.conf."""
    err = validate_ssid(ssid)
    if err:
        return CommandResult(stderr=err, returncode=1)
    err = validate_priority(priority)
    if err:
        return CommandResult(stderr=err, returncode=1)
    if "|" in key or "\n" in key:
        return CommandResult(stderr="Password cannot contain pipe (|) or newline", returncode=1)

    safe_ssid = shell_escape(ssid)
    safe_key = shell_escape(key)
    flag = _auto_flag(autoconnect)

    with _write_lock:
        # Check for duplicate
        existing = get_known_networks()
        for n in existing:
            if n.ssid == ssid:
                return CommandResult(stderr=f"Network '{ssid}' already exists", returncode=1)

        return run_ssh(
            f"mount -o remount,rw / 2>/dev/null; "
            f"echo '{safe_ssid}|{safe_key}|{priority}|{flag}' >> /etc/wifi-roaming.conf",
            timeout=10,
        )


def update_known_network(ssid: str, key: str, priority: int, autoconnect: bool = True) -> CommandResult:
    """Update a network in wifi-roaming.conf."""
    err = validate_ssid(ssid)
    if err:
        return CommandResult(stderr=err, returncode=1)
    err = validate_priority(priority)
    if err:
        return CommandResult(stderr=err, returncode=1)
    if "|" in key or "\n" in key:
        return CommandResult(stderr="Password cannot contain pipe (|) or newline", returncode=1)

    safe_ssid = shell_escape(ssid)
    safe_key = shell_escape(key)
    flag = _auto_flag(autoconnect)

    with _write_lock:
        return run_ssh(
            f"mount -o remount,rw / 2>/dev/null; "
            f"sed -i '/^{safe_ssid}|/c\\{safe_ssid}|{safe_key}|{priority}|{flag}' /etc/wifi-roaming.conf",
            timeout=10,
        )


def delete_known_network(ssid: str) -> CommandResult:
    """Remove a network from wifi-roaming.conf."""
    err = validate_ssid(ssid)
    if err:
        return CommandResult(stderr=err, returncode=1)

    safe_ssid = shell_escape(ssid)

    with _write_lock:
        return run_ssh(
            f"mount -o remount,rw / 2>/dev/null; "
            f"sed -i '/^{safe_ssid}|/d' /etc/wifi-roaming.conf",
            timeout=10,
        )


def connect_and_add_network(ssid: str, key: str, priority: int, autoconnect: bool = True) -> CommandResult:
    """Add a network to config, connect to it, and rollback on failure."""
    add_result = add_known_network(ssid, key, priority, autoconnect)
    if not add_result.ok:
        return add_result

    connect_result = connect_wifi(ssid)

    # Wait and verify connection
    time.sleep(7)
    r = run_ssh(
        "/opt/wifi-roaming.sh status 2>/dev/null | grep -q 'Connected to'",
        timeout=10,
    )
    if r.ok:
        return CommandResult(stdout=f"Connected to {ssid} and added to known networks")

    # Connection failed — rollback: delete from config
    delete_known_network(ssid)
    stderr = connect_result.stderr or "Connection failed"
    return CommandResult(stderr=f"Connection to {ssid} failed, removed from config. {stderr}", returncode=1)


# --- WAN & Service commands ---

def restart_wan(wan_name: str) -> CommandResult:
    """Restart a WAN interface."""
    if wan_name not in ("wan1", "wan2", "wan3", "wan4"):
        return CommandResult(stderr=f"Invalid WAN: {wan_name}", returncode=1)

    with _write_lock:
        return run_ssh(f"ifdown {wan_name} && sleep 2 && ifup {wan_name}", timeout=30)


def get_services_status() -> list[ServiceStatus]:
    """Get status of key services."""
    services = []
    for name in ("novnc", "wifi-roaming", "power-monitor"):
        r = run_ssh(f"service {name} status 2>/dev/null | grep -q running && echo yes", timeout=5)
        services.append(ServiceStatus(name=name, running=r.ok and "yes" in r.stdout))
    return services


def restart_service(name: str) -> CommandResult:
    """Restart a service."""
    allowed = ("novnc", "wifi-roaming", "power-monitor")
    if name not in allowed:
        return CommandResult(stderr=f"Unknown service: {name}", returncode=1)

    return run_ssh(f"service {name} restart", timeout=15)
