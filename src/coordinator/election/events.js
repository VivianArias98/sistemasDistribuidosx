/**
 * events.js — Bus de eventos interno + emisor Server-Sent Events (SSE)
 * Todos los módulos emiten eventos aquí. Las rutas de SSE se suscriben para reenviarlos al cliente.
 */
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(50);

// Clientes SSE conectados: { res, id }
const sseClients = new Set();

// Latidos periódicos cada 15s para evitar desconexiones en proxies
setInterval(() => {
    for (const client of sseClients) {
        try { client.res.write(": ping\n\n"); } catch {}
    }
}, 15_000);

/**
 * Registra un cliente SSE.
 * @param {import('express').Response} res
 * @returns {function} función de cleanup para llamar al cerrar la conexión
 */
function addSseClient(res) {
    const client = { res, id: Date.now() + Math.random() };
    sseClients.add(client);

    return () => sseClients.delete(client);
}

/**
 * Emite un evento al bus interno Y lo broadcast a todos los clientes SSE.
 * @param {string} type  - "peer-up" | "peer-down" | "election-start" | "election-won" | "leader-lost" | ...
 * @param {object} data
 */
function emit(type, data = {}) {
    bus.emit(type, data);
    bus.emit("*", { type, ...data });   // wildcard para listeners genéricos

    const payload = JSON.stringify({ type, ...data, ts: Date.now() });
    for (const client of sseClients) {
        try {
            client.res.write(`data: ${payload}\n\n`);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

/**
 * Suscribirse a un tipo de evento del bus interno.
 */
function on(type, handler) {
    bus.on(type, handler);
}

/**
 * Desuscribirse.
 */
function off(type, handler) {
    bus.off(type, handler);
}

module.exports = { emit, on, off, addSseClient, get sseClientCount() { return sseClients.size; } };
