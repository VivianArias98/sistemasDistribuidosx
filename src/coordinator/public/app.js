/* ═══════════════════════════════════════════════════════════
   app.js — Lógica del Panel Principal del Coordinador
   Conecta a SSE /events, poll /election/state, /api/status
   ═══════════════════════════════════════════════════════════ */

const POLL_INTERVAL = 4000;

// ─── Estado local del panel ───────────────────────────────
let allWorkers = [];
let allPeers   = [];
let msgCount   = 0;
let logLines   = [];

// ─── Helpers ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
const timeStr = (ts) => new Date(ts).toLocaleTimeString("es-MX", { hour12: false });

function showToast(msg, type = "info") {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    $("toast-container").appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function showResult(id, msg, type = "info") {
    const el = $(id);
    el.className = `result-box ${type}`;
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(() => { el.style.display = "none"; }, 5000);
}

// ─── Clock ────────────────────────────────────────────────
setInterval(() => {
    $("hdr-time").textContent = "🕐 " + new Date().toLocaleTimeString("es-MX", { hour12: false });
}, 1000);

// ─── SSE — Stream de eventos en vivo ─────────────────────
function connectSSE() {
    const source = new EventSource("/events");

    source.onopen = () => {
        $("pulse-dot").className = "pulse-dot active";
        $("sys-status-text").textContent = "Sistema Activo";
        $("sys-status-badge").style.borderColor = "rgba(16,217,133,0.4)";
    };

    source.onmessage = (e) => {
        try {
            const ev = JSON.parse(e.data);
            appendLog(ev);
        } catch {}
    };

    source.onerror = () => {
        $("pulse-dot").className = "pulse-dot error";
        $("sys-status-text").textContent = "Sin conexión...";
        // Reintentar en 5s
        source.close();
        setTimeout(connectSSE, 5000);
    };
}

function appendLog(ev) {
    const terminal = $("log-terminal");
    const placeholder = terminal.querySelector(".terminal-placeholder");
    if (placeholder) placeholder.remove();

    const typeMap = {
        "election-start":  "election-start",
        "election-won":    "election-won",
        "leader-lost":     "leader-lost",
        "leader-accepted": "leader",
        "peer-up":         "peer-up",
        "peer-down":       "peer-down",
        "connected":       "default",
    };

    const cssClass = typeMap[ev.type] || "default";
    const icons = {
        "election-start":  "🗳️ ",
        "election-won":    "👑",
        "leader-lost":     "💥",
        "leader-accepted": "✅",
        "peer-up":         "🟢",
        "peer-down":       "🔴",
        "connected":       "📡",
    };
    const icon = icons[ev.type] || "•";
    const t = ev.ts ? timeStr(ev.ts) : new Date().toLocaleTimeString("es-MX", { hour12: false });
    const label = ev.type || "event";
    const msg   = ev.message || JSON.stringify(ev);

    const el = document.createElement("div");
    el.className = "log-entry";
    el.innerHTML = `
        <span class="log-time">${t}</span>
        <span class="log-type ${cssClass}">${icon} ${label}</span>
        <span class="log-msg">${msg}</span>
    `;
    terminal.prepend(el);

    // Limitar a 80 entradas
    while (terminal.children.length > 80) terminal.lastChild?.remove();
}

function clearLogs() {
    const t = $("log-terminal");
    t.innerHTML = '<div class="terminal-placeholder">Logs limpiados — esperando eventos...</div>';
}

// ─── Poll: estado del coordinador ─────────────────────────
async function loadNodeState() {
    try {
        const r = await fetch("/election/state");
        if (!r.ok) return;
        const data = await r.json();

        // Header info
        $("hdr-node-id").textContent = `Nodo ${data.id}`;
        const roleLabels = { leader: "👑 Líder", follower: "📡 Seguidor", candidate: "🗳️ Candidato" };
        $("hdr-role").textContent = roleLabels[data.role] || data.role;
        $("hdr-term").textContent = `Término: ${data.term}`;

        // Banner del líder actual
        const banner = $("leader-banner");
        if (data.leaderId) {
            banner.style.display = "flex";
            $("leader-banner-id").textContent = data.leaderId;
            $("leader-banner-url").textContent = data.leaderUrl || "";
        } else {
            banner.style.display = "none";
        }

    } catch {}
}

// ─── Poll: workers del Naming Service ────────────────────
async function loadAll() {
    await Promise.all([loadWorkers(), loadCluster(), loadMessages()]);
}

async function loadWorkers() {
    try {
        const r = await fetch("/api/status");
        if (!r.ok) return;
        allWorkers = await r.json();
        renderWorkers(allWorkers);
        updateKpis();
    } catch {}
}

function renderWorkers(workers) {
    const tbody = $("nodes-tbody");
    $("naming-count").textContent = `${workers.length} worker${workers.length !== 1 ? "s" : ""}`;

    if (workers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Sin workers registrados aún...</td></tr>';
        return;
    }

    tbody.innerHTML = workers.map(w => `
        <tr>
            <td><span class="status-dot ${w.status === "ACTIVO" ? "active" : "fallen"}">${w.status === "ACTIVO" ? "ACTIVO" : "CAÍDO"}</span></td>
            <td style="font-weight:600">${escHtml(w.name)}</td>
            <td><span class="url-cell" title="${escHtml(w.url)}">${escHtml(w.url)}</span></td>
            <td style="color:${w.hasPulse ? "var(--green)" : "var(--red)"}">${w.secondsWithoutPulse}s</td>
            <td>
                <div class="btn-group-row">
                    <button class="btn btn-danger btn-sm" onclick="simulateFall('${escHtml(w.name)}')">⬇ Caída</button>
                </div>
            </td>
        </tr>
    `).join("");

    // Sincronizar select de mensajería
    updateMessageDropdown();
}

// ─── Poll: cluster (peers) ────────────────────────────────
async function loadCluster() {
    try {
        const r = await fetch("/cluster");
        if (!r.ok) return;
        const data = await r.json();
        allPeers = data.peers || [];
        renderPeers(allPeers, data.cluster);
        updateMessageDropdown();
    } catch {}
}

function updateMessageDropdown() {
    const msgTo = $("msg-to");
    const existing = new Set([...msgTo.options].map(o => o.value));
    
    const targets = [...allWorkers.map(w => w.name), ...allPeers.map(p => p.id || p.url)];
    
    targets.forEach(name => {
        if (!existing.has(name)) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            msgTo.appendChild(opt);
        }
    });
}

function renderPeers(peers, cluster) {
    const tbody = $("peers-tbody");

    // Filtrar: solo mostrar peers con URLs externas (ngrok u otros), no localhost
    const externalPeers = peers.filter(p => p.url && !p.url.includes("localhost") && !p.url.includes("127.0.0.1"));

    $("peers-count").textContent = `${externalPeers.length} peer${externalPeers.length !== 1 ? "s" : ""}`;
    $("kpi-total-val").textContent = externalPeers.length + 1;
    $("kpi-active-val").textContent = externalPeers.filter(p => p.alive).length + 1;
    $("kpi-fallen-val").textContent = externalPeers.filter(p => !p.alive).length;

    if (externalPeers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Sin peers externos conocidos aún...</td></tr>';
        return;
    }

    tbody.innerHTML = externalPeers.map(p => {
        const snap = p.snapshot || {};
        const role = snap.role || "?";
        const roleClass = role === "leader" ? "badge-role-leader" : role === "candidate" ? "badge-role-candidate" : "badge-role-follower";
        const secsAgo = p.lastSeen ? Math.floor((Date.now() - p.lastSeen) / 1000) : "?";
        return `
            <tr>
                <td><span class="status-dot ${p.alive ? "active" : "fallen"}">${p.alive ? "VIVO" : "CAÍDO"}</span></td>
                <td style="font-weight:600">${escHtml(p.id || "?")}</td>
                <td><span class="url-cell" title="${escHtml(p.url)}">${escHtml(p.url)}</span></td>
                <td><span class="badge ${roleClass}">${role}</span></td>
                <td style="color:var(--text-3)">${secsAgo}s</td>
            </tr>
        `;
    }).join("");
}

function updateKpis() {
    $("kpi-workers-val").textContent = allWorkers.length;
}

// ─── Poll: mensajes ────────────────────────────────────────
async function loadMessages() {
    try {
        const r = await fetch("/api/messages?limit=20");
        if (!r.ok) return;
        const msgs = await r.json();
        msgCount = msgs.length;
        $("kpi-msgs-val").textContent = msgCount;
        renderMessages(msgs);
    } catch {}
}

function renderMessages(msgs) {
    const el = $("msg-history");
    if (msgs.length === 0) {
        el.innerHTML = '<div class="empty-cell">Sin mensajes aún...</div>';
        return;
    }
    el.innerHTML = msgs.slice(0, 15).map(m => {
        const cls   = m.status === "ENTREGADO" ? "delivered" : m.status === "FALLIDO" ? "failed" : "transit";
        const icon  = m.status === "ENTREGADO" ? "✅" : m.status === "FALLIDO" ? "❌" : "⏳";
        const route = `${escHtml(m.from || "?")} → ${escHtml(m.to || "?")}`;
        return `
            <div class="msg-item ${cls}">
                <div class="msg-meta">
                    <span class="msg-route">${route}</span>
                    <span class="msg-time">${m.timestamp ? timeStr(m.timestamp) : ""}</span>
                    <span class="${cls === "delivered" ? "msg-status-ok" : "msg-status-fail"}">${icon}</span>
                </div>
                <div class="msg-body">${escHtml(m.message || "")}</div>
            </div>
        `;
    }).join("");
}

// ─── Acciones ──────────────────────────────────────────────
async function sendMessage() {
    const from    = $("msg-from").value.trim();
    const to      = $("msg-to").value.trim();
    const message = $("msg-text").value.trim();

    if (!to)      return showResult("send-result", "Selecciona un destinatario", "error");
    if (!message) return showResult("send-result", "Escribe un mensaje", "error");

    const btn = $("btn-send-msg");
    btn.disabled = true;
    btn.textContent = "Enviando...";

    try {
        const r = await fetch("/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, to, message }),
        });
        const data = await r.json();
        if (r.ok && data.success) {
            showResult("send-result", `✅ Mensaje entregado a '${to}'`, "success");
            showToast(`Mensaje enviado a '${to}'`, "success");
            $("msg-text").value = "";
            await loadMessages();
        } else {
            showResult("send-result", `❌ ${data.error || "Error desconocido"}`, "error");
        }
    } catch (err) {
        showResult("send-result", `❌ ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "➤ Enviar Mensaje";
    }
}

async function simulateFall(name) {
    try {
        await fetch(`/api/simulate-failure/${encodeURIComponent(name)}`, { method: "POST" });
        showToast(`Worker '${name}' marcado como CAÍDO`, "info");
        await loadWorkers();
    } catch (err) {
        showToast(err.message, "error");
    }
}

// ─── Matar al Líder (dimisión local) ──────────────────────
async function killLeader() {
    const btn = $("btn-kill-leader");
    btn.disabled = true;
    btn.textContent = "Disparando...";
    try {
        await fetch("/election/trigger", { method: "POST" });
        showToast("💀 Elección forzada — este nodo abdica", "success");
        await loadNodeState();
    } catch (err) {
        showToast(`❌ ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "💀 Matar Líder";
    }
}

// ─── Utilidades ────────────────────────────────────────────
function escHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ─── Init ──────────────────────────────────────────────────
connectSSE();
loadNodeState();
loadAll();
setInterval(() => { loadNodeState(); loadAll(); }, POLL_INTERVAL);
