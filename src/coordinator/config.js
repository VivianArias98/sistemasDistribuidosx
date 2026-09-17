/**
 * config.js — Configuración central del Coordinador
 * Lee variables de entorno y expone un objeto de configuración inmutable.
 */
require("dotenv").config();

const { getTiming } = require("./election/timing");

const NODE_ID  = process.env.NODE_ID  || "A";
const PORT     = parseInt(process.env.PORT || "3001", 10);
const BASE_URL = process.env.BASE_URL  || `http://localhost:${PORT}`;

// Peers iniciales: lista de URLs separadas por coma
const PEER_URLS = (process.env.PEERS || "")
    .split(",")
    .map(u => u.trim())
    .filter(Boolean);

const TIMING_PRESET = process.env.TIMING_PRESET || "lan";
const timing = getTiming(TIMING_PRESET);

// Timeout para detectar workers inactivos (Naming Service)
const WORKER_TIMEOUT_MS = parseInt(process.env.WORKER_TIMEOUT_MS || "15000", 10);

const config = Object.freeze({
    nodeId: NODE_ID,
    port: PORT,
    baseUrl: BASE_URL,
    peerUrls: PEER_URLS,
    timingPreset: TIMING_PRESET,
    timing,
    workerTimeoutMs: WORKER_TIMEOUT_MS,
});

module.exports = config;
