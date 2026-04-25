"""SSH command execution wrapper for communicating with the OMR host."""

import os
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

# ControlMaster path — first call opens a multiplexed connection,
# subsequent calls reuse it (no TCP handshake / key exchange overhead).
_SSH_CTL_DIR = "/tmp/dashboard-ssh"
os.makedirs(_SSH_CTL_DIR, exist_ok=True)
SSH_OPTS = [
    "-i", SSH_KEY,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", f"ControlPath={_SSH_CTL_DIR}/%C",
    "-o", "ControlPersist=60s",
]

# Global lock for write operations (UCI, config file)
_write_lock = threading.Lock()

# In-memory TTL cache: key -> (expiry, value)
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def cached(key: str, ttl: float, fetch):
    """Return cached value if fresh, otherwise fetch and store."""
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > now:
            return entry[1]
    value = fetch()
    with _cache_lock:
        _cache[key] = (now + ttl, value)
    return value


def cache_set(key: str, value, ttl: float) -> None:
    """Store a value in the cache (used by background refreshers)."""
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)


def cache_get(key: str, default=None):
    """Return cached value if fresh, else default. Does not fetch."""
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.time():
            return entry[1]
    return default

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

# RPi throttle flag bits → human-readable labels
_THROTTLE_FLAGS = {
    0:  "Under-voltage detected",
    1:  "Arm frequency capped",
    2:  "Currently throttled",
    3:  "Soft temperature limit active",
    16: "Under-voltage has occurred",
    17: "Arm frequency capping has occurred",
    18: "Throttling has occurred",
    19: "Soft temperature limit has occurred",
}


def _decode_throttle(hex_str: str) -> list[str]:
    """Decode vcgencmd throttle hex into human-readable issues."""
    try:
        val = int(hex_str, 16)
    except ValueError:
        return []
    return [label for bit, label in _THROTTLE_FLAGS.items() if val & (1 << bit)]


def get_system_status() -> SystemStatus:
    """Get system status (uptime, temp, throttling, USB errors, public IP)."""
    status = SystemStatus()

    # Single SSH call for local system info (fast)
    r = run_ssh(
        "echo \"UP=$(uptime | sed 's/.*up //' | sed 's/,.*load.*//')\";"
        "echo \"TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\";"
        "echo \"THROT=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)\";"
        "echo \"USBERR=$(dmesg 2>/dev/null | grep -ciE 'over.?current|under.?volt|power.?supply')\"",
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
                status.power_issues = _decode_throttle(status.throttled)
            elif line.startswith("USBERR="):
                try:
                    status.usb_errors = int(line[7:].strip())
                except ValueError:
                    pass

    # Public IP comes from background refresher (see start_background_refreshers).
    # Falls back to "" if not yet fetched, never blocks the status call.
    status.public_ip = cache_get("public_ip", default="") or ""

    return status


def _refresh_public_ip() -> str:
    """Background fetch of the system's public IP (slow, hits external service)."""
    r = run_ssh("curl -s --max-time 3 ifconfig.me 2>/dev/null", timeout=5)
    return r.stdout.strip() if r.ok and r.stdout else ""


_refresher_thread: threading.Thread | None = None


def start_background_refreshers() -> None:
    """Start background threads that periodically refresh slow data."""
    global _refresher_thread
    if _refresher_thread and _refresher_thread.is_alive():
        return

    def loop():
        while True:
            try:
                cache_set("public_ip", _refresh_public_ip(), ttl=180)
            except Exception:
                pass
            try:
                cache_set("wan_public_ips", _refresh_wan_public_ips(), ttl=300)
            except Exception:
                pass
            time.sleep(60)

    _refresher_thread = threading.Thread(target=loop, daemon=True)
    _refresher_thread.start()


def get_wan_status() -> list[WANStatus]:
    """Get status of all WAN interfaces dynamically from UCI."""
    # Single SSH call: discover WANs, get device/type, check IP, link & OMR state
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
            # Get IP and link state
            ip=""
            link="no"
            if [ -n "$dev" ]; then
                ip=$(ip addr show dev "$dev" 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
                if [ -n "$ip" ]; then
                    link="yes"
                elif ip link show "$dev" 2>/dev/null | grep -q UP; then
                    link="yes"
                fi
            fi
            # OMR tracker state = real connectivity (can reach VPS)
            omr_state=$(uci get openmptcprouter.$iface.state 2>/dev/null)
            if [ "$omr_state" = "up" ]; then
                up="yes"
            else
                up="no"
            fi
            # Get connected SSID for wifi interfaces
            ssid=""
            case "$dtype" in
                wifi|wifi_roaming)
                    [ -n "$dev" ] && ssid=$(iw dev "$dev" link 2>/dev/null | awk '/SSID:/{$1=""; print substr($0,2)}')
                    ;;
            esac
            echo "$iface|$dev|$dtype|$ip|$up|$link|$ssid"
        done
        """,
        timeout=15,
    )

    wans = []
    if r.ok:
        for line in r.stdout.splitlines():
            parts = line.strip().split("|")
            if len(parts) >= 6:
                wans.append(WANStatus(
                    name=parts[0],
                    interface=parts[1],
                    device_type=parts[2],
                    ip=parts[3],
                    up=parts[4] == "yes",
                    link=parts[5] == "yes",
                    ssid=parts[6] if len(parts) >= 7 else "",
                ))

    return wans


def _refresh_wan_public_ips() -> dict[str, dict]:
    """Background fetch of public IPs + ISPs for each WAN."""
    r = run_ssh(
        r"""
        for iface in $(uci show network 2>/dev/null | grep '=interface' | cut -d. -f2 | cut -d= -f1 | grep '^wan'); do
            pip=$(uci get openmptcprouter.$iface.publicip 2>/dev/null)
            if [ -n "$pip" ]; then
                isp=$(curl -s --max-time 3 "http://ip-api.com/line/$pip?fields=isp" 2>/dev/null)
                echo "$iface|$pip|$isp"
            fi
        done
        """,
        timeout=15,
    )
    result = {}
    if r.ok:
        for line in r.stdout.splitlines():
            parts = line.strip().split("|")
            if len(parts) >= 2 and parts[1]:
                result[parts[0]] = {
                    "ip": parts[1],
                    "isp": parts[2] if len(parts) >= 3 else "",
                }
    return result


def get_lan_status() -> dict:
    """Return LAN networks (eth0, wifi AP) and their connected clients.

    Output: {"networks": [{"name", "device", "subnet", "ssid", "clients": [...]}]}
    Client: {"mac", "ip", "hostname", "expires", "signal", "iface"}
    """
    r = run_ssh(
        r"""
        echo '#NETWORKS'
        # Discover lan-like interfaces (anything not wan*) that have an ipv4 addr
        for iface in $(uci show network 2>/dev/null | grep '=interface' | cut -d. -f2 | cut -d= -f1 | grep -v '^wan' | grep -v '^loopback' | grep -v '^omr'); do
            dev=$(uci get network.$iface.device 2>/dev/null)
            [ -z "$dev" ] && dev=$(ubus call network.interface.$iface status 2>/dev/null | jsonfilter -e '@.l3_device')
            [ -z "$dev" ] && continue
            ip=$(ip -4 addr show "$dev" 2>/dev/null | awk '/inet /{print $2; exit}')
            [ -z "$ip" ] && continue
            ssid=""
            case "$dev" in
                phy*-ap*)
                    # Find the SSID for this AP interface via UCI by scanning wifi-iface entries
                    for w in $(uci show wireless 2>/dev/null | grep "=wifi-iface" | cut -d. -f2 | cut -d= -f1); do
                        net=$(uci get wireless.$w.network 2>/dev/null)
                        [ "$net" = "$iface" ] && ssid=$(uci get wireless.$w.ssid 2>/dev/null) && break
                    done
                    ;;
            esac
            echo "$iface|$dev|$ip|$ssid"
        done

        echo '#LEASES'
        cat /tmp/dhcp.leases 2>/dev/null

        echo '#WIFI_STATIONS'
        for ifname in $(ls /sys/class/net 2>/dev/null | grep '\-ap'); do
            iw dev "$ifname" station dump 2>/dev/null | awk -v i="$ifname" '
                /^Station/ {mac=$2; signal="";  conn=""}
                /signal:/ {signal=$2}
                /connected time:/ {conn=$3}
                /tx bytes:/ {print i"|"mac"|"signal"|"conn}
            '
        done

        echo '#NEIGH'
        ip neigh show 2>/dev/null
        """,
        timeout=10,
    )

    networks = []
    leases_by_mac: dict[str, dict] = {}
    wifi_stations: list[dict] = []
    neigh: list[dict] = []

    if r.ok:
        section = None
        for line in r.stdout.splitlines():
            line = line.rstrip()
            if not line:
                continue
            if line == "#NETWORKS":
                section = "networks"
                continue
            if line == "#LEASES":
                section = "leases"
                continue
            if line == "#WIFI_STATIONS":
                section = "wifi"
                continue
            if line == "#NEIGH":
                section = "neigh"
                continue

            if section == "networks":
                parts = line.split("|")
                if len(parts) >= 3:
                    networks.append({
                        "name": parts[0],
                        "device": parts[1],
                        "subnet": parts[2],
                        "ssid": parts[3] if len(parts) > 3 else "",
                        "clients": [],
                    })
            elif section == "leases":
                parts = line.split()
                if len(parts) >= 4:
                    leases_by_mac[parts[1].lower()] = {
                        "expires": int(parts[0]) if parts[0].isdigit() else 0,
                        "mac": parts[1].lower(),
                        "ip": parts[2],
                        "hostname": parts[3] if parts[3] != "*" else "",
                    }
            elif section == "wifi":
                parts = line.split("|")
                if len(parts) >= 4:
                    wifi_stations.append({
                        "iface": parts[0],
                        "mac": parts[1].lower(),
                        "signal": parts[2],
                        "connected_seconds": int(parts[3]) if parts[3].isdigit() else 0,
                    })
            elif section == "neigh":
                # "192.168.100.42 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
                parts = line.split()
                if len(parts) >= 5 and "lladdr" in parts:
                    idx = parts.index("lladdr")
                    if idx + 1 < len(parts):
                        ip_addr = parts[0]
                        dev = parts[2] if len(parts) > 2 and parts[1] == "dev" else ""
                        state = parts[-1]
                        neigh.append({
                            "ip": ip_addr,
                            "dev": dev,
                            "mac": parts[idx + 1].lower(),
                            "state": state,
                        })

    # Helper: figure out which network a device belongs to
    def network_for_device(dev: str) -> dict | None:
        for n in networks:
            if n["device"] == dev:
                return n
        return None

    # 1) Add DHCP leases as clients (preferred — has hostname)
    seen_macs: dict[tuple[str, str], dict] = {}  # (network_name, mac) -> client
    for n in neigh:
        if n["state"] in ("FAILED", "INCOMPLETE"):
            continue
        net = network_for_device(n["dev"])
        if net is None:
            continue
        lease = leases_by_mac.get(n["mac"])
        client = {
            "mac": n["mac"],
            "ip": n["ip"],
            "hostname": lease["hostname"] if lease else "",
            "expires": lease["expires"] if lease else 0,
            "iface": n["dev"],
            "signal": "",
            "connected_seconds": 0,
        }
        # Merge wifi station info if present
        for s in wifi_stations:
            if s["mac"] == n["mac"] and s["iface"] == n["dev"]:
                client["signal"] = s["signal"]
                client["connected_seconds"] = s["connected_seconds"]
                break
        seen_macs[(net["name"], n["mac"])] = client
        net["clients"].append(client)

    # 2) Add WiFi stations not already in neigh (might be in different state)
    for s in wifi_stations:
        net = network_for_device(s["iface"])
        if net is None:
            continue
        if (net["name"], s["mac"]) in seen_macs:
            continue
        lease = leases_by_mac.get(s["mac"])
        net["clients"].append({
            "mac": s["mac"],
            "ip": lease["ip"] if lease else "",
            "hostname": lease["hostname"] if lease else "",
            "expires": lease["expires"] if lease else 0,
            "iface": s["iface"],
            "signal": s["signal"],
            "connected_seconds": s["connected_seconds"],
        })

    # Sort clients by IP for stable display
    for n in networks:
        n["clients"].sort(key=lambda c: tuple(int(x) if x.isdigit() else 0 for x in c["ip"].split(".")) if c["ip"] else (999,))

    return {"networks": networks}


def get_wan_probes() -> dict:
    """Return wan-monitor probe status from /tmp/wan-monitor.json on the host."""
    r = run_ssh("cat /tmp/wan-monitor.json 2>/dev/null", timeout=5)
    if not r.ok or not r.stdout:
        return {"timestamp": 0, "wans": []}
    try:
        import json as _j
        return _j.loads(r.stdout)
    except (ValueError, TypeError):
        return {"timestamp": 0, "wans": []}


def trigger_captive_firefox() -> CommandResult:
    """Launch the captive-portal Firefox on the host (in the chroot)."""
    return run_ssh(
        "chroot /mnt/data /usr/local/bin/captive-firefox >/dev/null 2>&1 &",
        timeout=5,
    )


def get_wan_public_ips() -> dict[str, dict]:
    """Return cached public IPs/ISPs. Refreshed in the background."""
    cached_val = cache_get("wan_public_ips")
    if cached_val is not None:
        return cached_val
    # First call before the background refresher has run — fetch synchronously
    # but with a tight cap so it never blocks the UI for long.
    val = _refresh_wan_public_ips()
    cache_set("wan_public_ips", val, ttl=300)
    return val


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
