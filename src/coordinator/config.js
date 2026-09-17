/**
 * config.js — Configuración central del Coordinador
 * Lee variables de entorno y expone un objeto de configuración.
 * Soporta reconfiguración en caliente vía configure().
 */
require("dotenv").config();

const { getTiming } = require("./election/timing");

let NODE_ID  = process.env.NODE_ID  || null;  // null = sin configurar aún
let PORT     = parseInt(process.env.PORT || "3000", 10);
let BASE_URL = process.env.BASE_URL  || `http://localhost:${PORT}`;

// Peers iniciales: lista de URLs separadas por coma
let PEER_URLS = (process.env.PEERS || "")
    .split(",")
    .map(u => u.trim())
    .filter(Boolean);

let TIMING_PRESET = process.env.TIMING_PRESET || "wan";
let timing = getTiming(TIMING_PRESET);

// Timeout para detectar workers inactivos (Naming Service)
const WORKER_TIMEOUT_MS = parseInt(process.env.WORKER_TIMEOUT_MS || "15000", 10);

const config = {
    get nodeId()       { return NODE_ID || "UNCONFIGURED"; },
    get port()         { return PORT; },
    get baseUrl()      { return BASE_URL; },
    get peerUrls()     { return PEER_URLS; },
    get timingPreset() { return TIMING_PRESET; },
    get timing()       { return timing; },
    get workerTimeoutMs() { return WORKER_TIMEOUT_MS; },
    get isConfigured() { return !!NODE_ID; },

    /**
     * Reconfigura el nodo en caliente (desde el wizard de setup).
     */
    configure({ nodeId, baseUrl, peerUrls }) {
        if (nodeId)   NODE_ID   = nodeId;
        if (baseUrl)  BASE_URL  = baseUrl;
        if (peerUrls) PEER_URLS = peerUrls;
    },
};

module.exports = config;
