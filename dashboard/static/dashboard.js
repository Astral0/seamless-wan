/* seamless-wan dashboard — dashboard.js */

let pollTimer = null;
let throughputTimer = null;
let editingSsid = null; // null = adding, string = editing
let connectAndAdd = false; // true when connecting from scan results
let wanPublicIps = {}; // cached public IPs per WAN
let lastWanIps = {}; // track internal IPs to detect changes
let wanProbes = {}; // wan-monitor probe results: name -> {status, failures, ...}
let prevThroughput = null; // last /proc/net/dev snapshot
const TP_HISTORY_SIZE = 60; // 60 samples * 2s = 2 min window
const tpHistory = {}; // name -> [{rx_bps, tx_bps}, ...]
const tpVisible = {}; // name -> bool (default: visible if classified)
const TP_COLORS = [
    "#2563eb", // blue
    "#dc2626", // red
    "#059669", // green
    "#d97706", // amber
    "#7c3aed", // violet
    "#0891b2", // cyan
    "#db2777", // pink
    "#65a30d", // lime
];

// --- API Client ---

async function api(method, path, body) {
    const opts = {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
    };
    if (body !== undefined) {
        opts.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;

    try {
        const resp = await fetch(path, opts);
        clearTimeout(timeout);
        if (resp.status === 401) {
            showLogin();
            return null;
        }
        return await resp.json();
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
            return { ok: false, error: "Request timed out" };
        }
        return { ok: false, error: err.message };
    }
}

// --- Auth ---

async function doLogin() {
    const user = document.getElementById("login-user").value;
    const pass = document.getElementById("login-pass").value;
    const errEl = document.getElementById("login-error");
    errEl.textContent = "";

    const resp = await api("POST", "/api/login", { username: user, password: pass });
    if (resp && resp.ok) {
        showDashboard();
    } else {
        errEl.textContent = (resp && resp.error) || "Login failed";
    }
}

function doLogout() {
    document.cookie = "session=; Path=/; Max-Age=0";
    showLogin();
}

function showLogin() {
    document.getElementById("login-screen").style.display = "";
    document.getElementById("dashboard").style.display = "none";
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (throughputTimer) { clearInterval(throughputTimer); throughputTimer = null; }
}

function showDashboard() {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("dashboard").style.display = "";
    updateQuickLinks();
    pollStatus();
    loadKnownNetworks();
    loadServices();
    pollThroughput();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 5000);
    if (throughputTimer) clearInterval(throughputTimer);
    throughputTimer = setInterval(pollThroughput, 2000);
}

// Enter key on login form
document.getElementById("login-pass").addEventListener("keydown", function(e) {
    if (e.key === "Enter") doLogin();
});

// --- Status Polling ---

async function pollStatus() {
    const dot = document.getElementById("refresh-dot");
    dot.style.background = "#3b82f6";

    const resp = await api("GET", "/api/status");
    if (!resp || !resp.ok) {
        dot.style.background = "#ef4444";
        return;
    }

    const d = resp.data;

    // System
    document.getElementById("sys-uptime").textContent = d.system.uptime || "--";
    document.getElementById("sys-ip").textContent = d.system.public_ip || "--";
    // Temperature with color
    const tempEl = document.getElementById("sys-temp");
    if (d.system.temp_celsius) {
        const t = d.system.temp_celsius;
        const cls = t > 80 ? "badge-down" : t > 70 ? "badge-warn" : "badge-up";
        tempEl.innerHTML = `<span class="badge ${cls}">${t}\u00B0C</span>`;
    } else {
        tempEl.textContent = "--";
    }

    // Power: decoded throttle flags + USB errors
    const powerEl = document.getElementById("sys-power");
    const issues = d.system.power_issues || [];
    const usbErr = d.system.usb_errors || 0;
    if (issues.length === 0 && usbErr === 0) {
        powerEl.innerHTML = '<span class="badge badge-up">OK</span>';
    } else {
        let html = "";
        if (issues.length > 0) {
            const cls = issues.some(i => !i.includes("has occurred")) ? "badge-down" : "badge-warn";
            html += `<span class="badge ${cls}" title="${issues.join('\n')}">\u26A0 ${issues.length} alert${issues.length > 1 ? "s" : ""}</span>`;
        }
        if (usbErr > 0) {
            html += ` <span class="badge badge-warn" title="USB errors in dmesg">USB \u00D7${usbErr}</span>`;
        }
        powerEl.innerHTML = html;
    }

    // Tunnel WANs count: UP vs active (link up), ignore inactive WANs
    const wansUp = d.wans.filter(w => w.up).length;
    const wansActive = d.wans.filter(w => w.link).length;
    const twEl = document.getElementById("sys-tunnel-wans");
    if (wansActive === 0) {
        twEl.innerHTML = '<span class="badge badge-down">0</span>';
    } else {
        const twCls = wansUp === wansActive ? "badge-up" : wansUp === 0 ? "badge-down" : "badge-warn";
        twEl.innerHTML = `<span class="badge ${twCls}">${wansUp} / ${wansActive}</span>`;
    }

    // WANs — detect IP changes to refresh public IPs
    const curWanIps = {};
    d.wans.forEach(w => { if (w.ip) curWanIps[w.name] = w.ip; });
    let ipChanged = false;
    for (const [name, ip] of Object.entries(curWanIps)) {
        if (lastWanIps[name] !== ip) { ipChanged = true; break; }
    }
    for (const name of Object.keys(lastWanIps)) {
        if (!curWanIps[name]) { ipChanged = true; delete wanPublicIps[name]; break; }
    }
    lastWanIps = curWanIps;

    renderWans(d.wans);

    if (ipChanged) loadWanPublicIps();
    loadWanProbes();
    loadLan();
    loadAlerts();

    // Tunnel
    renderTunnel(d.tunnel);

    dot.style.background = "#22c55e";
}

// Display roles for throughput interfaces. Order matters (rendered top-down).
// Names are matched by prefix so phyN-staX / phyN-apX both work.
const TP_ROLES = [
    { match: n => n === "tun0",                label: "Tunnel",     group: "tunnel" },
    { match: n => n.startsWith("usb"),         label: "WAN (USB)",  group: "wan" },
    { match: n => /^phy\d+-sta/.test(n),       label: "WAN (WiFi)", group: "wan" },
    { match: n => /^phy\d+-ap/.test(n),        label: "AP (WiFi)",  group: "lan" },
    { match: n => n === "eth0",                label: "LAN (eth0)", group: "lan" },
];

function classifyInterface(name) {
    for (const r of TP_ROLES) {
        if (r.match(name)) return r;
    }
    return null;
}

function formatRate(bps) {
    if (!bps || bps < 1) return "0 b/s";
    const units = ["b/s", "Kb/s", "Mb/s", "Gb/s"];
    let v = bps, i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return v >= 100 ? `${v.toFixed(0)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

// Mirror chart: RX above the X axis (top half), TX below (bottom half).
// Each visible interface gets its own colored line for both RX and TX.
function mirrorChart(visibleSeries, height) {
    const W = 800, H = height || 240;
    const MID = H / 2;
    if (!visibleSeries || visibleSeries.length === 0) {
        return `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
            style="background:#fafaf9;border-radius:6px"></svg>`;
    }

    // Find the global max across all visible series for both RX and TX
    let maxRx = 1, maxTx = 1;
    visibleSeries.forEach(s => {
        s.hist.forEach(p => {
            if (p.rx_bps > maxRx) maxRx = p.rx_bps;
            if (p.tx_bps > maxTx) maxTx = p.tx_bps;
        });
    });
    const step = W / (TP_HISTORY_SIZE - 1);

    const seriesPaths = (hist, accessor, max, isTx, color) => {
        const padded = Array(TP_HISTORY_SIZE - hist.length).fill(0).concat(hist.map(accessor));
        const pts = padded.map((v, i) => {
            const x = (i * step).toFixed(1);
            const offset = (v / max) * (MID - 4);
            const y = isTx ? (MID + offset).toFixed(1) : (MID - offset).toFixed(1);
            return { x, y };
        });
        const lineD = "M" + pts.map(p => `${p.x},${p.y}`).join(" L");
        const fillD = `M0,${MID} L${pts.map(p => `${p.x},${p.y}`).join(" L")} L${W},${MID} Z`;
        return `<path d="${fillD}" fill="${color}" fill-opacity="0.18" />
                <path d="${lineD}" fill="none" stroke="${color}" stroke-width="1.6" />`;
    };

    const lines = visibleSeries.map(s => `
        ${seriesPaths(s.hist, p => p.rx_bps, maxRx, false, s.color)}
        ${seriesPaths(s.hist, p => p.tx_bps, maxTx, true,  s.color)}
    `).join("");

    return `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
            style="display:block;background:#fafaf9;border-radius:6px">
        <line x1="0" y1="${MID}" x2="${W}" y2="${MID}" stroke="#d1d5db" stroke-width="1" />
        <text x="6" y="14"          font-size="11" font-family="monospace" fill="#6b7280">↓ ${formatRate(maxRx)}</text>
        <text x="6" y="${MID - 4}"  font-size="11" font-family="monospace" fill="#6b7280">0</text>
        <text x="6" y="${MID + 14}" font-size="11" font-family="monospace" fill="#6b7280">0</text>
        <text x="6" y="${H - 6}"    font-size="11" font-family="monospace" fill="#6b7280">↑ ${formatRate(maxTx)}</text>
        ${lines}
    </svg>`;
}

function toggleSeries(name) {
    tpVisible[name] = !tpVisible[name];
    renderThroughput(prevThroughput ? prevThroughput.interfaces : {});
}

async function pollThroughput() {
    const resp = await api("GET", "/api/throughput");
    if (!resp || !resp.ok || !resp.data) return;
    const data = resp.data;

    if (prevThroughput) {
        const dt = (data.timestamp_ms - prevThroughput.timestamp_ms) / 1000;
        if (dt > 0.1) {
            for (const [name, cur] of Object.entries(data.interfaces)) {
                const prev = prevThroughput.interfaces[name];
                if (!prev) continue;
                const rx_bps = Math.max(0, ((cur.rx_bytes - prev.rx_bytes) * 8) / dt);
                const tx_bps = Math.max(0, ((cur.tx_bytes - prev.tx_bytes) * 8) / dt);
                if (!tpHistory[name]) tpHistory[name] = [];
                tpHistory[name].push({ rx_bps, tx_bps });
                if (tpHistory[name].length > TP_HISTORY_SIZE) {
                    tpHistory[name].shift();
                }
            }
            renderThroughput(data.interfaces);
        }
    }
    prevThroughput = data;
}

// Latest non-zero sample over the visible window — used for the headline rates.
function latestSample(hist) {
    if (!hist || hist.length === 0) return { rx_bps: 0, tx_bps: 0 };
    return hist[hist.length - 1];
}

// Sum a list of histories sample-by-sample (right-aligned) for a group total.
function sumHistories(histories) {
    const len = TP_HISTORY_SIZE;
    const result = [];
    for (let i = 0; i < len; i++) {
        let rx = 0, tx = 0;
        histories.forEach(h => {
            const idx = h.length - len + i;
            if (idx >= 0) { rx += h[idx].rx_bps; tx += h[idx].tx_bps; }
        });
        result.push({ rx_bps: rx, tx_bps: tx });
    }
    return result;
}

function renderThroughput(interfaces) {
    const grid = document.getElementById("throughput-grid");
    if (!grid) return;

    // Build the series list. Order: tunnel, WAN total, each WAN, LAN/AP.
    const groups = { wan: [], tunnel: [], lan: [] };
    for (const name of Object.keys(interfaces || {})) {
        const role = classifyInterface(name);
        if (!role) continue;
        groups[role.group].push({ name, role, hist: tpHistory[name] || [] });
    }

    const series = [];
    if (groups.tunnel.length > 0) {
        const t = groups.tunnel[0];
        series.push({ key: t.name, label: "Tunnel", sublabel: t.name, hist: t.hist });
    }
    if (groups.wan.length > 1) {
        series.push({
            key: "__wan_total",
            label: "WAN total",
            sublabel: `${groups.wan.length} ifs`,
            hist: sumHistories(groups.wan.map(w => w.hist)),
        });
    }
    groups.wan.forEach(w => series.push({ key: w.name, label: w.role.label, sublabel: w.name, hist: w.hist }));
    groups.lan.forEach(w => series.push({ key: w.name, label: w.role.label, sublabel: w.name, hist: w.hist }));

    // Assign stable colors (idx in series list) and default visibility:
    // Tunnel + WAN total visible, individual interfaces hidden by default.
    series.forEach((s, i) => {
        s.color = TP_COLORS[i % TP_COLORS.length];
        if (tpVisible[s.key] === undefined) {
            tpVisible[s.key] = (s.key === "__wan_total" || s.label === "Tunnel");
        }
    });

    const visibleSeries = series.filter(s => tpVisible[s.key]);
    const chart = mirrorChart(visibleSeries, 240);

    // Toggle buttons + per-series current rate
    const buttons = series.map(s => {
        const last = latestSample(s.hist);
        const on = tpVisible[s.key];
        return `<button onclick="toggleSeries('${s.key}')" style="
            display:inline-flex;align-items:center;gap:6px;
            padding:5px 10px;margin:3px;border:1px solid ${on ? s.color : "var(--border)"};
            background:${on ? s.color + "18" : "#fff"};
            color:${on ? s.color : "var(--text-muted)"};
            border-radius:14px;cursor:pointer;font-size:12px">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                background:${s.color};opacity:${on ? 1 : 0.3}"></span>
            <strong>${s.label}</strong>
            <span style="opacity:0.7;font-family:monospace">↓${formatRate(last.rx_bps)} ↑${formatRate(last.tx_bps)}</span>
        </button>`;
    }).join("");

    grid.innerHTML = `${chart}
        <div style="margin-top:12px;display:flex;flex-wrap:wrap">${buttons}</div>`;
}

function toggleHistory() {
    const list = document.getElementById("history-list");
    const toggle = document.getElementById("history-toggle");
    if (!list) return;
    if (list.style.display === "none") {
        list.style.display = "";
        toggle.textContent = "hide";
        loadHistory();
    } else {
        list.style.display = "none";
        toggle.textContent = "show";
    }
}

async function loadHistory() {
    const resp = await api("GET", "/api/events");
    const list = document.getElementById("history-list");
    if (!list) return;
    if (!resp || !resp.ok || !resp.data) {
        list.innerHTML = '<div class="status-label">Failed to load events.</div>';
        return;
    }
    const events = resp.data.events || [];
    if (events.length === 0) {
        list.innerHTML = '<div class="status-label">No recent events.</div>';
        return;
    }
    const tagColor = {
        "wan-monitor":     "#2563eb",
        "service-monitor": "#7c3aed",
        "captive-firefox": "#d97706",
        "captive-routing": "#0891b2",
        "fix-phy":         "#059669",
    };
    // Most recent first
    list.innerHTML = events.slice().reverse().map(e => {
        const c = tagColor[e.tag] || "#6b7280";
        return `<div style="padding:4px 6px;border-bottom:1px solid var(--border)">
            <span style="color:var(--text-muted)">${e.date}</span>
            <span style="color:${c};font-weight:600;margin-left:6px">${e.tag}</span>
            <span style="margin-left:6px">${escapeHtml(e.message)}</span>
        </div>`;
    }).join("");
}

function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

async function loadAlerts() {
    const resp = await api("GET", "/api/alerts");
    const banner = document.getElementById("alerts-banner");
    if (!banner) return;
    if (!resp || !resp.ok || !resp.data) { banner.style.display = "none"; return; }
    const alerts = resp.data.alerts || [];
    if (alerts.length === 0) { banner.style.display = "none"; banner.innerHTML = ""; return; }

    const sevColor = {
        critical: { bg: "#fee2e2", border: "#dc2626", text: "#991b1b" },
        warning:  { bg: "#fef3c7", border: "#d97706", text: "#92400e" },
        info:     { bg: "#dbeafe", border: "#2563eb", text: "#1e40af" },
    };
    const top = alerts.reduce((s, a) =>
        ({critical:3, warning:2, info:1}[a.severity] > ({critical:3, warning:2, info:1}[s] || 0) ? a.severity : s),
        "info");
    const c = sevColor[top] || sevColor.info;

    banner.style.display = "";
    banner.innerHTML = `<div style="
        background:${c.bg};border-left:4px solid ${c.border};color:${c.text};
        padding:12px 14px;border-radius:6px;font-size:14px">
        <div style="font-weight:600;margin-bottom:6px">
            ${alerts.length} alert${alerts.length > 1 ? "s" : ""}
        </div>
        <ul style="margin:0;padding-left:18px;list-style:disc">
            ${alerts.map(a => `<li style="margin:4px 0">
                <strong>${a.severity.toUpperCase()}</strong> &middot; ${a.message}
                ${actionButton(a)}
            </li>`).join("")}
        </ul>
    </div>`;
}

function actionButton(a) {
    if (!a.action) return "";
    if (a.action === "captive_portal") {
        return ` <button class="btn btn-sm" style="margin-left:6px" onclick="openCaptivePortal()">Open captive portal</button>`;
    }
    if (a.action === "restart_wan") {
        return ` <button class="btn btn-sm" style="margin-left:6px" onclick="restartWan('${a.action_arg}')">Restart ${a.action_arg}</button>`;
    }
    if (a.action === "restart_service") {
        return ` <button class="btn btn-sm" style="margin-left:6px" onclick="restartService('${a.action_arg}')">Restart ${a.action_arg}</button>`;
    }
    return "";
}

async function loadLan() {
    const resp = await api("GET", "/api/lan");
    if (!resp || !resp.ok || !resp.data) return;
    const grid = document.getElementById("lan-grid");
    if (!grid) return;
    const nets = resp.data.networks || [];
    if (nets.length === 0) {
        grid.innerHTML = '<div class="status-label">No LAN networks detected.</div>';
        return;
    }
    const fmtDuration = s => {
        if (!s) return "";
        if (s < 60) return s + "s";
        if (s < 3600) return Math.floor(s / 60) + "m";
        return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
    };
    grid.innerHTML = nets.map(n => {
        const title = n.ssid ? `${n.name} <span style="color:var(--text-muted)">(${n.ssid})</span>` : n.name;
        const rows = (n.clients || []).map(c => {
            const sig = c.signal ? `<span class="badge badge-link" style="margin-left:6px">${c.signal} dBm</span>` : "";
            const conn = c.connected_seconds ? `<span style="color:var(--text-muted);margin-left:6px">${fmtDuration(c.connected_seconds)}</span>` : "";
            const host = c.hostname || '<em style="color:var(--text-muted)">-</em>';
            return `<tr>
                <td>${host}</td>
                <td>${c.ip || "-"}</td>
                <td><code>${c.mac}</code></td>
                <td>${sig}${conn}</td>
            </tr>`;
        }).join("");
        const tableBody = rows || `<tr><td colspan="4" style="color:var(--text-muted)">No clients connected.</td></tr>`;
        return `<div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
                <strong>${title}</strong>
                <span style="color:var(--text-muted);font-size:12px">${n.device} &middot; ${n.subnet} &middot; ${(n.clients||[]).length} client${(n.clients||[]).length !== 1 ? "s" : ""}</span>
            </div>
            <table class="lan-table" style="width:100%;font-size:13px;border-collapse:collapse">
                <thead><tr style="text-align:left;color:var(--text-muted);font-weight:normal;border-bottom:1px solid var(--border)">
                    <th style="padding:4px 8px">Hostname</th><th style="padding:4px 8px">IP</th><th style="padding:4px 8px">MAC</th><th style="padding:4px 8px">Info</th>
                </tr></thead>
                <tbody>${tableBody}</tbody>
            </table>
        </div>`;
    }).join("");
}

async function loadWanProbes() {
    const resp = await api("GET", "/api/wan/probes");
    if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.wans)) return;
    wanProbes = {};
    resp.data.wans.forEach(p => { wanProbes[p.name] = p; });
    // Update probe badges if cards already rendered
    Object.entries(wanProbes).forEach(([name, p]) => {
        const el = document.getElementById("wan-probe-" + name);
        if (el) el.innerHTML = probeBadge(p.status);
        const cap = document.getElementById("wan-captive-" + name);
        if (cap) cap.style.display = p.status === "captive" ? "" : "none";
    });
}

function probeBadge(status) {
    switch (status) {
        case "internet": return '<span class="badge badge-up" title="Probe OK">INTERNET</span>';
        case "captive":  return '<span class="badge badge-warn" title="Captive portal detected">CAPTIVE</span>';
        case "timeout":  return '<span class="badge badge-down" title="No response from probe URL">TIMEOUT</span>';
        case "no_ip":    return '<span class="badge badge-down" title="Interface up but no IP">NO IP</span>';
        case "no_device":return '<span class="badge badge-down" title="Device missing">NO DEV</span>';
        case "unknown":  return '<span class="badge badge-link" title="Probe pending">…</span>';
        default:         return `<span class="badge badge-down" title="Probe error: ${status}">ERR</span>`;
    }
}

async function openCaptivePortal() {
    const resp = await api("POST", "/api/wan/captive", {});
    if (resp && resp.ok) {
        alert("Captive Firefox launched in noVNC. Validate the portal there.");
    } else {
        alert("Failed to launch captive Firefox: " + (resp ? resp.error : "no response"));
    }
}

async function loadWanPublicIps() {
    const resp = await api("GET", "/api/wan/public-ips");
    if (resp && resp.ok) {
        wanPublicIps = resp.data;
        // Update any already-rendered WAN cards
        for (const [name, info] of Object.entries(wanPublicIps)) {
            const pip = typeof info === "string" ? info : info.ip || "";
            const isp = typeof info === "object" ? (info.isp || "") : "";
            const el = document.getElementById("wan-pip-" + name);
            if (el) el.textContent = pip;
            const ispEl = document.getElementById("wan-isp-" + name);
            if (ispEl) {
                ispEl.textContent = isp;
                if (isp) ispEl.parentElement.style.display = "";
            }
        }
    }
}

function renderWans(wans) {
    const grid = document.getElementById("wan-grid");
    const labels = { usb_tethering: "USB Tethering", wifi: "WiFi", wifi_roaming: "WiFi Roaming" };
    grid.innerHTML = wans.map(w => {
        // 3 states: up (green) = OMR routed, link (orange) = interface active but no VPS, down (red)
        let cls, badgeCls, badgeText;
        if (w.up) {
            cls = "up"; badgeCls = "badge-up"; badgeText = "UP";
        } else if (w.link) {
            cls = "link"; badgeCls = "badge-link"; badgeText = "LINK";
        } else {
            cls = "down"; badgeCls = "badge-down"; badgeText = "DOWN";
        }
        const raw = wanPublicIps[w.name];
        const pip = raw ? (typeof raw === "string" ? raw : raw.ip || "") : "";
        const isp = raw && typeof raw === "object" ? (raw.isp || "") : "";
        // Build info rows
        let rows = "";
        if (w.ssid) {
            rows += `<tr><td class="wl">SSID</td><td class="wv">${w.ssid}</td></tr>`;
        }
        if (w.ip) {
            rows += `<tr><td class="wl">IP</td><td class="wv">${w.ip}</td></tr>`;
        }
        if (w.up) {
            rows += `<tr><td class="wl">Ext</td><td class="wv"><span id="wan-pip-${w.name}">${pip || "..."}</span></td></tr>`;
            rows += `<tr><td class="wl">ISP</td><td class="wv"><span id="wan-isp-${w.name}">${isp || "..."}</span></td></tr>`;
        } else {
            rows += `<tr style="display:none"><td></td><td><span id="wan-pip-${w.name}"></span><span id="wan-isp-${w.name}"></span></td></tr>`;
        }
        const probe = wanProbes[w.name];
        const probeHtml = probe ? probeBadge(probe.status) : probeBadge("unknown");
        const isCaptive = probe && probe.status === "captive";
        return `<div class="wan-card ${cls}">
            <div class="wan-header">
                <div>
                    <div class="wan-name">${w.name}</div>
                    <div class="wan-iface">${w.interface || "?"} &middot; ${labels[w.device_type] || w.device_type}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                    <span class="badge ${badgeCls}">${badgeText}</span>
                    <span id="wan-probe-${w.name}">${probeHtml}</span>
                </div>
            </div>
            <table class="wan-info">${rows}</table>
            <div id="wan-captive-${w.name}" style="display:${isCaptive ? "" : "none"};margin-bottom:6px">
                <button class="btn btn-warn btn-sm" onclick="openCaptivePortal()">Open captive portal</button>
            </div>
            <button class="btn btn-outline btn-sm wan-restart" onclick="restartWan('${w.name}')">Restart</button>
        </div>`;
    }).join("");
}

function renderTunnel(t) {
    const el = document.getElementById("tunnel-status");
    const badge = t.up
        ? '<span class="badge badge-up">UP</span>'
        : '<span class="badge badge-down">DOWN</span>';
    el.innerHTML = `
        <div class="status-item">
            <span class="status-label">Glorytun</span>
            <span class="status-value">${badge}</span>
        </div>
        <div class="status-item">
            <span class="status-label">Client</span>
            <span class="status-value">${t.local_ip || "--"}</span>
        </div>
        <div class="status-item">
            <span class="status-label">Server</span>
            <span class="status-value">${t.remote_ip || "--"}</span>
        </div>
    `;
}

// --- WiFi Roaming ---

async function doScan() {
    const btn = document.getElementById("btn-scan");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Scanning...';

    const resp = await api("POST", "/api/roaming/scan");
    btn.disabled = false;
    btn.textContent = "Scan";

    if (!resp || !resp.ok) {
        alert("Scan failed: " + ((resp && resp.error) || "Unknown error"));
        return;
    }

    const list = document.getElementById("scan-list");
    const results = document.getElementById("scan-results");

    if (resp.data.length === 0) {
        list.innerHTML = '<li class="network-item"><span style="color:var(--text-muted)">No networks found</span></li>';
    } else {
        list.innerHTML = resp.data.map(n => {
            const bars = signalBars(n.signal_dbm);
            const knownBadge = n.known ? ' <span style="font-size:11px;color:var(--text-muted)">(known)</span>' : "";
            const connectBtn = n.known
                ? `<button class="btn btn-primary btn-sm" onclick="doConnect('${escHtml(n.ssid)}')">Connect</button>`
                : `<button class="btn btn-primary btn-sm" onclick="showConnectAddModal('${escHtml(n.ssid)}')">Connect</button>`;
            return `<li class="network-item">
                <div class="network-info">
                    ${bars}
                    <span class="network-ssid">${escHtml(n.ssid)}${knownBadge}</span>
                    <span class="network-dbm">${n.signal_dbm} dBm</span>
                </div>
                ${connectBtn}
            </li>`;
        }).join("");
    }
    results.style.display = "";

    // Also refresh roaming status
    loadRoamingStatus();
}

async function doConnect(ssid) {
    if (!confirm("Connect to " + ssid + "?")) return;
    const resp = await api("POST", "/api/roaming/connect", { ssid });
    if (resp && resp.ok) {
        setTimeout(loadRoamingStatus, 3000);
    } else {
        alert("Connect failed: " + ((resp && resp.error) || "Unknown"));
    }
}

async function doDisconnect() {
    if (!confirm("Disconnect from current WiFi?")) return;
    const resp = await api("POST", "/api/roaming/disconnect");
    if (resp && resp.ok) {
        setTimeout(loadRoamingStatus, 2000);
    } else {
        alert("Disconnect failed: " + ((resp && resp.error) || "Unknown"));
    }
}

async function loadRoamingStatus() {
    const resp = await api("GET", "/api/roaming/status");
    if (!resp || !resp.ok) return;
    const s = resp.data;
    const el = document.getElementById("roaming-info");
    if (s.connected) {
        const bars = signalBars(s.signal_dbm);
        el.innerHTML = `${bars} Connected to <strong>${escHtml(s.ssid)}</strong> (${s.signal_dbm} dBm)` +
            (s.ip ? ` &mdash; IP: ${s.ip}` : "");
    } else {
        el.textContent = "Not connected";
    }
}

// --- Known Networks ---

async function loadKnownNetworks() {
    const resp = await api("GET", "/api/roaming/networks");
    if (!resp || !resp.ok) return;

    const list = document.getElementById("known-list");
    if (resp.data.length === 0) {
        list.innerHTML = '<li class="known-item"><span style="color:var(--text-muted)">No known networks</span></li>';
        return;
    }

    list.innerHTML = resp.data.map(n => {
        const acBadge = n.autoconnect
            ? '<span class="badge badge-up" style="font-size:10px;padding:1px 6px">auto</span>'
            : '<span class="badge badge-down" style="font-size:10px;padding:1px 6px">manual</span>';
        return `<li class="known-item">
            <div>
                <span class="known-prio">${n.priority}</span>
                <strong>${escHtml(n.ssid)}</strong>
                <span class="known-key">${n.key_display}</span>
                ${acBadge}
            </div>
            <div class="btn-group">
                <button class="btn btn-outline btn-sm" onclick="showEditModal('${escHtml(n.ssid)}', '${escHtml(n.key)}', ${n.priority}, ${n.autoconnect})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteNetwork('${escHtml(n.ssid)}')">Del</button>
            </div>
        </li>`;
    }).join("");

    // Also load roaming status
    loadRoamingStatus();
}

function showAddModal() {
    editingSsid = null;
    connectAndAdd = false;
    document.getElementById("modal-title").textContent = "Add Known Network";
    document.getElementById("modal-ssid").value = "";
    document.getElementById("modal-ssid").disabled = false;
    document.getElementById("modal-key").value = "";
    document.getElementById("modal-priority").value = "10";
    document.getElementById("modal-autoconnect").checked = true;
    document.getElementById("modal-network").classList.add("active");
}

function showConnectAddModal(ssid) {
    editingSsid = null;
    connectAndAdd = true;
    document.getElementById("modal-title").textContent = "Connect to " + ssid;
    document.getElementById("modal-ssid").value = ssid;
    document.getElementById("modal-ssid").disabled = true;
    document.getElementById("modal-key").value = "";
    document.getElementById("modal-priority").value = "10";
    document.getElementById("modal-autoconnect").checked = true;
    document.getElementById("modal-network").classList.add("active");
}

function showEditModal(ssid, key, priority, autoconnect) {
    editingSsid = ssid;
    connectAndAdd = false;
    document.getElementById("modal-title").textContent = "Edit Network";
    document.getElementById("modal-ssid").value = ssid;
    document.getElementById("modal-ssid").disabled = true;
    document.getElementById("modal-key").value = key === "open" ? "open" : key;
    document.getElementById("modal-priority").value = priority;
    document.getElementById("modal-autoconnect").checked = autoconnect !== false;
    document.getElementById("modal-network").classList.add("active");
}

function closeModal() {
    document.getElementById("modal-network").classList.remove("active");
}

async function saveNetwork() {
    const ssid = document.getElementById("modal-ssid").value.trim();
    const key = document.getElementById("modal-key").value.trim() || "open";
    const priority = parseInt(document.getElementById("modal-priority").value) || 10;
    const autoconnect = document.getElementById("modal-autoconnect").checked;

    if (!ssid) { alert("SSID is required"); return; }
    if (ssid.includes("|")) { alert("SSID cannot contain pipe (|)"); return; }

    let resp;
    if (editingSsid) {
        resp = await api("PUT", "/api/roaming/networks/" + encodeURIComponent(editingSsid), { key, priority, autoconnect });
    } else if (connectAndAdd) {
        // Connect+Add from scan: show spinner, longer timeout
        const saveBtn = document.querySelector("#modal-network .btn-primary");
        const origText = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner"></span>Connecting...';
        resp = await api("POST", "/api/roaming/connect-and-add", { ssid, key, priority, autoconnect });
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    } else {
        resp = await api("POST", "/api/roaming/networks", { ssid, key, priority, autoconnect });
    }

    if (resp && resp.ok) {
        closeModal();
        loadKnownNetworks();
        if (connectAndAdd) {
            setTimeout(loadRoamingStatus, 2000);
        }
    } else {
        alert("Failed: " + ((resp && resp.error) || "Unknown"));
    }
}

async function deleteNetwork(ssid) {
    if (!confirm("Delete " + ssid + " from known networks?")) return;
    const resp = await api("DELETE", "/api/roaming/networks/" + encodeURIComponent(ssid));
    if (resp && resp.ok) {
        loadKnownNetworks();
    } else {
        alert("Delete failed: " + ((resp && resp.error) || "Unknown"));
    }
}

// --- WAN & Services ---

async function restartWan(name) {
    if (!confirm("Restart " + name + "?")) return;
    const resp = await api("POST", "/api/wan/" + name + "/restart");
    if (resp && resp.ok) {
        setTimeout(pollStatus, 3000);
    } else {
        alert("Restart failed: " + ((resp && resp.error) || "Unknown"));
    }
}

async function loadServices() {
    const resp = await api("GET", "/api/services");
    if (!resp || !resp.ok) return;

    const el = document.getElementById("services-list");
    el.innerHTML = resp.data.map(s => {
        const badge = s.running
            ? '<span class="badge badge-up">running</span>'
            : '<span class="badge badge-down">stopped</span>';
        return `<div class="service-item">
            <span>${s.name}</span> ${badge}
            <button class="btn btn-outline btn-sm" onclick="restartService('${s.name}')">Restart</button>
        </div>`;
    }).join("");
}

async function restartService(name) {
    if (!confirm("Restart " + name + "?")) return;
    const resp = await api("POST", "/api/services/" + name + "/restart");
    if (resp && resp.ok) {
        setTimeout(loadServices, 2000);
    } else {
        alert("Restart failed: " + ((resp && resp.error) || "Unknown"));
    }
}

// --- Helpers ---

function signalBars(dbm) {
    const level = dbm > -40 ? 4 : dbm > -60 ? 3 : dbm > -75 ? 2 : 1;
    let html = '<span class="signal-bars">';
    for (let i = 1; i <= 4; i++) {
        html += `<span class="signal-bar${i <= level ? " active" : ""}"></span>`;
    }
    return html + "</span>";
}

function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

function updateQuickLinks() {
    // Set links to current hostname with correct ports
    const host = window.location.hostname;
    document.getElementById("link-novnc").href = "http://" + host + ":6080/vnc.html";
    document.getElementById("link-luci").href = "https://" + host;
}

// --- Init ---

// Try to access API to check if session is valid (lightweight, no SSH)
(async function init() {
    const resp = await api("GET", "/api/ping");
    if (resp && resp.ok) {
        showDashboard();
    } else {
        showLogin();
    }
})();
