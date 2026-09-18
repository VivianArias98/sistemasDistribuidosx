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

    const body = req.body || {};
    const logger = require("../utils/logger");

    // ── Compatibilidad con múltiples formatos de gossip (distintas implementaciones) ──
    // Formato A (propio):      { id, url, peers }
    // Formato B (Juan Diego):  { from: {id, url, role, currentLeader, term}, peers }
    // Formato C (otros):       { nodeId, baseUrl, ... }
    const fromObj = body.from || {};
    const id  = body.id  || fromObj.id  || body.nodeId  || body.selfId  || body.name  || null;
    const url = body.url || fromObj.url || body.baseUrl || body.selfUrl || body.address || null;
    const remotePeers = body.peers || body.knownPeers || body.neighbors || [];

    // Log de todo lo que llega para diagnosticar incompatibilidades
    if (id || url) {
        logger.info("PING-IN", `← Ping recibido de [${id || "?"}] @ ${url || "?"} con ${Array.isArray(remotePeers) ? remotePeers.length : 0} peers`);
    }

    // Filtrar IDs numéricos y URLs para que los workers/puertos fantasma no entren a la lista de peers del cluster
    const isValidPeer = (peerId) => {
        if (!peerId) return false;
        if (typeof peerId === "object") return false;
        if (String(peerId) === "[object Object]") return false;
        if (!isNaN(Number(peerId))) return false;
        if (String(peerId).startsWith("http")) return false;
        if (String(peerId).length > 40) return false; // relajado de 20 a 40 por si usan nombres más largos
        return true;
    };

    // Descubrimiento transitivo: incorporar peers del emisor
    if (url && isValidPeer(id)) {
        const alreadyKnown = engine.knownPeers().some(p => p.url === url.replace(/\/$/, ""));
        engine.upsertPeer(id, url);
        // Auto-registrar en Naming Service SOLO si NO es el propio nodo
        const isSelf = (engine.selfId && id === engine.selfId) || (engine.selfUrl && url.replace(/\/$/, "") === engine.selfUrl.replace(/\/$/, ""));
        if (!isSelf) {
            if (!alreadyKnown) {
                logger.info("PING", `✅ Nuevo peer conectado: [${id}] en ${url} (IP: ${registry.clientIp(req)})`);
            }
            try {
                const ip = registry.clientIp(req);
                if (registry.resolve(id)) {
                    registry.pulse(id);
                } else {
                    registry.register(id, url, ip, { platform: body.platform || "coordinador-peer", hostname: id });
                    logger.info("REGISTRY", `📝 Peer registrado en Naming Service: [${id}] @ ${url}`);
                }
            } catch (_) {
                try { registry.pulse(id); } catch (__) {}
            }
        }
    } else if (!id && !url) {
        // El peer no mandó ni ID ni URL reconocibles — loguear el body crudo para diagnóstico
        logger.warn("PING", `⚠️ Ping recibido sin ID/URL reconocibles. Body keys: ${Object.keys(body).join(", ")}`);
    }
    
    for (const p of (Array.isArray(remotePeers) ? remotePeers : [])) {
        const pId  = p.id  || p.nodeId  || p.selfId  || p.name  || null;
        const pUrl = p.url || p.baseUrl || p.selfUrl || p.address || null;
        if (pUrl && pUrl !== engine.selfUrl && isValidPeer(pId)) {
            const alreadyKnown = engine.knownPeers().some(peer => peer.url === pUrl.replace(/\/$/, ""));
            engine.upsertPeer(pId, pUrl, { discoveredVia: id });
            if (!alreadyKnown) {
                logger.info("PING", `🔗 Peer transitivo descubierto: [${pId}] en ${pUrl} vía ${id}`);
            }
        }
    }

    // Respuesta compatible con ambos formatos (nuestro + Juan Diego):
    const snap = engine.snapshot();
    res.json({
        ...snap,
        ok: true,
        from: { id: snap.id, url: snap.url, role: snap.role, currentLeader: snap.leader },
        currentLeader: snap.leader,
        currentTerm: snap.term,
    });
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
