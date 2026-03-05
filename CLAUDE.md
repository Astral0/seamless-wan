# seamless-wan

## Project Context
This is the open-source GitHub project for "Zero Coupure" — a mobile multi-WAN toolkit for OpenMPTCProuter on Raspberry Pi 4.

## Related Memory
Full project knowledge is maintained in Claude's auto-memory:
- **Project state & architecture**: See `C:\Users\Astral\.claude\projects\C--Users-Astral\memory\zero-coupure.md`
- **Full reinstall procedure**: See `C:\Users\Astral\.claude\projects\C--Users-Astral\memory\zero-coupure-reinstall.md`

Always consult these files for detailed technical knowledge about the RPi setup, VPS config, UCI commands, WiFi hardware, etc.

## Language
- Code and documentation: English
- User communication: French (user preference)

## Architecture Overview
- **Hardware**: RPi 4 (4GB) + powered USB hub + 2 WiFi dongles (AR9271 AP + MT7601U roaming) + 2 phones (USB tethering)
- **Base OS**: OpenMPTCProuter v0.63 (OpenWrt-based, ext4 image, apk packages)
- **VPS**: Debian 12 LXC on sceaux.alneos.com (Glorytun TCP tunnel)
- **Chroot**: Alpine Linux on partition 3 (noVNC + Claude Code + web dashboard)
- **WAN**: 4 WANs aggregated via MPTCP (2x USB tethering + 2x WiFi client)

## Repository Structure (planned)
```
seamless-wan/
  README.md              — Project overview and features
  LICENSE                — MIT
  docs/                  — Detailed documentation
    install.md           — Step-by-step install guide (from zero-coupure-reinstall.md)
    architecture.md      — Network architecture diagrams
    hardware.md          — Bill of materials and USB topology
  scripts/
    wifi-roaming.sh      — WiFi roaming daemon (scan + manual connect)
    power-monitor.sh     — Power/USB monitoring with LED alerts
    start-novnc.sh       — noVNC launcher (chroot)
    alpine-enter.sh      — Alpine chroot entry script
    captive-firefox      — Captive portal browser launcher
  config/
    hotplug/             — OpenWrt hotplug scripts
    init.d/              — procd init scripts
    uci/                 — UCI config snippets
  dashboard/             — Web dashboard (Python backend + vanilla HTML/JS/CSS)
  claude/
    CLAUDE.md            — CLAUDE.md for embedded Claude Code on RPi
    skills/              — Claude Code slash command skills (/omr-*)
```

## Development Notes
- Scripts run on OpenWrt (ash shell, no bash) — avoid bashisms
- UCI is the config system — always `uci set/commit/apply`
- RPi filesystem can go read-only — `mount -o remount,rw /` before writes
- WiFi interface names (phyX) change on reboot — detect dynamically via radio path
- Test on actual hardware (RPi 4 + OpenMPTCProuter)
