/* =============================================
   Vivian-Andrea Panel — app.js
   Lógica completa de la interfaz:
   - Polling de estado en tiempo real
   - Servicio de Nombres
   - Mensajería distribuida
   - Hotreload
   - Simulador de Timeout
   - Consola de Observabilidad
   ============================================= */

const API = ''; // Vacío = misma origin (http://localhost:3000)

// Estado local de la app
let allNodes = [];
let allLogs = [];
let allMessages = [];
let logFilterType = '';
let currentInboxNode = '';
let currentInboxTab = 'middleware';

// ─────────────────────────────────────────────
// CLOCK
// ─────────────────────────────────────────────
function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const el = document.getElementById('hdr-time');
    if (el) el.textContent = `🕐 ${hh}:${mm}:${ss}`;
}
setInterval(updateClock, 1000);
updateClock();

// ─────────────────────────────────────────────
// HELPERS HTTP
// ─────────────────────────────────────────────
async function apiGet(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function apiPost(path, body) {
    const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { data, status: res.status });
    return data;
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
    document.getElementById('toast-container').prepend(el);
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 350);
    }, duration);
}

// ─────────────────────────────────────────────
// RESULT BOX HELPER
// ─────────────────────────────────────────────
function showResult(id, msg, type = 'info') {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `result-box ${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 6000);
}

// ─────────────────────────────────────────────
// CARGAR ESTADO DE LOS SERVIDORES
// ─────────────────────────────────────────────
async function loadStatus() {
    try {
        const nodes = await apiGet('/api/status');
        allNodes = nodes;
        renderNodes(nodes);
        updateKPIs(nodes);
        updateSelectors(nodes);
        updateSystemBadge(true);
    } catch (e) {
        updateSystemBadge(false);
    }
}

function renderNodes(nodes) {
    const tbody = document.getElementById('nodes-tbody');
    const countEl = document.getElementById('naming-count');
    countEl.textContent = `${nodes.length} nodo${nodes.length !== 1 ? 's' : ''}`;

    if (nodes.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Sin nodos registrados. Inicia un miniServer para verlos aquí.</td></tr>`;
        return;
    }

    tbody.innerHTML = nodes.map(n => {
        const isActive = n.status === 'ACTIVO';
        const secs = n.secondsWithoutPulse || 0;
        const pulseClass = secs > 10 ? 'danger' : secs > 5 ? 'warn' : '';

        return `<tr>
            <td>
                <span class="status-badge ${isActive ? 'activo' : 'caido'}">
                    <span class="dot"></span>
                    ${n.status}
                </span>
            </td>
            <td style="font-weight:600; color:var(--text-primary)">${n.name}</td>
            <td>
                <span class="url-cell" title="${n.url}">${n.url}</span>
            </td>
            <td>
                <span class="platform-badge">${n.platform || 'N/A'}</span>
            </td>
            <td>
                <span class="pulse-counter ${pulseClass}">${secs}s</span>
            </td>
            <td>
                <button class="action-btn" onclick="quickSendTo('${n.name}')">✉ Mensaje</button>
                <button class="action-btn danger" onclick="quickSimulate('${n.name}')">⚡ Caída</button>
            </td>
        </tr>`;
    }).join('');
}

function updateKPIs(nodes) {
    const active = nodes.filter(n => n.status === 'ACTIVO').length;
    const fallen = nodes.filter(n => n.status === 'CAIDO').length;
    document.getElementById('kpi-total-val').textContent = nodes.length;
    document.getElementById('kpi-active-val').textContent = active;
    document.getElementById('kpi-fallen-val').textContent = fallen;
}

function updateSelectors(nodes) {
    const names = nodes.map(n => n.name);

    // msg-from
    const from = document.getElementById('msg-from');
    const fromVal = from.value;
    from.innerHTML = `<option value="">-- Selecciona remitente --</option>
        <option value="Admin">Admin (Panel Web)</option>
        ${names.map(n => `<option value="${n}" ${fromVal === n ? 'selected' : ''}>${n}</option>`).join('')}`;
    if (fromVal) from.value = fromVal;

    // msg-to
    const to = document.getElementById('msg-to');
    const toVal = to.value;
    to.innerHTML = `<option value="">-- Selecciona destinatario --</option>
        ${names.map(n => `<option value="${n}" ${toVal === n ? 'selected' : ''}>${n}</option>`).join('')}`;
    if (toVal) to.value = toVal;

    // hr-node
    const hr = document.getElementById('hr-node');
    const hrVal = hr.value;
    hr.innerHTML = `<option value="">-- Selecciona nodo --</option>
        ${names.map(n => `<option value="${n}" ${hrVal === n ? 'selected' : ''}>${n}</option>`).join('')}`;
    if (hrVal) hr.value = hrVal;

    // sim-node
    const sim = document.getElementById('sim-node');
    const simVal = sim.value;
    sim.innerHTML = `<option value="">-- Selecciona nodo --</option>
        ${names.map(n => `<option value="${n}" ${simVal === n ? 'selected' : ''}>${n}</option>`).join('')}`;
    if (simVal) sim.value = simVal;

    // inbox-node
    updateInboxSelector(nodes);
}

function updateSystemBadge(online) {
    const dot = document.querySelector('#sys-status-badge .pulse-dot');
    const text = document.getElementById('sys-status-text');
    if (online) {
        dot.className = 'pulse-dot active';
        text.textContent = 'Middleware Activo';
    } else {
        dot.className = 'pulse-dot fallen';
        text.textContent = 'Sin conexión';
    }
}

// Actualiza URL resuelta en el formulario de mensaje
function updateTargetUrl() {
    const to = document.getElementById('msg-to').value;
    const node = allNodes.find(n => n.name === to);
    const urlEl = document.getElementById('resolved-url');
    urlEl.value = node ? `${node.url}/receive-message` : '';
}

// ─────────────────────────────────────────────
// CARGAR LOGS DE OBSERVABILIDAD
// ─────────────────────────────────────────────
async function loadLogs() {
    try {
        const logs = await apiGet('/api/logs?limit=80');
        allLogs = logs;
        renderLogs(logs);
    } catch (e) {
        // silencioso
    }
}

function renderLogs(logs) {
    const terminal = document.getElementById('log-terminal');
    const filtered = logFilterType
        ? logs.filter(l => l.type === logFilterType)
        : logs;

    if (filtered.length === 0) {
        terminal.innerHTML = '<div class="terminal-placeholder">Sin actividad aún...</div>';
        return;
    }

    terminal.innerHTML = filtered.map(l => `
        <div class="log-line">
            <span class="log-time">${l.timeStr || l.timestamp?.substring(11, 19) || '--'}</span>
            <span class="log-type ${l.type}">${l.type}</span>
            <span class="log-server">[${l.server}]</span>
            <span class="log-msg">${l.message}</span>
        </div>
    `).join('');

    // Auto-scroll al top (los logs más nuevos están primero)
    terminal.scrollTop = 0;
}

function filterLogs() {
    logFilterType = document.getElementById('log-filter').value;
    renderLogs(allLogs);
}

function clearLogs() {
    document.getElementById('log-terminal').innerHTML =
        '<div class="terminal-placeholder">Consola limpiada localmente. Los logs del servidor siguen activos.</div>';
    allLogs = [];
}

// ─────────────────────────────────────────────
// CARGAR HISTORIAL DE MENSAJES
// ─────────────────────────────────────────────
async function loadMessages() {
    try {
        const msgs = await apiGet('/api/messages');
        allMessages = msgs;
        document.getElementById('kpi-msgs-val').textContent = msgs.length;
        renderMessages(msgs.slice(0, 30));
    } catch (e) {
        // silencioso
    }
}

function renderMessages(msgs) {
    const container = document.getElementById('msg-history');
    if (msgs.length === 0) {
        container.innerHTML = '<div class="empty-cell">Sin mensajes aún...</div>';
        return;
    }

    container.innerHTML = msgs.map(m => {
        const date = new Date(m.timestamp);
        const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        const statusClass = m.status === 'ENTREGADO' ? 'entregado' : m.status === 'FALLIDO' ? 'fallido' : 'transito';

        return `<div class="msg-item ${statusClass}">
            <div class="msg-meta">
                <span class="msg-from">📤 ${m.from}</span>
                <span class="msg-arrow">→</span>
                <span class="msg-to">📥 ${m.to}</span>
                <span class="msg-status-tag ${m.status}">${m.status}</span>
                <span class="msg-time">${timeStr}</span>
            </div>
            <div class="msg-content">"${m.message}"</div>
            ${m.targetUrl ? `<div class="msg-url">🌐 ${m.targetUrl}</div>` : ''}
            ${m.error ? `<div class="msg-url" style="color:var(--red)">❌ ${m.error}</div>` : ''}
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────
// ENVIAR MENSAJE DISTRIBUIDO
// ─────────────────────────────────────────────
async function sendMessage() {
    const from = document.getElementById('msg-from').value.trim();
    const to = document.getElementById('msg-to').value.trim();
    const msg = document.getElementById('msg-text').value.trim();

    if (!from) return toast('Selecciona un remitente', 'warning');
    if (!to) return toast('Selecciona un destinatario', 'warning');
    if (!msg) return toast('Escribe un mensaje', 'warning');

    const btn = document.getElementById('btn-send-msg');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
        const result = await apiPost('/api/send-message', { from, to, message: msg });

        if (result.success) {
            toast(`✅ Mensaje entregado a '${to}'`, 'success');
            showResult('send-result',
                `✅ Entregado a ${to}\n🌐 URL: ${result.entry?.targetUrl || 'N/A'}\n📬 Estado: ${result.entry?.status}`,
                'success');
            document.getElementById('msg-text').value = '';
        }

        await loadMessages();
        await loadLogs();
    } catch (e) {
        const errMsg = e.data?.error || e.message;
        toast(`❌ ${errMsg}`, 'error', 5000);
        showResult('send-result', `❌ Error: ${errMsg}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '➤ Enviar Mensaje';
    }
}

// ─────────────────────────────────────────────
// PRUEBA DE ROBUSTEZ: NOMBRE DUPLICADO
// ─────────────────────────────────────────────
async function testDuplicate() {
    const name = document.getElementById('dup-name').value.trim();
    const url = document.getElementById('dup-url').value.trim();

    if (!name || !url) return toast('Completa el nombre y la URL', 'warning');

    try {
        const result = await apiPost('/register', { name, url, platform: 'test' });
        showResult('dup-result',
            `⚠️ INESPERADO: El servidor aceptó el registro duplicado.\n${JSON.stringify(result, null, 2)}`,
            'warning');
        toast('El servidor aceptó el registro (posible fallo)', 'warning');
    } catch (e) {
        if (e.status === 409) {
            showResult('dup-result',
                `🔒 CORRECTO — Naming Service rechazó el nombre duplicado:\n\n${e.data?.error}\n\nCódigo: HTTP 409 Conflict\nURL activa: ${e.data?.activeUrl || 'N/A'}`,
                'success');
            toast('✅ Naming Service funcionó correctamente (409 rechazado)', 'success', 5000);
        } else {
            showResult('dup-result', `Error inesperado: ${e.message}`, 'error');
        }
    }
}

// ─────────────────────────────────────────────
// HOTRELOAD
// ─────────────────────────────────────────────
async function doHotreload() {
    const name = document.getElementById('hr-node').value;
    const newUrl = document.getElementById('hr-new-url').value.trim();

    if (!name) return toast('Selecciona un nodo', 'warning');
    if (!newUrl) return toast('Ingresa la nueva URL', 'warning');

    try {
        const result = await apiPost(`/hotreload/${name}`, { newUrl });
        toast(`🔄 URL de '${name}' actualizada en caliente`, 'success');
        showResult('hr-result',
            `✅ Hotreload exitoso\n🔗 URL anterior: ${result.previousUrl}\n🔗 Nueva URL:    ${result.currentUrl}`,
            'success');
        await loadStatus();
        await loadLogs();
    } catch (e) {
        toast(`❌ ${e.data?.error || e.message}`, 'error');
        showResult('hr-result', `❌ Error: ${e.data?.error || e.message}`, 'error');
    }
}

async function doParentHotreload() {
    const newParentUrl = document.getElementById('hr-parent-url').value.trim();
    if (!newParentUrl) return toast('Ingresa la nueva URL del padre', 'warning');

    try {
        const result = await apiPost('/api/hotreload-parent', { newParentUrl });
        toast('🔄 URL del Middleware actualizada en caliente', 'success');
        showResult('hr-parent-result',
            `✅ URL del Padre actualizada\n🔗 Anterior: ${result.previousParentUrl}\n🔗 Nueva:    ${result.currentParentUrl}`,
            'success');
        await loadLogs();
    } catch (e) {
        toast(`❌ ${e.data?.error || e.message}`, 'error');
        showResult('hr-parent-result', `❌ Error: ${e.data?.error || e.message}`, 'error');
    }
}

// ─────────────────────────────────────────────
// SIMULADOR DE CAÍDAS Y TIMEOUT
// ─────────────────────────────────────────────
async function simulateFall() {
    const name = document.getElementById('sim-node').value;
    if (!name) return toast('Selecciona un nodo', 'warning');

    try {
        const result = await apiPost(`/api/simulate-failure/${name}`, {});
        toast(`🔴 Nodo '${name}' marcado como CAÍDO`, 'warning', 4000);
        showResult('sim-result',
            `🔴 Nodo '${name}' marcado como CAÍDO.\nEste es el resultado del Timeout detectado por el Middleware.\nEspera unos segundos para ver el cambio en el Naming Service.`,
            'warning');
        setTimeout(async () => { await loadStatus(); await loadLogs(); }, 1000);
    } catch (e) {
        toast(`❌ ${e.data?.error || e.message}`, 'error');
    }
}

async function sendStopPulse() {
    const name = document.getElementById('sim-node').value;
    if (!name) return toast('Selecciona un nodo', 'warning');

    const node = allNodes.find(n => n.name === name);
    if (!node) return toast('Nodo no encontrado', 'warning');

    try {
        const url = node.url.replace(/\/$/, '');
        const res = await fetch(`${url}/stop-pulse`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        toast(`⛔ Pulso de '${name}' detenido — el Timeout lo detectará en ~15s`, 'warning', 5000);
        showResult('sim-result',
            `⛔ Pulso de '${name}' detenido.\n\nEl Middleware detectará la caída en aprox. 15 segundos y cambiará el estado a CAÍDO.\n\nUsa 'Reanudar Pulso' para recuperarlo.`,
            'warning');
    } catch (e) {
        toast(`❌ No se pudo alcanzar el nodo '${name}': ${e.message}`, 'error', 5000);
        showResult('sim-result', `❌ No se pudo conectar al nodo '${name}' en ${node.url}.\nVerifica que el miniServer esté corriendo.`, 'error');
    }
}

async function sendStartPulse() {
    const name = document.getElementById('sim-node').value;
    if (!name) return toast('Selecciona un nodo', 'warning');

    const node = allNodes.find(n => n.name === name);
    if (!node) return toast('Nodo no encontrado', 'warning');

    try {
        const url = node.url.replace(/\/$/, '');
        await fetch(`${url}/start-pulse`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        toast(`💓 Pulso de '${name}' reanudado — volverá a ACTIVO pronto`, 'success', 4000);
        showResult('sim-result',
            `💓 Pulso de '${name}' reanudado.\n\nEl Middleware actualizará el estado a ACTIVO al recibir el próximo latido.`,
            'success');
    } catch (e) {
        toast(`❌ No se pudo conectar al nodo '${name}': ${e.message}`, 'error');
    }
}

// ─────────────────────────────────────────────
// ACCIONES RÁPIDAS DESDE LA TABLA DE NODOS
// ─────────────────────────────────────────────
function quickSendTo(name) {
    document.getElementById('msg-to').value = name;
    updateTargetUrl();
    document.getElementById('section-messaging').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('msg-text').focus();
}

function quickSimulate(name) {
    document.getElementById('sim-node').value = name;
    document.getElementById('section-simulator').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────
// POLLING PRINCIPAL
// ─────────────────────────────────────────────
async function tick() {
    await loadStatus();
    await loadLogs();
    await loadMessages();
}

// Uptime display
async function loadUptime() {
    try {
        const data = await apiGet('/api/observability');
        const secs = data.system.uptimeSeconds;
        const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
        const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
        const ss = String(secs % 60).padStart(2, '0');
        const el = document.getElementById('hdr-uptime');
        if (el) el.textContent = `⏱ ${hh}:${mm}:${ss}`;
    } catch (e) {
        // silencioso
    }
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
(async function init() {
    await tick();
    setInterval(tick, 4000);
    setInterval(loadUptime, 5000);
    loadUptime();
    toast('Panel de Observabilidad conectado', 'success', 2500);
})();
