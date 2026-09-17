/**
 * messages.js — Almacén en memoria de mensajes distribuidos
 */
const MAX_HISTORY = 200;

/** @type {Array<{id,from,to,message,timestamp,status,targetUrl,error}>} */
let history = [];

function _id() {
    return "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4);
}

/**
 * Agrega un mensaje al historial.
 */
function add(entry) {
    history.unshift({ id: _id(), ...entry, timestamp: entry.timestamp || Date.now() });
    if (history.length > MAX_HISTORY) history.pop();
    return history[0];
}

/**
 * Retorna el historial completo o filtrado.
 * @param {number} [limit]
 */
function getAll(limit) {
    return limit ? history.slice(0, limit) : history;
}

/**
 * Limpia el historial.
 */
function clear() {
    history = [];
}

module.exports = { add, getAll, clear };
