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

    const { id, url, peers: remotePeers = [] } = req.body;

    // Descubrimiento transitivo: incorporar peers del emisor
    if (id && url) engine.upsertPeer(id, url);
    for (const p of remotePeers) {
        if (p.url && p.url !== engine.selfUrl) engine.upsertPeer(p.id, p.url);
    }

    res.json(engine.snapshot());
});

// ─── GET /election/state ──────────────────────────────────────────────────────
router.get("/election/state", (req, res) => {
    res.json({
        id:        engine.selfId,
        url:       engine.selfUrl,
        role:      engine.role,
        term:      engine.term,
        leaderId:  engine.leaderId,
        leaderUrl: engine.leaderUrl,
        peers:     engine.knownPeers(),
        faults:    faults.snapshot(),
        uptime:    process.uptime(),
    });
});

// ─── GET /cluster — Estado agregado del cluster ───────────────────────────────
router.get("/cluster", (req, res) => {
    const peers = engine.knownPeers();
    const snapshots = peers.map(p => p.snapshot).filter(Boolean);

    // Detectar split-brain: ¿hay más de un líder autoproclamado?
    const leaders = snapshots.filter(s => s.role === "leader").map(s => s.id);
    if (engine.role === "leader") leaders.push(engine.selfId);
    const uniqueLeaders = [...new Set(leaders)];
    const splitBrain = uniqueLeaders.length > 1;

    // Convergencia: todos conocen al mismo líder
    const allKnowSameLeader = snapshots.every(s => s.leaderId === engine.leaderId);
    const converged = !splitBrain && allKnowSameLeader && !!engine.leaderId;

    res.json({
        self: engine.snapshot(),
        peers: peers.map(p => ({
            id:       p.id,
            url:      p.url,
            alive:    p.alive,
            lastSeen: p.lastSeen,
            snapshot: p.snapshot,
        })),
        cluster: {
            totalNodes:    peers.length + 1,
            alivePeers:    peers.filter(p => p.alive).length,
            leaderId:      engine.leaderId,
            leaderUrl:     engine.leaderUrl,
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
