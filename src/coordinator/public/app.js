/* ═══════════════════════════════════════════════════════════
   app.js — Lógica del Panel Principal del Coordinador
   Conecta a SSE /events, poll /election/state, /api/status
   ═══════════════════════════════════════════════════════════ */

const POLL_INTERVAL = 4000;

// ─── Estado Local ─────────────────────────────────────────
let allWorkers = [];
let allPeers   = [];
let msgCount   = 0;
let logLines   = [];
let mySelfId   = "Coordinador"; // Se actualiza automáticamente al cargar estado

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
    
    let msg = ev.message;
    if (!msg) {
        if (ev.type === "connected" && ev.state) {
            msg = `Clúster sincronizado. Rol local: <b>${ev.state.role}</b> | Líder actual: <b>${ev.state.leader || 'Ninguno'}</b>`;
        } else {
            msg = `<span style="font-family: monospace; color: var(--text-3); font-size: 0.9em;">${JSON.stringify(ev)}</span>`;
        }
    }

    const el = document.createElement("div");
    el.className = "log-entry";
    el.innerHTML = `
        <span class="log-time">${t}</span>
        <span class="log-type ${cssClass}">${icon} ${label}</span>
        <span class="log-msg">${msg}</span>
    `;
    terminal.prepend(el);

    // Integración con Chat Dedicado
    if (ev.type === "message" || ev.message) {
        if (typeof window.appendChatBubble === "function") {
            window.appendChatBubble(ev);
        }
    }

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
        if (data.id && data.id !== "UNCONFIGURED") mySelfId = data.id;
        window.nodeRole = data.role;
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

        // Detección de cambio de líder para registro en el chat
        if (currentLeader && currentLeader !== window.lastKnownLeaderId) {
            if (window.lastKnownLeaderId !== null && window.lastKnownLeaderId !== "Líder") {
                // El líder cambió
                if (typeof window.localSystemMessages !== "undefined") {
                    window.localSystemMessages.push({
                        id: "sys_" + Date.now(),
                        from: "Sistema",
                        to: "Todos",
                        message: `🔄 Cambio de líder detectado. El nuevo líder del clúster es: ${currentLeader}`,
                        timestamp: Date.now(),
                        status: "ENTREGADO",
                        isSystem: true
                    });
                }
                
                // Si el nodo actual es un seguidor, actualizar su contacto
                if (window.nodeRole !== 'leader' && typeof currentLeaderContact !== 'undefined') {
                    currentLeaderContact = { name: currentLeader, url: data.leaderUrl };
                    if (document.getElementById("chat-current-name")) {
                        document.getElementById("chat-current-name").textContent = currentLeader;
                    }
                    if (document.getElementById("chat-current-status")) {
                        document.getElementById("chat-current-status").textContent = data.leaderUrl;
                    }
                }
            }
            window.lastKnownLeaderId = currentLeader;
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
        let displayUrl = w.url;
        
        // Sincronizar el rol y la URL real desde la red de gossip (engine) si conocemos a este peer
        if (typeof allPeers !== 'undefined' && Array.isArray(allPeers)) {
            const clusterPeer = allPeers.find(p => {
                const pUrl = (p.url || "").replace(/\/$/, "");
                const wUrl = (w.url || "").replace(/\/$/, "");
                return pUrl === wUrl || p.id === w.name;
            });
            
            if (clusterPeer) {
                if (clusterPeer.snapshot && clusterPeer.snapshot.role) {
                    role = clusterPeer.snapshot.role.toLowerCase();
                }
                // Si el peer remoto está mal configurado y dice ser "localhost", pero 
                // nosotros sabemos su URL real de ngrok (porque lo tenemos en la tabla de clúster), la corregimos visualmente.
                if (displayUrl.includes("localhost") || displayUrl.includes("127.0.0.1")) {
                    if (clusterPeer.url && !clusterPeer.url.includes("localhost")) {
                        displayUrl = clusterPeer.url;
                    }
                }
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
                <td><span class="url-cell" title="${escHtml(displayUrl)}">${escHtml(displayUrl)}</span></td>
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

    updateMessageDropdown();
    if (typeof updateChatContacts === "function") updateChatContacts();
}

// ─── Poll: cluster (peers) ────────────────────────────────
async function loadCluster() {
    try {
        const r = await fetch("/cluster");
        if (!r.ok) return;
        const data = await r.json();
        allPeers = data.peers || [];
        renderPeers(allPeers, data.cluster);
        renderTopologyMap(allPeers);
        updateMessageDropdown();
        if (typeof updateChatContacts === "function") updateChatContacts();
    } catch {}
}

function renderTopologyMap(peers) {
    const container = $("topology-map-container");
    if (!container) return;

    if (peers.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-3); padding: 1rem;">No hay coordinadores conectados en la red P2P.</div>';
        return;
    }

    let html = '';
    peers.forEach(p => {
        const neighbors = (p.snapshot && Array.isArray(p.snapshot.peers)) ? p.snapshot.peers : [];
        const isFailing = !p.alive || (Date.now() - p.lastSeen >= 3000);
        
        html += `
            <div style="background: var(--bg-surface-2); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 0.5rem;">
                    <div>
                        <span class="status-dot ${isFailing ? 'fallen' : 'active'}"></span>
                        <strong style="color: var(--text-1); font-size: 1.1rem;">${escHtml(p.id || "?")}</strong>
                    </div>
                    <div style="color: var(--text-2); font-family: monospace; font-size: 0.85rem;">
                        ${escHtml(p.url)}
                    </div>
                </div>
                <div>
                    <div style="font-size: 0.85rem; color: var(--text-3); margin-bottom: 0.5rem;">Vecinos reportados: ${neighbors.length}</div>
                    <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                        ${neighbors.length === 0 ? '<em style="color: var(--text-3); font-size: 0.85rem;">Sin vecinos</em>' : neighbors.map(n => {
                            const nId = n.id || n.name || "?";
                            const nUrl = n.url || n.baseUrl || n.address || "";
                            
                            // Verificar si ya estamos conectados a este vecino directamente
                            const isConnectedDirectly = peers.some(myP => myP.url === nUrl) || (myP => myP.id === nId);
                            
                            return `
                                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.2); padding: 0.4rem 0.8rem; border-radius: 4px;">
                                    <div>
                                        <strong style="color: var(--cyan); font-size: 0.9rem;">${escHtml(nId)}</strong>
                                        <span style="color: var(--text-3); font-size: 0.75rem; margin-left: 0.5rem;">${escHtml(nUrl)}</span>
                                    </div>
                                    <button class="btn btn-primary btn-sm" style="padding: 2px 8px; font-size: 0.75rem;" onclick="connectToPeer('${escHtml(nUrl)}')">
                                        ⚡ Conectar
                                    </button>
                                </div>
                            `;
                        }).join("")}
                    </div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
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
                <td>
                    <div style="font-weight:600; color:var(--text-1);">${escHtml(p.id || "?")}</div>
                    ${p.discoveredVia ? `<div style="font-size: 0.75em; color: var(--text-3); margin-top: 2px;">🔗 Conocido vía <strong>${escHtml(p.discoveredVia)}</strong></div>` : ''}
                </td>
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

// ─── Conectar a un Peer desde el Mapa de Topología ──────────────────────────
async function connectToPeer(url) {
    try {
        showToast("Conectando a " + url + "...", "info");
        const stateRes = await fetch('/election/state');
        if (!stateRes.ok) throw new Error("No se pudo obtener el estado local");
        const state = await stateRes.json();
        
        if (!state.id || state.id === 'UNCONFIGURED') {
            alert("Primero debes configurar tu propio ID haciendo clic en 'Conectar a Otro'.");
            return;
        }

        const res = await fetch('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                nodeId: state.id, 
                baseUrl: state.url, 
                peerUrl: url 
            })
        });
        
        if (res.ok) {
            showToast(`¡Conectado exitosamente a ${url}!`, "success");
            await loadAll();
        } else {
            const data = await res.json();
            showToast(`Error al conectar: ${data.error || "Desconocido"}`, "error");
        }
    } catch (err) {
        showToast(`❌ Error: ${err.message}`, "error");
    }
}

// ─── Enviar Mensaje desde el Chat UI ────────────────────────
async function sendChatMessage() {
    const targetSelect = document.getElementById("msg-to");
    const input = document.getElementById("chat-input");
    if (!targetSelect || !input) return;

    const target = targetSelect.value;
    const msg = input.value.trim();

    if (!target) {
        showToast("Por favor selecciona un destinatario.", "info");
        return;
    }
    if (!msg) return;

    try {
        const myId = document.getElementById("my-node-id")?.value || "Coordinador";
        const r = await fetch("/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: myId, to: target, message: msg })
        });
        
        if (r.ok) {
            input.value = "";
            showToast(`Mensaje enviado a ${target}`, "success");
            // Se asume que el SSE event-stream o la respuesta agregará el evento a la UI
        } else {
            const data = await r.json();
            showToast(`Error al enviar: ${data.error}`, "error");
        }
    } catch (err) {
        showToast(`Error de red: ${err.message}`, "error");
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

// ─── LÓGICA DEL CHAT DEDICADO ──────────────────────────────────────────────────
let allMessages = [];

async function loadMessages() {
    try {
        const r = await fetch("/api/messages");
        if (r.ok) {
            allMessages = await r.json();
            if (window.currentChatContact) {
                renderChatHistory(window.currentChatContact);
            }
        }
    } catch {}
}

// ─── LÓGICA DEL CHAT DEDICADO AL LÍDER ───────────────────────────────────────────
let currentLeaderContact = null; // { name, url }
window.localSystemMessages = []; // Mensajes de sistema del frontend
window.lastKnownLeaderId = null; 

async function loadMessages() {
    try {
        const r = await fetch("/api/messages");
        if (r.ok) {
            let backendMsgs = await r.json();
            // Mezclar mensajes del backend con los mensajes del sistema local y ordenar por fecha descendente
            allMessages = backendMsgs.concat(window.localSystemMessages);
            allMessages.sort((a, b) => b.timestamp - a.timestamp);
            
            if (window.nodeRole === 'leader') {
                renderLeaderInbox();
            } else if (currentLeaderContact) {
                renderLeaderChatHistory();
            }
        }
    } catch {}
}

async function connectToLeaderChat() {
    const inputUrl = document.getElementById("chat-ngrok-url").value.trim();
    const statusDiv = document.getElementById("chat-connect-status");
    
    if (!inputUrl) {
        statusDiv.innerHTML = '<span style="color:var(--red);">⚠️ Ingresa una URL válida</span>';
        return;
    }

    statusDiv.innerHTML = '⏳ Verificando liderazgo...';
    document.getElementById("chat-ngrok-url").disabled = true;

    try {
        const r = await fetch("/api/verify-leader", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: inputUrl })
        });
        
        const data = await r.json();
        
        if (r.ok) {
            let finalUrl = data.leaderUrl;
            let finalId = data.leaderId || "Líder";
            
            if (!data.isLeader) {
                statusDiv.innerHTML = '🔀 Redirigiendo al líder real...';
                await new Promise(res => setTimeout(res, 1000));
            }
            
            currentLeaderContact = { name: finalId, url: finalUrl };
            
            // Mantener pantalla de conexión y mostrar chat debajo
            // document.getElementById("chat-connect-screen").style.display = "none"; // Ya no se oculta
            document.getElementById("chat-active-screen").style.display = "flex";
            document.getElementById("btn-chat-disconnect").style.display = "inline-block";
            
            document.getElementById("chat-current-name").textContent = finalId;
            const statusBadge = document.getElementById("chat-current-status");
            statusBadge.style.display = "inline-block";
            statusBadge.textContent = finalUrl;
            
            loadMessages();
            
        } else {
            statusDiv.innerHTML = `<span style="color:var(--red);">❌ Error: ${data.error}</span>`;
        }
    } catch (err) {
        statusDiv.innerHTML = `<span style="color:var(--red);">❌ Error de red: ${err.message}</span>`;
    } finally {
        document.getElementById("chat-ngrok-url").disabled = false;
    }
}

function disconnectLeaderChat() {
    currentLeaderContact = null;
    document.getElementById("chat-active-screen").style.display = "none";
    document.getElementById("btn-chat-disconnect").style.display = "none";
    document.getElementById("chat-connect-status").innerHTML = "";
    document.getElementById("chat-ngrok-url").value = "";
}

function renderLeaderChatHistory() {
    const historyDiv = document.getElementById("chat-history");
    if (!historyDiv || !currentLeaderContact) return;
    
    const myId = mySelfId || "Coordinador";
    const contactUrl = currentLeaderContact.url;

    // Buscar TODOS los nombres asociados a esta URL en los mensajes
    const contactNames = new Set([currentLeaderContact.name]);
    allPeers.forEach(p => { if (p.url === contactUrl && p.id) contactNames.add(p.id); });
    allMessages.forEach(m => {
        if (m.targetUrl === contactUrl) {
            contactNames.add(m.to);
            contactNames.add(m.from);
        }
    });
    contactNames.delete(myId);
    contactNames.delete("Coordinador");
    
    // Filtrar mensajes que involucren al líder
    const msgs = allMessages.filter(m => {
        const matchesFrom = contactNames.has(m.from);
        const matchesTo = contactNames.has(m.to);
        const matchesUrl = contactUrl && m.targetUrl === contactUrl;
        return matchesFrom || matchesTo || matchesUrl;
    }).reverse();

    if (msgs.length === 0) {
        historyDiv.innerHTML = `
            <div class="chat-placeholder-msg">
                <span style="font-size: 2rem;">💬</span>
                <span>Conectado al Líder. No hay mensajes aún.</span>
            </div>
        `;
        return;
    }

    historyDiv.innerHTML = msgs.map(m => {
        const isMine = m.from === myId || m.from === "Coordinador" || m.from.startsWith(myId);
        const time = m.receivedAt || new Date(m.timestamp || Date.now()).toLocaleTimeString("es-MX", { hour12: false });
        
        if (m.isSystem) {
            return `
                <div style="text-align:center; margin: 1.5rem 0;">
                    <span style="background: var(--bg-3); color: var(--text-2); font-size: 0.8rem; padding: 6px 12px; border-radius: 20px; border: 1px solid var(--border);">
                        ${escHtml(m.message)}
                    </span>
                </div>
            `;
        }

        const alignmentClass = isMine ? "mine" : "theirs";
        const senderLabel = isMine ? "" : `<div style="font-size:0.75rem; opacity:0.7; margin-bottom:4px;">👑 Líder (${escHtml(m.from)})</div>`;
        
        return `
            <div class="chat-bubble-wrapper ${alignmentClass}">
                <div class="chat-bubble">
                    ${senderLabel}
                    ${escHtml(m.message)}
                </div>
                <span class="chat-time">${time}</span>
            </div>
        `;
    }).join("");
    
    historyDiv.scrollTop = historyDiv.scrollHeight;
}

let currentLeaderChatContact = null; // Guardará el ID del contacto seleccionado por el líder

function renderLeaderInbox() {
    const listDiv = document.getElementById("chat-leader-contact-list");
    const historyDiv = document.getElementById("chat-leader-history");
    if (!listDiv || !historyDiv) return;

    const myId = mySelfId || "Coordinador";
    
    // 1. Obtener todos los contactos con los que hay mensajes (entrantes o salientes)
    // El líder está involucrado si (from === myId/Coordinador/Líder) o (to === myId/Coordinador/Líder/Todos)
    const leaderNames = new Set([myId, "Coordinador", "Líder", "Todos"]);
    
    const uniqueContacts = new Set();
    allMessages.forEach(m => {
        if (leaderNames.has(m.to)) uniqueContacts.add(m.from);
        if (leaderNames.has(m.from)) uniqueContacts.add(m.to);
    });
    // Añadir también a los workers y peers conectados actualmente
    if (typeof allWorkers !== 'undefined') {
        allWorkers.forEach(w => { if (w.status === "ACTIVO" && w.name) uniqueContacts.add(w.name); });
    }
    if (typeof allPeers !== 'undefined') {
        allPeers.forEach(p => { if (p.alive && p.id) uniqueContacts.add(p.id); });
    }
    
    // Eliminar los nombres del propio líder de la lista de contactos
    leaderNames.forEach(n => uniqueContacts.delete(n));

    // Convertir a array para renderizar la barra lateral
    const contacts = Array.from(uniqueContacts).sort();

    if (contacts.length === 0) {
        listDiv.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-3); font-size: 0.9rem;">No hay mensajes aún.</div>`;
    } else {
        listDiv.innerHTML = contacts.map(c => {
            const isSelected = (currentLeaderChatContact === c);
            return `
                <div class="contact-item ${isSelected ? 'active' : ''}" onclick="selectLeaderContact('${escHtml(c)}')">
                    <span style="font-size: 1.2rem;">👤</span>
                    <span style="font-weight: 500;">${escHtml(c)}</span>
                </div>
            `;
        }).join("");
    }

    // 2. Renderizar historial del contacto seleccionado
    if (!currentLeaderChatContact) {
        historyDiv.innerHTML = `
            <div class="chat-placeholder-msg">
                <span style="font-size: 2rem;">📥</span>
                <span>Selecciona un contacto a la izquierda para ver la conversación y responder.</span>
            </div>
        `;
        document.getElementById("chat-leader-input").disabled = true;
        document.getElementById("btn-leader-send").disabled = true;
        document.getElementById("chat-leader-current-name").textContent = "Selecciona un chat";
        return;
    }

    document.getElementById("chat-leader-input").disabled = false;
    document.getElementById("btn-leader-send").disabled = false;
    document.getElementById("chat-leader-current-name").textContent = currentLeaderChatContact;

    // Filtrar los mensajes de la conversación con el contacto seleccionado
    const msgs = allMessages.filter(m => {
        const isWithContact = (m.from === currentLeaderChatContact || m.to === currentLeaderChatContact);
        const isWithLeader = (leaderNames.has(m.from) || leaderNames.has(m.to));
        return isWithContact && isWithLeader;
    }).reverse();

    if (msgs.length === 0) {
        historyDiv.innerHTML = `<div class="chat-placeholder-msg"><span>No hay mensajes con ${escHtml(currentLeaderChatContact)}</span></div>`;
        return;
    }

    historyDiv.innerHTML = msgs.map(m => {
        const isMine = leaderNames.has(m.from);
        const alignmentClass = isMine ? "mine" : "theirs";
        const time = m.receivedAt || new Date(m.timestamp || Date.now()).toLocaleTimeString("es-MX", { hour12: false });
        
        return `
            <div class="chat-bubble-wrapper ${alignmentClass}" style="margin-bottom:0.5rem;">
                <div class="chat-bubble">
                    ${escHtml(m.message)}
                </div>
                <span class="chat-time">${time}</span>
            </div>
        `;
    }).join("");
    
    historyDiv.scrollTop = historyDiv.scrollHeight;
}

window.selectLeaderContact = function(contactId) {
    currentLeaderChatContact = contactId;
    renderLeaderInbox();
};

async function sendLeaderMessage() {
    const input = document.getElementById("chat-leader-input");
    if (!currentLeaderChatContact || !input) return;

    const msg = input.value.trim();
    if (!msg) return;

    input.value = ""; 
    const myId = mySelfId || "Coordinador";
    
    // Deshabilitar input temporalmente
    input.disabled = true;
    document.getElementById("btn-leader-send").disabled = true;

    try {
        const r = await fetch("/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Enviamos el mensaje sin directUrl, para que el backend lo enrute usando el Naming Service o Engine
            body: JSON.stringify({ from: myId, to: currentLeaderChatContact, message: msg })
        });
        
        if (r.ok) {
            await loadMessages();
        } else {
            const err = await r.json();
            showToast("Error al enviar: " + (err.error || "Desconocido"), "error");
        }
    } catch (err) {
        showToast("Error de red: " + err.message, "error");
    } finally {
        input.disabled = false;
        document.getElementById("btn-leader-send").disabled = false;
        input.focus();
    }
}

window.appendChatBubble = function(ev) {
    if (currentLeaderContact || window.nodeRole === 'leader') loadMessages();
}

async function sendDedicatedMessage() {
    const input = document.getElementById("chat-dedicated-input");
    if (!currentLeaderContact || !input) return;

    const msg = input.value.trim();
    if (!msg) return;

    input.value = ""; 
    
    try {
        const myId = mySelfId || "Coordinador";
        const r = await fetch("/api/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: myId, to: currentLeaderContact.name, message: msg, directUrl: currentLeaderContact.url })
        });
        
        if (r.ok) {
            await loadMessages();
        } else {
            const data = await r.json();
            showToast(`Error al enviar: ${data.error}`, "error");
        }
    } catch (err) {
        showToast(`Error de red: ${err.message}`, "error");
    }
}

// ─── Init ──────────────────────────────────────────────────
connectSSE();
loadNodeState().then(() => {
    loadMessages();
});
loadAll();
setInterval(() => { loadNodeState(); loadAll(); }, POLL_INTERVAL);
setInterval(() => {
    if (document.getElementById("view-panel-chat")?.classList.contains("active")) {
        if (currentLeaderContact || window.nodeRole === 'leader') {
            loadMessages();
        }
    }
}, 3000);
