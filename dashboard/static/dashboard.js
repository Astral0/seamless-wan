/* seamless-wan dashboard — dashboard.js */

let pollTimer = null;
let editingSsid = null; // null = adding, string = editing

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
    document.getElementById("sys-temp").textContent = d.system.temp_celsius ? d.system.temp_celsius + "\u00B0C" : "--";

    const powerEl = document.getElementById("sys-power");
    if (d.system.throttled_ok) {
        powerEl.innerHTML = '<span class="badge badge-up">OK</span>';
    } else {
        powerEl.innerHTML = '<span class="badge badge-warn">' + d.system.throttled + '</span>';
    }

    // WANs
    renderWans(d.wans);

    // Tunnel
    renderTunnel(d.tunnel);

    dot.style.background = "#22c55e";
}

function renderWans(wans) {
    const grid = document.getElementById("wan-grid");
    grid.innerHTML = wans.map(w => {
        const cls = w.up ? "up" : "down";
        const badge = w.up
            ? '<span class="badge badge-up">UP</span>'
            : '<span class="badge badge-down">DOWN</span>';
        const labels = { usb_tethering: "USB", wifi: "WiFi", wifi_roaming: "Roaming" };
        return `<div class="wan-card ${cls}">
            <div class="wan-name">${w.name}</div>
            <div class="wan-iface">${w.interface || "?"} &middot; ${labels[w.device_type] || w.device_type}</div>
            <div class="wan-ip">${w.ip || "&mdash;"}</div>
            ${badge}
            <div style="margin-top:8px">
                <button class="btn btn-outline btn-sm" onclick="restartWan('${w.name}')">Restart</button>
            </div>
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
                : "";
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

    list.innerHTML = resp.data.map(n => `
        <li class="known-item">
            <div>
                <span class="known-prio">${n.priority}</span>
                <strong>${escHtml(n.ssid)}</strong>
                <span class="known-key">${n.key_display}</span>
            </div>
            <div class="btn-group">
                <button class="btn btn-outline btn-sm" onclick="showEditModal('${escHtml(n.ssid)}', '${escHtml(n.key)}', ${n.priority})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteNetwork('${escHtml(n.ssid)}')">Del</button>
            </div>
        </li>
    `).join("");

    // Also load roaming status
    loadRoamingStatus();
}

function showAddModal() {
    editingSsid = null;
    document.getElementById("modal-title").textContent = "Add Known Network";
    document.getElementById("modal-ssid").value = "";
    document.getElementById("modal-ssid").disabled = false;
    document.getElementById("modal-key").value = "";
    document.getElementById("modal-priority").value = "10";
    document.getElementById("modal-network").classList.add("active");
}

function showEditModal(ssid, key, priority) {
    editingSsid = ssid;
    document.getElementById("modal-title").textContent = "Edit Network";
    document.getElementById("modal-ssid").value = ssid;
    document.getElementById("modal-ssid").disabled = true;
    document.getElementById("modal-key").value = key === "open" ? "open" : key;
    document.getElementById("modal-priority").value = priority;
    document.getElementById("modal-network").classList.add("active");
}

function closeModal() {
    document.getElementById("modal-network").classList.remove("active");
}

async function saveNetwork() {
    const ssid = document.getElementById("modal-ssid").value.trim();
    const key = document.getElementById("modal-key").value.trim() || "open";
    const priority = parseInt(document.getElementById("modal-priority").value) || 10;

    if (!ssid) { alert("SSID is required"); return; }
    if (ssid.includes("|")) { alert("SSID cannot contain pipe (|)"); return; }

    let resp;
    if (editingSsid) {
        resp = await api("PUT", "/api/roaming/networks/" + encodeURIComponent(editingSsid), { key, priority });
    } else {
        resp = await api("POST", "/api/roaming/networks", { ssid, key, priority });
    }

    if (resp && resp.ok) {
        closeModal();
        loadKnownNetworks();
    } else {
        alert("Save failed: " + ((resp && resp.error) || "Unknown"));
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

// Try to access API to check if session is valid
(async function init() {
    const resp = await api("GET", "/api/services");
    if (resp && resp.ok) {
        showDashboard();
    } else {
        showLogin();
    }
})();
