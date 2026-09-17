/**
 * app.js — Configuración de Express y montaje de rutas del Coordinador
 */
const express      = require("express");
const path         = require("path");
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

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use(electionRoutes);   // /election/*, /cluster, /events
app.use(debugRoutes);      // /debug/faults/*
app.use(serverRoutes);     // /register, /pulse, /send-message, /api/*, etc.

// ─── Catch-all: SPA fallback ──────────────────────────────────────────────────
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;
