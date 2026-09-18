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
        if ($("hdr-node-id")) $("hdr-node-id").textContent = `🆔 Mi Nodo: ${data.id}`;
        const roleLabels = { leader: "👑 Líder", follower: "📡 Seguidor", candidate: "🗳️ Candidato" };
        if ($("hdr-role")) $("hdr-role").textContent = roleLabels[data.role] || data.role;
        if ($("hdr-term") && data.term != null) $("hdr-term").textContent = `Término: ${data.term}`;

        // Banda informativa en Sección de Conexiones Salientes
        if ($("my-banner-node-id")) $("my-banner-node-id").textContent = data.id || "—";
        if ($("my-banner-url")) {
            $("my-banner-url").textContent = data.url || "—";
            $("my-banner-url").title = data.url || "";
        }
        if ($("my-banner-role")) {
            $("my-banner-role").textContent = roleLabels[data.role] || data.role || "—";
        }

        // Banner del líder actual
        const banner = $("leader-banner");
        const currentLeader = data.leader || data.leaderId;
        if (banner) {
            if (currentLeader) {
                banner.style.display = "flex";
                if ($("leader-banner-id")) $("leader-banner-id").textContent = currentLeader;
                if ($("leader-banner-url")) $("leader-banner-url").textContent = data.leaderUrl || "";
            } else {
                banner.style.display = "none";
            }
        }

    } catch (err) {
        console.warn("loadNodeState:", err);
    }
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
    if ($("naming-count")) $("naming-count").textContent = `${workers.length} worker${workers.length !== 1 ? "s" : ""}`;
    if ($("tab-incoming-badge")) $("tab-incoming-badge").textContent = workers.length;

    if (!tbody) return;

    if (workers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Sin workers registrados aún...</td></tr>';
        return;
    }

    tbody.innerHTML = workers.map(w => {
        let role = (w.role || "worker").toLowerCase();
        
        // Sincronizar el rol real desde la red de gossip (engine) si conocemos esta URL
        if (typeof allPeers !== 'undefined' && Array.isArray(allPeers)) {
            const clusterPeer = allPeers.find(p => {
                const pUrl = (p.url || "").replace(/\/$/, "");
                const wUrl = (w.url || "").replace(/\/$/, "");
                return pUrl === wUrl;
            });
            if (clusterPeer && clusterPeer.snapshot && clusterPeer.snapshot.role) {
                role = clusterPeer.snapshot.role.toLowerCase();
            }
        }
        const roleClass = role === "leader" ? "badge-role-leader" 
                        : role === "candidate" ? "badge-role-candidate" 
                        : role === "follower" ? "badge-role-follower" 
                        : "badge-role-worker";

        return `
            <tr>
                <td><span class="status-dot ${w.status === "ACTIVO" ? "active" : "fallen"}">${w.status === "ACTIVO" ? "ACTIVO" : "CAÍDO"}</span></td>
                <td style="font-weight:600">${escHtml(w.name)}</td>
                <td><span class="url-cell" title="${escHtml(w.url)}">${escHtml(w.url)}</span></td>
                <td><span class="badge ${roleClass}">${role.toUpperCase()}</span></td>
                <td style="color:${w.hasPulse ? "var(--green)" : "var(--red)"}">${w.secondsWithoutPulse}s</td>
                <td>
                    <div class="btn-group-row">
                        <button class="btn btn-danger btn-sm" onclick="simulateFall('${escHtml(w.name)}')">⬇ Caída</button>
                        <button class="btn btn-ghost btn-sm" onclick="disconnectWorker('${escHtml(w.name)}')" title="Desconectar este worker">🔌 Desconectar</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");

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
    if (!msgTo) return;
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
    if (!tbody) return;

    // Solo considerar peers con URL válida
    const validPeers = peers.filter(p => p.url);

    if ($("peers-count")) $("peers-count").textContent = `${validPeers.length} peer${validPeers.length !== 1 ? "s" : ""}`;
    if ($("tab-outgoing-badge")) $("tab-outgoing-badge").textContent = validPeers.length;
    if ($("kpi-total-val")) $("kpi-total-val").textContent = validPeers.length;
    if ($("kpi-active-val")) $("kpi-active-val").textContent = validPeers.filter(p => p.alive).length;
    if ($("kpi-fallen-val")) $("kpi-fallen-val").textContent = validPeers.filter(p => !p.alive).length;

    if (validPeers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No te has conectado a ningún servidor externo aún. Haz clic en "⚡ Conectar a Otro" para unirte a un compañero.</td></tr>';
        return;
    }

    tbody.innerHTML = validPeers.map(p => {
        const snap = p.snapshot || {};
        const role = p.alive ? (snap.role || "peer") : "desconectado";
        const roleClass = role === "leader" ? "badge-role-leader" : role === "candidate" ? "badge-role-candidate" : "badge-role-follower";
        const elapsedSecs = p.lastSeen ? Math.floor((Date.now() - p.lastSeen) / 1000) : 0;
        const elapsedStr = elapsedSecs + "s";
        
        // Calcular número de vecinos que conoce el peer remoto
        let vecinosCount = 0;
        if (Array.isArray(snap.peers)) {
            vecinosCount = snap.peers.length;
        }

        // Determinar estado visual (Activo, Fallando, Caído)
        let statusText = "CONECTADO";
        let statusClass = "active";
        
        if (!p.alive) {
            statusText = "SIN RESPUESTA";
            statusClass = "fallen";
        } else if (elapsedSecs >= 3) {
            statusText = "FALLANDO...";
            statusClass = "failing"; // Necesitamos agregar estilo para esto (ej. amarillo/naranja)
        }

        return `
            <tr>
                <td><span class="status-dot ${statusClass}" ${statusClass==='failing' ? 'style="color: var(--orange);"' : ''}>${statusText}</span></td>
                <td style="font-weight:600; color:var(--text-1);">${escHtml(p.id || "?")}</td>
                <td><span class="url-cell" title="${escHtml(p.url)}">${escHtml(p.url)}</span></td>
                <td><span class="badge ${roleClass}">${role.toUpperCase()}</span></td>
                <td style="color:var(--text-2); font-weight: 500;">
                    <span style="background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 12px; font-size: 0.85em;">
                        👥 ${vecinosCount} ${vecinosCount === 1 ? 'peer' : 'peers'}
                    </span>
                </td>
                <td style="color:${statusClass === 'failing' ? 'var(--orange)' : 'var(--text-3)'}">${elapsedStr}</td>
                <td>
                    <button class="btn btn-danger btn-sm" onclick="disconnectPeer('${escHtml(p.url)}', '${escHtml(p.id || '')}')" title="Desconectarse de este servidor">
                        🔌 Desconectar
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

// ─── Desconectar Peer Manualmente ───────────────────────────────────────────
async function disconnectPeer(url, id) {
    const label = id ? `"${id}" (${url})` : url;
    if (!confirm(`¿Estás seguro de que deseas desconectarte del servidor ${label}?`)) {
        return;
    }

    try {
        const resp = await fetch(`/election/peers?url=${encodeURIComponent(url)}&id=${encodeURIComponent(id || '')}`, {
            method: "DELETE"
        });
        if (resp.ok) {
            showToast(`Desconectado exitosamente de ${id || url}`, "info");
            await loadAll();
        } else {
            const data = await resp.json();
            showToast("Error: " + (data.error || "No se pudo desconectar"), "error");
        }
    } catch (err) {
        showToast("Error al desconectar: " + err.message, "error");
    }
}

// ─── Desconectar Worker Manualmente ─────────────────────────────────────────
async function disconnectWorker(name) {
    if (!confirm(`¿Estás seguro de que deseas desconectar a "${name}"?`)) return;
    try {
        const resp = await fetch(`/unregister/${encodeURIComponent(name)}`, { method: "POST" });
        if (resp.ok) {
            showToast(`Worker "${name}" desconectado`, "info");
            await loadAll();
        } else {
            showToast("No se pudo desregistrar el worker", "error");
        }
    } catch (e) {
        showToast("Error de red al desconectar worker", "error");
    }
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

// ─── Desconectar mi Nodo ─────────────────────────────────────
async function disconnectNode() {
    const btn = $("btn-kill-node");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Apagando...";
    }
    try {
        await fetch("/api/shutdown", { method: "POST" });
        showToast("🔌 Nodo desconectado exitosamente. Se cerrará el proceso en la terminal.", "success");
        // Dejar la UI en estado desconectado
        setTimeout(() => {
            document.body.style.opacity = "0.5";
            document.body.style.pointerEvents = "none";
        }, 1500);
    } catch (err) {
        showToast(`❌ Error al desconectar: ${err.message}`, "error");
        if (btn) {
            btn.disabled = false;
            btn.textContent = "🔌 Desconectar mi Nodo";
        }
    }
}

// ─── Búsqueda por Vecinos en las URLs ────────────────────────
async function executeNeighborSearch() {
    const input = $("neighbor-search-input");
    const q = input ? input.value.trim() : "";
    if (!q) {
        showToast("Ingresa un término para buscar", "info");
        return;
    }

    const container = $("neighbor-search-results");
    const tbody = $("neighbor-search-tbody");
    if (container) container.style.display = "block";
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">🔍 Consultando en vivo a través de la red de vecinos...</td></tr>';

    try {
        const resp = await fetch(`/api/search-neighbors?q=${encodeURIComponent(q)}`);
        if (!resp.ok) throw new Error("Error en la búsqueda distribuida");
        const data = await resp.json();
        const results = data.results || [];

        if (results.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No se encontró ningún nodo o URL con "${escHtml(q)}" en tus vecinos conocidos.</td></tr>`;
            return;
        }

        tbody.innerHTML = results.map(r => {
            const role = (r.role || "worker").toLowerCase();
            const roleClass = role === "leader" ? "badge-role-leader" 
                            : role === "candidate" ? "badge-role-candidate" 
                            : role === "follower" ? "badge-role-follower" 
                            : "badge-role-worker";
            const isConnected = (r.status === "ACTIVO" || r.status === "CONECTADO");

            return `
                <tr>
                    <td><span class="status-dot ${isConnected ? "active" : "fallen"}">${r.status || "ACTIVO"}</span></td>
                    <td style="font-weight:600">${escHtml(r.name)}</td>
                    <td><span class="url-cell" title="${escHtml(r.url)}">${escHtml(r.url)}</span></td>
                    <td><span class="badge ${roleClass}">${role.toUpperCase()}</span></td>
                    <td style="font-size:0.8rem; color:var(--text-2);">${escHtml(r.source)} ${r.hops ? `(Salto: ${r.hops})` : ""}</td>
                    <td>
                        <button class="btn btn-primary btn-sm" onclick="quickFillConnect('${escHtml(r.url)}', '${escHtml(r.name)}')">
                            ⚡ Enlazar
                        </button>
                    </td>
                </tr>
            `;
        }).join("");

        showToast(`Búsqueda completada: ${results.length} resultado(s)`, "success");
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-cell" style="color:var(--red);">❌ Error buscando en vecinos: ${escHtml(err.message)}</td></tr>`;
    }
}

function clearNeighborSearch() {
    const input = $("neighbor-search-input");
    const container = $("neighbor-search-results");
    if (input) input.value = "";
    if (container) container.style.display = "none";
}

function quickFillConnect(url, id) {
    openConnectModal();
    const urlInput = $("peer-connect-url");
    if (urlInput) urlInput.value = url;
}

// ─── Explorar Vecinos de una URL en el Modal ─────────────────
async function discoverNeighborsOfInput() {
    const urlInput = $("peer-connect-url");
    const url = urlInput ? urlInput.value.trim() : "";
    if (!url) return alert("Por favor ingresa la URL que deseas explorar");

    const box = $("discovered-neighbors-box");
    if (box) {
        box.style.display = "block";
        box.innerHTML = '<div style="color:var(--cyan);">⏳ Consultando a la URL remota y descubriendo sus vecinos...</div>';
    }

    try {
        const resp = await fetch("/api/discover-neighbors", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "No se pudo consultar el nodo remoto");

        const allDiscovered = [...(data.peers || []), ...(data.workers || [])];
        if (allDiscovered.length === 0) {
            box.innerHTML = `<div>✅ Conexión exitosa a la URL, pero ese nodo aún no tiene vecinos reportados.</div>`;
            return;
        }

        let html = `<div style="margin-bottom:6px; font-weight:600; color:var(--text-1);">🌐 Vecinos descubiertos en ${escHtml(data.seedUrl)} (${allDiscovered.length}):</div>`;
        html += `<div style="max-height:140px; overflow-y:auto; display:flex; flex-direction:column; gap:4px;">`;
        allDiscovered.forEach(item => {
            const label = item.id || item.name || item.url;
            const itemUrl = item.url;
            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.04); padding:4px 8px; border-radius:4px;">
                    <div>
                        <span style="font-weight:600; color:var(--cyan);">${escHtml(label)}</span>
                        <span style="color:var(--text-3); font-size:0.75rem; margin-left:6px;">${escHtml(itemUrl)}</span>
                    </div>
                    <button class="btn btn-ghost btn-sm" style="padding:1px 6px; font-size:11px;" onclick="$('peer-connect-url').value='${escHtml(itemUrl)}'; showToast('URL copiada', 'info');">Usar</button>
                </div>
            `;
        });
        html += `</div>`;
        box.innerHTML = html;
    } catch (err) {
        if (box) box.innerHTML = `<div style="color:var(--red);">❌ ${escHtml(err.message)}</div>`;
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
