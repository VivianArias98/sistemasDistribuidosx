/* ═══════════════════════════════════════════════════════════
   election.js — Lógica del Dashboard de Elección y Topología
   ═══════════════════════════════════════════════════════════ */

const SVG_NS = "http://www.w3.org/2000/svg";
const POLL_INTERVAL = 3000;

// Estado
let selfNode = null;
let peers = [];
let clusterInfo = {};

// Elementos SVG
const svgNodes = document.getElementById("topo-nodes");
const svgEdges = document.getElementById("topo-edges");

const $ = id => document.getElementById(id);

// ─── INIT ────────────────────────────────────────────────
async function init() {
    await fetchState();
    connectSSE();
    setInterval(fetchState, POLL_INTERVAL);
}

// ─── SSE STREAM ──────────────────────────────────────────
function connectSSE() {
    const src = new EventSource("/events");
    src.onmessage = e => {
        try {
            const ev = JSON.parse(e.data);
            appendLog(ev);
            if (ev.type === "peer-down" || ev.type === "peer-up" || ev.type === "election-won") {
                fetchState(); // Refrescar rápido si hay cambios de topología
            }
        } catch {}
    };
}

// ─── OBTENER ESTADO ──────────────────────────────────────
async function fetchState() {
    try {
        const [r1, r2] = await Promise.all([
            fetch("/election/state").then(r => r.json()),
            fetch("/cluster").then(r => r.json())
        ]);
        selfNode = r1;
        peers = r2.peers || [];
        clusterInfo = r2.cluster || {};
        
        updatePanel();
        renderTopology();
    } catch (err) {
        console.error("Error obteniendo estado:", err);
    }
}

// ─── ACTUALIZAR PANEL LATERAL ────────────────────────────
function updatePanel() {
    if (!selfNode) return;
    
    // Header
    $("leader-id").textContent = clusterInfo.leader || clusterInfo.leaderId || "Buscando...";
    $("term-val").textContent = selfNode.term ?? clusterInfo.term ?? 0;
    $("splitbrain-alert").style.display = clusterInfo.splitBrain ? "block" : "none";
    
    // Card "Este Nodo"
    $("self-id").textContent = selfNode.id;
    $("self-role").textContent = selfNode.role;
    $("self-url").textContent = selfNode.url;
    $("self-leader").textContent = selfNode.leader || selfNode.leaderId || "Ninguno";
    $("self-uptime").textContent = selfNode.uptime != null ? Math.floor(selfNode.uptime) + "s" : "—";
    
    // Faults Status
    const f = selfNode.faults || {};
    $("fault-paused").style.display = f.paused ? "block" : "none";
    $("fault-drop").style.display = f.dropRate > 0 ? "block" : "none";
    $("fault-latency").style.display = f.latencyMs > 0 ? "block" : "none";
}

// ─── TOPOLOGÍA SVG ───────────────────────────────────────
function renderTopology() {
    if (!selfNode) return;
    
    const w = $("topo-svg").clientWidth;
    const h = $("topo-svg").clientHeight;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 3;
    
    // Preparar lista de todos los nodos
    const all = [
        { id: selfNode.id, url: selfNode.url, role: selfNode.role, isSelf: true, alive: true },
        ...peers.map(p => ({
            id: p.id, url: p.url, role: (p.snapshot && p.snapshot.role) || "follower",
            isSelf: false, alive: p.alive
        }))
    ];
    
    // Ordenar alfabéticamente/numéricamente para posiciones estables
    all.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    
    svgNodes.innerHTML = "";
    svgEdges.innerHTML = "";
    
    const positions = new Map();
    
    // Calcular posiciones circulares
    all.forEach((node, i) => {
        const angle = (i * (2 * Math.PI) / all.length) - (Math.PI / 2);
        const nx = cx + r * Math.cos(angle);
        const ny = cy + r * Math.sin(angle);
        positions.set(node.id, { x: nx, y: ny });
    });
    
    // Dibujar enlaces (Mesh completa)
    all.forEach(n1 => {
        all.forEach(n2 => {
            if (n1.id >= n2.id) return;
            const p1 = positions.get(n1.id);
            const p2 = positions.get(n2.id);
            
            const line = document.createElementNS(SVG_NS, "line");
            line.setAttribute("x1", p1.x);
            line.setAttribute("y1", p1.y);
            line.setAttribute("x2", p2.x);
            line.setAttribute("y2", p2.y);
            
            // Estilo de línea según estado
            if (!n1.alive || !n2.alive) {
                line.setAttribute("stroke", "rgba(255,255,255,0.05)");
                line.setAttribute("stroke-dasharray", "4");
            } else {
                line.setAttribute("stroke", "rgba(124,107,255,0.2)");
            }
            line.setAttribute("stroke-width", "2");
            svgEdges.appendChild(line);
        });
    });
    
    // Dibujar nodos
    all.forEach(node => {
        const p = positions.get(node.id);
        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
        
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("r", "24");
        circle.setAttribute("class", "topo-node-circle");
        
        // Estilos según rol y estado
        if (!node.alive) {
            circle.setAttribute("fill", "rgba(241,78,110,0.1)");
            circle.setAttribute("stroke", "rgba(241,78,110,0.5)");
        } else if (node.role === "leader") {
            circle.setAttribute("fill", "rgba(251,191,36,0.15)");
            circle.setAttribute("stroke", "var(--yellow)");
            circle.setAttribute("stroke-width", "3");
            circle.setAttribute("filter", "url(#glow-leader)");
        } else if (node.role === "candidate") {
            circle.setAttribute("fill", "rgba(251,146,60,0.15)");
            circle.setAttribute("stroke", "var(--orange)");
        } else {
            circle.setAttribute("fill", "rgba(34,211,238,0.1)");
            circle.setAttribute("stroke", "rgba(34,211,238,0.4)");
            if (node.isSelf) circle.setAttribute("filter", "url(#glow-node)");
        }
        
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("class", "topo-node-text");
        text.textContent = node.id;
        if (!node.alive) text.setAttribute("fill", "rgba(255,255,255,0.3)");
        
        const roleText = document.createElementNS(SVG_NS, "text");
        roleText.setAttribute("class", "topo-node-role");
        roleText.setAttribute("y", "38");
        roleText.textContent = node.role;
        roleText.setAttribute("fill", node.role === "leader" ? "var(--yellow)" : "var(--text-3)");
        
        g.appendChild(circle);
        g.appendChild(text);
        g.appendChild(roleText);
        svgNodes.appendChild(g);
    });
}

// ─── LOG DE EVENTOS ──────────────────────────────────────
function appendLog(ev) {
    const feed = $("log-feed");
    const placeholder = feed.querySelector(".log-placeholder");
    if (placeholder) placeholder.remove();

    const t = ev.ts ? new Date(ev.ts).toLocaleTimeString("es-MX", { hour12: false }) : "";
    const cssClass = ev.type || "default";
    const msg = ev.message || JSON.stringify(ev);

    const el = document.createElement("div");
    el.className = "log-ev";
    el.innerHTML = `
        <span class="log-ev-time">${t}</span>
        <span class="log-ev-type ${cssClass}">${ev.type}</span>
        <span class="log-ev-msg">${msg}</span>
    `;
    feed.prepend(el);

    while (feed.children.length > 50) feed.lastChild?.remove();
}

function clearLog() {
    $("log-feed").innerHTML = '<div class="log-placeholder">Esperando eventos del cluster...</div>';
}

// ─── CONTROLES DE API ────────────────────────────────────
async function apiCall(url, data) {
    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data || {})
        });
        const res = await r.json();
        if (r.ok) fetchState();
        else alert("Error: " + (res.error || "Desconocido"));
    } catch (e) {
        alert("Error de red: " + e.message);
    }
}

const triggerElection = () => apiCall("/election/trigger");
const pauseNode = () => apiCall("/debug/faults/pause");
const resumeNode = () => apiCall("/debug/faults/resume");
const healAll = () => apiCall("/debug/faults/heal");

const applyLatency = () => apiCall("/debug/faults/latency", { ms: parseInt($("latency-slider").value) });
const applyDropRate = () => apiCall("/debug/faults/drop-rate", { rate: parseInt($("droprate-slider").value) / 100 });
const applyPartition = () => {
    const url = $("partition-url").value.trim();
    if (url) apiCall("/debug/faults/partition", { target: url });
};

// ─── INICIO ──────────────────────────────────────────────
init();
