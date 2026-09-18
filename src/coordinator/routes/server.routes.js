/**
 * server.routes.js — Rutas del Naming Service, mensajería, hotreload y observabilidad
 * (Migración y extensión del server.js original)
 */
const express  = require("express");
const axios    = require("axios");
const registry = require("../services/registry");
const msgStore = require("../services/messages");
const engine   = require("../election/engine");
const config   = require("../config");
const logger   = require("../utils/logger");

const router = express.Router();

// ─── MIDDLEWARE DE LIDERAZGO (Fase 4: Que solo mande el líder) ────────────────
const ensureLeader = (req, res, next) => {
    // 1. Si soy el líder, proceso la petición normal
    if (engine.role === "leader") return next();

    // 2. Si no soy líder, preparo la respuesta con el líder actual y los peers
    const peers = engine.knownPeers().map(p => ({ id: p.id, url: p.url, alive: Boolean(p.alive) }));

    if (engine.leaderUrl) {
        // Sé quién es el líder → 409 (Redirección con nombre del líder y URL)
        return res.status(409).json({ 
            leader: engine.leaderId,
            leaderUrl: engine.leaderUrl, 
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
 * GET /resolve/:name — Resuelve nombre → URL
 */
router.get("/resolve/:name", (req, res) => {
    const w = registry.resolve(req.params.name);
    if (!w) return res.status(404).json({ error: `Nombre '${req.params.name}' no encontrado` });
    res.json({ name: w.name, url: w.url, status: w.status, lastHeartbeat: w.lastHeartbeat });
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
    res.json({ message: "Pulso recibido", status: "ACTIVO", lastHeartbeat: w.lastHeartbeat });
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
        const engine = require("../election/engine").engine;
        const peer = engine.knownPeers().find(p => p.id === to || p.url === to);
        if (peer) {
            targetUrl = peer.url;
            targetStatus = peer.alive ? "ACTIVO" : "CAIDO";
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
        logger.msg("Mensajería", `Mensaje de '${from}' entregado a '${to}' (${target.url})`);
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
    res.json(registry.list().map(w => ({
        name: w.name, url: w.url, status: w.status,
        platform: w.platform, hostname: w.hostname,
        hasPulse: (now - w.lastHeartbeat) <= config.workerTimeoutMs,
        secondsWithoutPulse: Math.floor((now - w.lastHeartbeat) / 1000),
        lastHeartbeat: w.lastHeartbeat,
        lastMessage: w.messages?.at(-1) || null,
    })));
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
