/**
 * journal.service.js — Historial de coordinadores conocidos y eventos del worker
 * Registra cada evento con secuencia y timestamp para el diario del worker.
 */

let seq = 0;

/** @type {Array<{seq, ts, type, data}>} */
const entries = [];

const MAX = 100;

/**
 * Tipos de evento:
 *   arranque | caida | busqueda | pregunta | registro | mensaje | padre-cambiado
 */
function record(type, data = {}) {
    const entry = { seq: ++seq, ts: Date.now(), type, data };
    entries.unshift(entry);
    if (entries.length > MAX) entries.pop();
    return entry;
}

/**
 * Retorna el diario completo (o limitado).
 * @param {number} [limit]
 */
function getAll(limit) {
    return limit ? entries.slice(0, limit) : [...entries];
}

module.exports = { record, getAll };
