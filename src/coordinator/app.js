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
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

// ─── Archivos estáticos del dashboard ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

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
        // Agregar peer al engine si viene uno
        if (cleanPeer) engine.upsertPeer(null, cleanPeer);
        await init("bully");
        engine._started = true;
    } else {
        // Ya estaba corriendo → solo agregar el peer nuevo
        if (cleanPeer && !engine.knownPeers().some(p => p.url === cleanPeer)) {
            engine.upsertPeer(null, cleanPeer);
        }
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
