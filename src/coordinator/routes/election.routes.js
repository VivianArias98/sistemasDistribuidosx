/**
 * election.routes.js — Endpoints del protocolo de elección + SSE + cluster state
 *
 * Rutas:
 *  POST /election/message    — Mensajes del algoritmo Bully
 *  POST /election/ping       — Heartbeat gossip
 *  GET  /election/state      — Estado actual del nodo
 *  GET  /cluster             — Estado agregado del cluster
 *  POST /election/algorithm  — Cambiar algoritmo en caliente
 *  POST /election/trigger    — Forzar dimisión del líder
 *  GET  /events              — SSE stream
 */
const express   = require("express");
const { engine } = require("../election/engine");
const eventsModule = require("../election/events");
const strategies = require("../election/strategies");
const faults    = require("../election/faults");
const registry  = require("../services/registry");

const router = express.Router();

// ─── POST /election/message ───────────────────────────────────────────────────
router.post("/election/message", async (req, res) => {
    try {
        await engine.handleElectionMessage(req.body, res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ─── POST /election/ping (Gossip heartbeat) ───────────────────────────────────
router.post("/election/ping", (req, res) => {
    if (faults.paused) return res.status(503).json({ error: "Nodo pausado" });
    if (engine.selfId === "UNCONFIGURED") return res.status(503).json({ error: "Nodo no configurado" });

    const { id, url, peers: remotePeers = [] } = req.body;

    // Filtrar IDs numéricos y URLs para que los workers/puertos fantasma no entren a la lista de peers del cluster
    // Un ID válido debe ser texto corto (ej. "A", "B", "Nodo1") y no ser una URL.
    const isValidPeer = (peerId) => {
        if (!peerId) return false;
        if (typeof peerId === "object") return false; // Bloquea objetos puros
        if (String(peerId) === "[object Object]") return false; // Bloquea objetos stringificados
        if (!isNaN(Number(peerId))) return false; // Bloquea 3000, 3002
        if (String(peerId).startsWith("http")) return false; // Bloquea URLs
        if (String(peerId).length > 20) return false; // Bloquea strings larguísimos basura
        return true;
    };

    // Descubrimiento transitivo: incorporar peers del emisor
    if (url && isValidPeer(id)) {
        engine.upsertPeer(id, url);
        // Auto-registrar en Naming Service para que aparezca en "Quién se conecta a mi servidor"
        try {
            const ip = registry.clientIp(req);
            if (registry.resolve(id)) {
                registry.pulse(id);
            } else {
                registry.register(id, url, ip, { platform: "coordinador-peer", hostname: id });
            }
        } catch (_) {
            try { registry.pulse(id); } catch (__) {}
        }
    }
    
    for (const p of remotePeers) {
        if (p.url && p.url !== engine.selfUrl && isValidPeer(p.id)) {
            engine.upsertPeer(p.id, p.url);
        }
    }

    res.json(engine.snapshot());
});

// ─── GET /election/state ──────────────────────────────────────────────────────
router.get("/election/state", (req, res) => {
    res.json(engine.snapshot());
});

// ─── GET /cluster — Estado agregado del cluster ───────────────────────────────
router.get("/cluster", (req, res) => {
    const peers = engine.knownPeers();
    const activePeers = peers.filter(p => p.alive);
    const snapshots = activePeers.map(p => p.snapshot).filter(Boolean);

    // Detectar split-brain: ¿hay más de un líder autoproclamado?
    const leaders = snapshots.filter(s => s.role === "leader").map(s => s.id);
    if (engine.role === "leader") leaders.push(engine.selfId);
    const uniqueLeaders = [...new Set(leaders)];
    const splitBrain = uniqueLeaders.length > 1;

    // Convergencia: todos conocen al mismo líder
    const currentLeader = engine.role === "leader" ? engine.selfId : engine.leaderId;
    const allKnowSameLeader = snapshots.every(s => (s.leader || s.leaderId) === currentLeader);
    const converged = !splitBrain && allKnowSameLeader && !!currentLeader;

    res.json({
        self: engine.snapshot(),
        peers: peers.map(p => ({
            id:       p.id,
            url:      p.url,
            alive:    Boolean(p.alive),
            lastSeen: p.lastSeen,
            snapshot: p.snapshot,
        })),
        cluster: {
            totalNodes:    peers.length + 1,
            alivePeers:    peers.filter(p => p.alive).length,
            leader:        currentLeader,
            leaderId:      currentLeader,
            leaderUrl:     engine.role === "leader" ? engine.selfUrl : engine.leaderUrl,
            term:          engine.term,
            splitBrain,
            converged,
            knownLeaders:  uniqueLeaders,
        },
    });
});

// ─── POST /election/algorithm — Cambiar algoritmo en caliente ─────────────────
router.post("/election/algorithm", async (req, res) => {
    const { algo = "bully", propagate = false } = req.body;
    if (!strategies.available().includes(algo)) {
        return res.status(400).json({ error: `Algoritmo '${algo}' no disponible. Opciones: ${strategies.available().join(", ")}` });
    }
    await engine.setStrategy(algo, propagate);
    res.json({ ok: true, algo, propagated: propagate });
});

// ─── POST /election/trigger — Forzar dimisión del líder ──────────────────────
router.post("/election/trigger", async (req, res) => {
    await engine.triggerElection();
    res.json({ ok: true, message: "Elección disparada" });
});

// ─── POST /election/kill-leader — Tumbar al líder actual remotamente ──────────
router.post("/election/kill-leader", async (req, res) => {
    const leaderUrl = engine.leaderUrl;
    if (!leaderUrl) {
        return res.status(404).json({ error: "No hay líder conocido" });
    }
    // Si yo mismo soy el líder, me dimito directamente
    if (engine.role === "leader") {
        await engine.triggerElection();
        return res.json({ ok: true, message: "Dimisión propia forzada", self: true });
    }
    // Si otro nodo es el líder, le envío el trigger remotamente
    try {
        const transport = require("../election/transport");
        await transport.post(`${leaderUrl}/election/trigger`, {}, { timeout: 4000 });
        res.json({ ok: true, message: `Trigger enviado al líder ${engine.leaderId} (${leaderUrl})` });
    } catch (err) {
        res.status(502).json({ error: `No se pudo contactar al líder: ${err.message}` });
    }
});

// ─── DELETE /election/peers — Desconectar y eliminar peer ─────────────────────
router.delete("/election/peers", (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Falta el parámetro url" });
    const cleanUrl = url.replace(/\/$/, "");

    // 1. Quitar del cluster y prevenir re-conexión automática
    const removed = engine.removePeer(cleanUrl);

    // 2. Quitar del Naming Service de workers si estaba registrado
    try {
        const id = req.query.id;
        for (const w of registry.list()) {
            if (w.url === cleanUrl || (id && w.name === id)) {
                registry.unregister(w.name);
            }
        }
    } catch (_) {}

    // 3. Notificar al nodo remoto para que también nos desconecte (best-effort)
    const transport = require("../election/transport");
    if (engine.selfUrl) {
        transport.del(`${cleanUrl}/election/peers?url=${encodeURIComponent(engine.selfUrl)}`, { timeout: 1500 }).catch(() => {});
    }
    if (engine.selfId) {
        transport.post(`${cleanUrl}/unregister/${encodeURIComponent(engine.selfId)}`, {}, { timeout: 1500 }).catch(() => {});
    }

    res.json({ ok: true, message: `Desconectado exitosamente de ${cleanUrl}`, removed });
});

// ─── GET /events — Server-Sent Events stream ──────────────────────────────────
router.get("/events", (req, res) => {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Enviar estado inicial
    res.write(`data: ${JSON.stringify({ type: "connected", state: engine.snapshot() })}\n\n`);

    const cleanup = eventsModule.addSseClient(res);
    req.on("close", cleanup);
});

module.exports = router;
