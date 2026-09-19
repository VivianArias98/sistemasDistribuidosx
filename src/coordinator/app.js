/**
 * app.js — Configuración de Express y montaje de rutas del Coordinador
 */
const express      = require("express");
const path         = require("path");
const config       = require("./config");
const electionRoutes = require("./routes/election.routes");
const debugRoutes    = require("./routes/debug.routes");
const serverRoutes   = require("./routes/server.routes");

const app = express();

// ─── Middlewares globales ──────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",  "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Manejo de JSON inválido
app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
        return res.status(400).json({ error: "JSON inválido en el cuerpo de la petición" });
    }
    next(err);
});

// ─── Middleware de Redirección a Setup ─────────────────────────────────────────
app.use((req, res, next) => {
    // Si no está configurado, forzar redirección al wizard
    if (!config.isConfigured) {
        if (req.path === '/' || req.path === '/index.html' || req.path === '/election.html') {
            return res.redirect('/setup.html');
        }
    }
    next();
});

// ─── Archivos estáticos del dashboard ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Auto-detectar URL de ngrok (local) ───────────────────────────────────────
app.get("/api/ngrok-url", async (req, res) => {
    try {
        const axios = require("axios");
        const resp = await axios.get("http://127.0.0.1:4040/api/tunnels", { timeout: 1500 });
        const tunnel = resp.data.tunnels?.find(t => t.proto === "https");
        if (tunnel && tunnel.public_url) {
            return res.json({ url: tunnel.public_url });
        }
        res.json({ url: null });
    } catch (err) {
        // ngrok no está corriendo o no se puede acceder a la API local
        console.error("Error auto-detectando ngrok:", err.message);
        res.json({ url: null });
    }
});


// ─── Desconectar/Apagar el Nodo ────────────────────────────────────────────────
app.post("/api/shutdown", (req, res) => {
    res.json({ ok: true, message: "Apagando el nodo..." });
    console.log("🛑 Solicitud de apagado recibida desde la UI. Cerrando...");
    setTimeout(() => {
        process.exit(0);
    }, 500);
});

// ─── Setup Wizard: configurar nodo en caliente ────────────────────────────────
app.post("/api/setup", async (req, res) => {
    const { nodeId, baseUrl, peerUrl } = req.body;
    if (!nodeId || !baseUrl) {
        return res.status(400).json({ error: "Se requieren nodeId y baseUrl" });
    }

    // Normalizar URLs
    const cleanBase = baseUrl.replace(/\/$/, "");
    const cleanPeer = peerUrl ? peerUrl.replace(/\/$/, "") : null;
    const peerUrls  = cleanPeer ? [cleanPeer] : [];

    // Aplicar configuración
    config.configure({ nodeId, baseUrl: cleanBase, peerUrls });

    // Iniciar el engine si aún no estaba inicializado
    const { init, engine, start } = require("./election/engine");
    if (engine.selfId === "UNCONFIGURED" || !engine._started) {
        // Agregar peer al engine si viene uno (forzando la conexión por si estaba en blacklist)
        if (cleanPeer) engine.upsertPeer(null, cleanPeer, {}, true);
        await init("bully");
        engine._started = true;
    } else {
        if (engine.role === "leader") {
            engine.leaderId = nodeId;
        }
        // Ya estaba corriendo → solo agregar el peer nuevo
        if (cleanPeer) {
            engine.allowPeer(cleanPeer);
            if (!engine.knownPeers().some(p => p.url === cleanPeer)) {
                engine.upsertPeer(null, cleanPeer, {}, true);
            }
        }
    }

    if (cleanPeer) {
        const transport = require("./election/transport");
        const { engine: eng } = require("./election/engine");

        // 1. Handshake via gossip ping (compatible con formato Juan Diego: { from: {...} })
        const snap = eng.snapshot();
        const pingPayload = {
            ...snap,
            from: { id: snap.id, url: snap.url, role: snap.role, currentLeader: snap.leader, term: snap.term },
        };
        transport.post(`${cleanPeer}/election/ping`, pingPayload, { timeout: 3000 }).catch(() => {});

        // 2. Intentar registro como worker (best-effort; puede fallar si el peer no es el líder)
        transport.post(
            `${cleanPeer}/register`,
            {
                name: nodeId,
                url: cleanBase,
                platform: process.platform,
                hostname: require("os").hostname()
            },
            { timeout: 3000 }
        ).catch(() => {});
    }

    res.json({ ok: true, nodeId, baseUrl: cleanBase, peers: peerUrls });
});

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use(electionRoutes);   // /election/*, /cluster, /events
app.use(debugRoutes);      // /debug/faults/*
app.use(serverRoutes);     // /register, /pulse, /send-message, /api/*, etc.

// ─── Catch-all: redirigir al setup si no está configurado ─────────────────────
app.get("*", (req, res) => {
    const isApiOrAsset = req.path.startsWith("/election") ||
                         req.path.startsWith("/api") ||
                         req.path.startsWith("/debug") ||
                         req.path.startsWith("/cluster") ||
                         req.path.includes(".");

    if (!config.isConfigured && !isApiOrAsset) {
        return res.sendFile(path.join(__dirname, "public", "setup.html"));
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;
