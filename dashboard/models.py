"""Data models for the seamless-wan dashboard API responses."""

import json
from dataclasses import dataclass, field, asdict


@dataclass
class CommandResult:
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@dataclass
class WANStatus:
    name: str = ""        # wan1, wan2, wan3, wan4
    interface: str = ""   # usb0, phy1-sta0, etc.
    device_type: str = "" # usb_tethering, wifi, wifi_roaming
    ip: str = ""
    up: bool = False      # OMR tracker state (real connectivity to VPS)
    link: bool = False    # interface has IP or link is up (local)
    ssid: str = ""        # connected SSID (wifi/roaming only)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TunnelStatus:
    up: bool = False
    local_ip: str = ""
    remote_ip: str = ""
    interface: str = "tun0"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SystemStatus:
    uptime: str = ""
    public_ip: str = ""
    temp_celsius: int = 0
    throttled: str = "0x0"
    throttled_ok: bool = True
    power_issues: list = None   # decoded throttle flags
    usb_errors: int = 0         # USB error count from dmesg

    def __post_init__(self):
        if self.power_issues is None:
            self.power_issues = []

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WifiNetwork:
    ssid: str = ""
    signal_dbm: int = 0
    known: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class KnownNetwork:
    ssid: str = ""
    key: str = ""
    priority: int = 10
    autoconnect: bool = True

    def to_dict(self) -> dict:
        d = asdict(self)
        d["key_display"] = "open" if self.key == "open" else "****"
        return d


@dataclass
class RoamingStatus:
    interface: str = ""
    connected: bool = False
    ssid: str = ""
    signal_dbm: int = 0
    ip: str = ""
    daemon_running: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ServiceStatus:
    name: str = ""
    running: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def api_success(data: dict | list) -> str:
    return json.dumps({"ok": True, "data": data})


def api_error(message: str, status: int = 500) -> str:
    return json.dumps({"ok": False, "error": message, "status": status})
