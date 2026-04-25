/* seamless-wan dashboard — dashboard.js */

let pollTimer = null;
let editingSsid = null; // null = adding, string = editing
let connectAndAdd = false; // true when connecting from scan results
let wanPublicIps = {}; // cached public IPs per WAN
let lastWanIps = {}; // track internal IPs to detect changes
let wanProbes = {}; // wan-monitor probe results: name -> {status, failures, ...}

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
}

function showDashboard() {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("dashboard").style.display = "";
    updateQuickLinks();
    pollStatus();
    loadKnownNetworks();
    loadServices();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 5000);
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

    // Tunnel
    renderTunnel(d.tunnel);

    dot.style.background = "#22c55e";
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
