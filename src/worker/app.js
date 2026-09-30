/**
 * app.js — Servidor Express del Worker
 * Expone: /status, /parent, /send-message, /receive-message, /shutdown, /stop-pulse, /start-pulse
 */
const express  = require("express");
const path     = require("path");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",  "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-server-token, x-worker, ngrok-skip-browser-warning");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});
app.use(express.static(path.join(__dirname, "public")));

module.exports = app;
