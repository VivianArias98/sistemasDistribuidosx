/**
 * server.routes.js — Rutas del Naming Service, mensajería, hotreload y observabilidad
 * (Migración y extensión del server.js original)
 */
const express  = require("express");
const axios    = require("axios");
const registry = require("../services/registry");
const msgStore = require("../services/messages");
const { engine } = require("../election/engine");
const config   = require("../config");
const logger   = require("../utils/logger");

const router = express.Router();

// ─── MIDDLEWARE DE LIDERAZGO (Fase 4: Que solo mande el líder) ────────────────
const ensureLeader = (req, res, next) => {
    // 1. Si soy el líder, proceso la petición normal
    if (engine.role === "leader") return next();

    // 2. Si no soy líder, preparo la respuesta con el líder actual y los peers
    // La diapositiva indica que 'peers' debe ser un arreglo de strings (URLs)
    const peers = engine.knownPeers().map(p => p.url);

    if (engine.leaderUrl) {
        // Sé quién es el líder → 409 (Redirección con URL del líder)
        return res.status(409).json({ 
            leader: engine.leaderUrl,
            peers 
        });
    } else {
        // No hay líder aún (elección en curso) → 503 (Reintento)
        return res.status(503).json({ 
            retry: true, 
            peers 
        });
    }
};

// ─── NAMING SERVICE ───────────────────────────────────────────────────────────

/**
 * POST /register — Registra un worker con ownership por IP
 */
router.post("/register", ensureLeader, (req, res) => {
    let { name, url, platform, hostname } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: "El campo 'name' es obligatorio" });
    if (!url?.trim())  return res.status(400).json({ error: "El campo 'url' es obligatorio" });

    name = name.trim();
    url  = url.trim();
    const ip = registry.clientIp(req);

    // ── Bloquear auto-registro: un nodo no puede registrarse con el mismo ID que este servidor
    if (engine.selfId && engine.selfId !== "UNCONFIGURED" && name === engine.selfId) {
        logger.info("Registry", `Registro rechazado: ID '${name}' es el mismo que este servidor (auto-registro ignorado)`);
        return res.status(200).json({ message: `Auto-registro de '${name}' ignorado`, status: "ACTIVO" });
    }

    try {
        const { worker, created, reactivated } = registry.register(name, url, ip, { platform, hostname });
        const code = created ? 201 : 200;
        const msg  = created       ? `Worker '${name}' registrado exitosamente`
                   : reactivated   ? `Worker '${name}' reactivado exitosamente`
                   :                 `Worker '${name}' reconectado exitosamente`;
        return res.status(code).json({ message: msg, status: "ACTIVO", worker });
    } catch (err) {
        if (err.code === "IP_CONFLICT") {
            return res.status(409).json({ error: err.message, code: "IP_CONFLICT" });
        }
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Resuelve un nombre o URL de forma distribuida, consultando a los vecinos si no está local
 */
async function resolveWithNeighbors(targetName, visited = []) {
    const cleanTarget = String(targetName || "").trim();
    if (!cleanTarget) return null;

    // 1. Búsqueda local en Naming Service (Workers)
    const localWorker = registry.resolve(cleanTarget);
    if (localWorker) {
        return {
            name: localWorker.name,
            url: localWorker.url,
            status: localWorker.status,
            role: "worker",
            source: "local",
            via: "local-naming"
        };
    }

    // 2. Búsqueda local en Peers del Clúster
    const peers = engine.knownPeers ? engine.knownPeers() : [];
    const directPeer = peers.find(p => 
        (p.id && p.id.toLowerCase() === cleanTarget.toLowerCase()) || 
        (p.url && (p.url === cleanTarget || p.url.replace(/\/$/, "") === cleanTarget.replace(/\/$/, "")))
    );
    if (directPeer) {
        return {
            name: directPeer.id,
            url: directPeer.url,
            status: directPeer.alive ? "ACTIVO" : "CAIDO",
            role: directPeer.snapshot?.role || (directPeer.id === engine.leaderId ? "leader" : "follower"),
            source: "local-peer",
            via: "direct-connection"
        };
    }

    // 3. Búsqueda Distribuida en URLs de Vecinos
    const selfUrl = engine.selfUrl ? engine.selfUrl.replace(/\/$/, "") : "";
    const visitedSet = new Set([...visited, selfUrl].filter(Boolean));
    const activePeers = peers.filter(p => p.alive && p.url && !visitedSet.has(p.url.replace(/\/$/, "")));

    for (const peer of activePeers) {
        const peerUrl = peer.url.replace(/\/$/, "");
        visitedSet.add(peerUrl);

        try {
            const visitedParam = encodeURIComponent([...visitedSet].join(","));
            const resp = await axios.get(`${peerUrl}/resolve/${encodeURIComponent(cleanTarget)}?visited=${visitedParam}`, {
                timeout: 2500,
                headers: { "ngrok-skip-browser-warning": "true" }
            });

            if (resp.data && resp.data.url) {
                return {
                    name: resp.data.name || cleanTarget,
                    url: resp.data.url,
                    status: resp.data.status || "ACTIVO",
                    role: resp.data.role || "worker",
                    source: "vecino",
                    via: peer.id || peer.url,
                    hops: (resp.data.hops || 0) + 1
                };
            }
        } catch (_) {}
    }

    return null;
}

/**
 * GET /resolve/:name — Resuelve nombre → URL con búsqueda por vecinos distribuida
 */
router.get("/resolve/:name", async (req, res) => {
    const target = req.params.name;
    const visitedParam = req.query.visited || "";
    const visited = visitedParam ? visitedParam.split(",").map(u => u.trim()).filter(Boolean) : [];

    // Si viene con visited, es consulta interna de un vecino -> solo responder local
    if (visited.length > 0) {
        const localWorker = registry.resolve(target);
        if (localWorker) {
            return res.json({ 
                name: localWorker.name, 
                url: localWorker.url, 
                status: localWorker.status, 
                role: "worker", 
                source: "local" 
            });
        }
        const peers = engine.knownPeers ? engine.knownPeers() : [];
        const directPeer = peers.find(p => (p.id && p.id.toLowerCase() === target.toLowerCase()) || p.url === target);
        if (directPeer) {
            return res.json({ 
                name: directPeer.id, 
                url: directPeer.url, 
                status: directPeer.alive ? "ACTIVO" : "CAIDO", 
                role: directPeer.snapshot?.role || "follower", 
                source: "peer" 
            });
        }
        return res.status(404).json({ error: `Nombre '${target}' no encontrado en este nodo` });
    }

    try {
        const found = await resolveWithNeighbors(target, visited);
        if (found) {
            return res.json(found);
        }
        return res.status(404).json({ error: `Nombre o URL '${target}' no encontrado localmente ni en vecinos` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/search-neighbors?q=query — Busca nodos y URLs en local y en la red de vecinos
 */
router.get("/api/search-neighbors", async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const results = [];
    const seenUrls = new Set();
    const selfUrl = engine.selfUrl ? engine.selfUrl.replace(/\/$/, "").toLowerCase() : "";
    if (selfUrl) seenUrls.add(selfUrl);

    // 1. Workers locales
    for (const w of registry.list()) {
        const normUrl = w.url ? w.url.replace(/\/$/, "").toLowerCase() : "";
        if (normUrl && normUrl === selfUrl) continue;
        if (!q || (w.name && w.name.toLowerCase().includes(q)) || (w.url && w.url.toLowerCase().includes(q))) {
            if (normUrl) seenUrls.add(normUrl);
            results.push({
                name: w.name,
                url: w.url,
                role: w.role || "worker",
                status: w.status,
                source: "Local (Servidor Propio)",
                hops: 0
            });
        }
    }

    // 2. Peers locales
    const peers = engine.knownPeers ? engine.knownPeers() : [];
    for (const p of peers) {
        const normUrl = p.url ? p.url.replace(/\/$/, "").toLowerCase() : "";
        if (normUrl && normUrl === selfUrl) continue;
        if (!q || (p.id && p.id.toLowerCase().includes(q)) || (p.url && p.url.toLowerCase().includes(q))) {
            if (normUrl && !seenUrls.has(normUrl)) {
                seenUrls.add(normUrl);
                results.push({
                    name: p.id || p.url,
                    url: p.url,
                    role: p.snapshot?.role || (p.id === engine.leaderId ? "leader" : "follower"),
                    status: p.alive ? "CONECTADO" : "CAÍDO",
                    source: "Vecino Directo",
                    hops: 1
                });
            }
        }
    }

    // 3. Consultar vecinos en paralelo
    const neighborQueries = peers.filter(p => p.alive && p.url && p.url.replace(/\/$/, "").toLowerCase() !== selfUrl).map(async (peer) => {
        try {
            const cleanPeerUrl = peer.url.replace(/\/$/, "");
            const resp = await axios.get(`${cleanPeerUrl}/api/status`, {
                timeout: 2500,
                headers: { "ngrok-skip-browser-warning": "true" }
            });
            if (Array.isArray(resp.data)) {
                for (const item of resp.data) {
                    const normUrl = item.url ? item.url.replace(/\/$/, "").toLowerCase() : "";
                    if (!normUrl || normUrl === selfUrl) continue;
                    if (!q || (item.name && item.name.toLowerCase().includes(q)) || (item.url && item.url.toLowerCase().includes(q))) {
                        if (!seenUrls.has(normUrl)) {
                            seenUrls.add(normUrl);
                            results.push({
                                name: item.name,
                                url: item.url,
                                role: item.role || "worker",
                                status: item.status || "ACTIVO",
                                source: `A través de vecino: ${peer.id || peer.url}`,
                                hops: 2
                            });
                        }
                    }
                }
            }
        } catch (_) {}
    });

    await Promise.all(neighborQueries);
    res.json({ query: q, total: results.length, results });
});

/**
 * POST /api/discover-neighbors — Explora y descubre los vecinos conocidos de una URL
 */
router.post("/api/discover-neighbors", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Se requiere el parámetro 'url'" });

    const cleanUrl = url.trim().replace(/\/$/, "");
    try {
        const [clusterResp, statusResp] = await Promise.allSettled([
            axios.get(`${cleanUrl}/cluster`, { timeout: 3000, headers: { "ngrok-skip-browser-warning": "true" } }),
            axios.get(`${cleanUrl}/api/status`, { timeout: 3000, headers: { "ngrok-skip-browser-warning": "true" } })
        ]);

        const discoveredPeers = [];
        const discoveredWorkers = [];

        if (clusterResp.status === "fulfilled" && clusterResp.value.data) {
            const data = clusterResp.value.data;
            if (data.self && data.self.url) {
                discoveredPeers.push({
                    id: data.self.id,
                    url: data.self.url,
                    role: data.self.role,
                    isHost: true
                });
            }
            if (Array.isArray(data.peers)) {
                for (const p of data.peers) {
                    discoveredPeers.push({
                        id: p.id,
                        url: p.url,
                        alive: p.alive,
                        role: p.snapshot?.role || "peer"
                    });
                }
            }
        }

        if (statusResp.status === "fulfilled" && Array.isArray(statusResp.value.data)) {
            for (const w of statusResp.value.data) {
                discoveredWorkers.push({
                    name: w.name,
                    url: w.url,
                    status: w.status,
                    role: w.role || "worker"
                });
            }
        }

        res.json({
            seedUrl: cleanUrl,
            peersCount: discoveredPeers.length,
            workersCount: discoveredWorkers.length,
            peers: discoveredPeers,
            workers: discoveredWorkers
        });
    } catch (err) {
        res.status(502).json({ error: `No se pudo consultar al vecino ${cleanUrl}: ${err.message}` });
    }
});

/**
 * GET /naming  /servers — Directorio completo
 */
router.get(["/naming", "/servers"], (_req, res) => {
    const now = Date.now();
    res.json(registry.list().map(w => ({
        name: w.name, url: w.url, status: w.status,
        platform: w.platform, hostname: w.hostname,
        lastHeartbeat: w.lastHeartbeat,
        secondsWithoutPulse: Math.floor((now - w.lastHeartbeat) / 1000),
        registeredAt: w.registeredAt,
        messagesCount: (w.messages || []).length,
    })));
});

/**
 * POST /unregister/:name — Desregistro voluntario
 */
router.post("/unregister/:name", (req, res) => {
    const ok = registry.unregister(req.params.name);
    if (!ok) return res.status(404).json({ error: `Worker '${req.params.name}' no encontrado` });
    res.json({ message: `Worker '${req.params.name}' desregistrado` });
});

// ─── HEARTBEAT / PULSE ────────────────────────────────────────────────────────

router.post(["/heartbeat/:name", "/pulse/:name"], ensureLeader, (req, res) => {
    const w = registry.pulse(req.params.name);
    if (!w) return res.status(404).json({ error: `Worker '${req.params.name}' no registrado`, mustRegister: true });
    
    // Adjuntar la vista del clúster (Fase 4 y 5)
    res.json({ 
        message: "Pulse received", 
        leader: engine.selfUrl,
        peers: engine.knownPeers().map(p => p.url),
        status: "ACTIVO", 
        lastHeartbeat: w.lastHeartbeat 
    });
});

// ─── MENSAJERÍA ───────────────────────────────────────────────────────────────

/**
 * POST /send-message/:name — Mensaje simple de un worker al coordinador
 */
router.post("/send-message/:name", ensureLeader, (req, res) => {
    const name = req.params.name;
    const { message } = req.body;
    const ip = registry.clientIp(req);

    const w = registry.resolve(name);
    if (!w) return res.status(404).json({ error: "Worker remitente no registrado" });

    // Verificar IP ownership
    if (w.ip && w.ip !== ip) {
        return res.status(403).json({ error: `IP ${ip} no autorizada para el worker '${name}'` });
    }
    if (!message) return res.status(400).json({ error: "El campo 'message' es obligatorio" });

    const entry = msgStore.add({ from: name, to: "Coordinador", message, status: "ENTREGADO" });
    registry.addMessage(name, entry);
    logger.msg("Mensajería", `Mensaje de '${name}': "${message}"`);
    res.json({ status: "ok", received: true, entry });
});

/**
 * POST /receive-message — Para recibir mensajes de otros nodos (Coordinadores o Workers)
 */
router.post("/receive-message", (req, res) => {
    const { from, to, message, timestamp } = req.body;
    if (!message) return res.status(400).json({ error: "Falta 'message'" });
    
    const entry = msgStore.add({ 
        from: from || "Desconocido", 
        to: to || "Coordinador", 
        message, 
        status: "ENTREGADO" 
    });
    
    logger.msg("Mensajería", `📥 Mensaje directo de '${entry.from}': "${message}"`);
    res.json({ success: true, receivedAt: entry.receivedAt });
});

/**
 * POST /api/send-message — Enrutamiento nodo a nodo via Naming Service
 */
router.post("/api/send-message", async (req, res) => {
    const { from, to, message } = req.body;
    if (!from || !to || !message) {
        return res.status(400).json({ error: "Se requieren 'from', 'to' y 'message'" });
    }

    const entry = msgStore.add({ from, to, message, status: "EN_TRANSITO" });

    if (to === "Coordinador" || to === "Todos") {
        entry.status = "ENTREGADO";
        logger.msg("Mensajería", `Mensaje de '${from}' para '${to}': "${message}"`);
        return res.json({ success: true, entry });
    }

    let targetUrl = null;
    let targetStatus = "ACTIVO";

    // 1. Buscar en Naming Service (Workers)
    const workerTarget = registry.resolve(to);
    if (workerTarget) {
        targetUrl = workerTarget.url;
        targetStatus = workerTarget.status;
    } else {
        // 2. Buscar en el Engine (Otros Coordinadores)
        const peer = engine.knownPeers().find(p => p.id === to || p.url === to);
        if (peer) {
            targetUrl = peer.url;
            targetStatus = peer.alive ? "ACTIVO" : "CAIDO";
        } else {
            // 3. Búsqueda distribuida en Vecinos
            const neighborResult = await resolveWithNeighbors(to);
            if (neighborResult && neighborResult.url) {
                targetUrl = neighborResult.url;
                targetStatus = neighborResult.status;
                logger.msg("Mensajería", `Destinatario '${to}' localizado en vecino (${neighborResult.via}) → ${targetUrl}`);
            }
        }
    }

    if (!targetUrl) {
        entry.status = "FALLIDO";
        entry.error  = `Destinatario '${to}' no encontrado en el sistema`;
        return res.status(404).json({ error: entry.error, entry });
    }
    if (targetStatus === "CAIDO") {
        entry.status = "FALLIDO";
        entry.error  = `El destinatario '${to}' está CAÍDO`;
        return res.status(503).json({ error: entry.error, entry, recipientStatus: "CAIDO" });
    }

    try {
        const endpoint = targetUrl.replace(/\/$/, "") + "/receive-message";
        const axios = require("axios");
        const resp = await axios.post(endpoint, { from, to, message, timestamp: entry.timestamp }, { 
            timeout: 4000,
            headers: { "ngrok-skip-browser-warning": "true" }
        });
        entry.status    = "ENTREGADO";
        entry.targetUrl = targetUrl;
        registry.addMessage(to, entry);
        logger.msg("Mensajería", `Mensaje de '${from}' entregado a '${to}' (${targetUrl})`);
        return res.json({ success: true, entry, destinationResponse: resp.data });
    } catch (err) {
        entry.status = "FALLIDO";
        entry.error  = err.message;
        return res.status(502).json({ error: entry.error, entry });
    }
});

/**
 * GET /messages  /api/messages — Historial de mensajes
 */
router.get(["/messages", "/api/messages"], (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.json(msgStore.getAll(limit));
});

// ─── HOTRELOAD ────────────────────────────────────────────────────────────────

router.post(["/hotreload/:name", "/servers/:name/url"], (req, res) => {
    const { name } = req.params;
    const targetUrl = (req.body.newUrl || req.body.url || "").trim();
    const w = registry.resolve(name);
    if (!w) return res.status(404).json({ error: `Worker '${name}' no encontrado` });
    if (!targetUrl) return res.status(400).json({ error: "Se requiere 'newUrl' o 'url'" });

    const prev = w.url;
    w.url = targetUrl;
    w.lastHeartbeat = Date.now();
    logger.info("HotReload", `URL de '${name}' actualizada: ${prev} → ${targetUrl}`);
    res.json({ success: true, previousUrl: prev, currentUrl: targetUrl });
});

// ─── OBSERVABILIDAD ───────────────────────────────────────────────────────────

/**
 * GET /api/status — Estado consolidado de workers
 */
router.get("/api/status", (req, res) => {
    const now = Date.now();
    const clusterPeers = engine.knownPeers ? engine.knownPeers() : [];
    
    // Excluir al propio nodo de la lista de "Conectados a mí"
    // Usar OR: si coincide el nombre O la URL, se considera el propio nodo y se excluye
    const selfId  = engine.selfId  || "";
    const selfUrl = (engine.selfUrl || "").replace(/\/$/, "");
    const validWorkers = registry.list().filter(w => {
        const wName = w.name || "";
        const wUrl  = (w.url  || "").replace(/\/$/, "");
        return wName !== selfId && wUrl !== selfUrl;
    });
    
    res.json(validWorkers.map(w => {
        let role = w.role || "worker";
        const peer = clusterPeers.find(p => p.url === w.url || p.id === w.name);
        if (peer) {
            if (peer.id === engine.leaderId || (peer.snapshot && peer.snapshot.role === "leader")) {
                role = "leader";
            } else if (peer.snapshot?.role) {
                role = peer.snapshot.role;
            } else {
                role = "follower";
            }
        }

        return {
            name: w.name, 
            url: w.url, 
            status: w.status,
            role,
            platform: w.platform, 
            hostname: w.hostname,
            hasPulse: (now - w.lastHeartbeat) <= config.workerTimeoutMs,
            secondsWithoutPulse: Math.floor((now - w.lastHeartbeat) / 1000),
            lastHeartbeat: w.lastHeartbeat,
            lastMessage: w.messages?.at(-1) || null,
        };
    }));
});

/**
 * GET /overview — Alias clásico
 */
router.get("/overview", (req, res) => {
    res.json({
        workers: registry.list().map(w => ({ name: w.name, url: w.url, status: w.status, messages: w.messages })),
        messages: msgStore.getAll(50),
    });
});

/**
 * POST /api/simulate-failure/:name — Simular caída manual
 */
router.post("/api/simulate-failure/:name", (req, res) => {
    const w = registry.markFallen(req.params.name);
    if (!w) return res.status(404).json({ error: "Worker no encontrado" });
    logger.timeout("Debug", `Caída simulada manualmente: ${req.params.name}`);
    res.json({ message: `Worker '${req.params.name}' marcado como CAIDO`, status: "CAIDO" });
});

module.exports = router;
