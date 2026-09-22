/**
 * registry.js — Servicio de Nombres (Naming Service) con ownership por IP
 * Previene suplantación: la primera IP que registra un nombre se convierte en su owner.
 */
const logger = require("../utils/logger");

/** @type {Map<string, {name, url, ip, platform, hostname, status, lastHeartbeat, registeredAt, fallenAt, messages}>} */
const workers = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza la IP del request para comparación consistente.
 */
function clientIp(req) {
    return String(req.ip || "").replace(/^::ffff:/, "").replace(/^127\.0\.0\.1$/, "localhost") || "unknown";
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Registra o re-conecta un worker.
 * @param {string} name
 * @param {string} url
 * @param {string} ip          - IP del cliente
 * @param {object} [meta]      - { platform, hostname }
 * @returns {{ worker, created: boolean, reactivated: boolean }}
 */
function register(name, url, ip, meta = {}) {
    // [Eliminado el chequeo de "Ghost Workers" por URL, ya que en el modo Gateway
    // un Coordinador (Peer) y un Worker de la misma máquina remota van a compartir 
    // la misma URL de ngrok, y si los borramos entran en un loop de re-registro infinito]

    const existing = workers.get(name);

    if (existing) {
        // Verificar ownership por IP (solo si la URL difiere, para permitir proxies y túneles ngrok)
        if (existing.ip && ip !== "unknown" && existing.ip !== "unknown" && existing.ip !== ip && existing.url !== url) {
            const err = new Error(`Conflicto: el nombre '${name}' ya pertenece a la IP ${existing.ip}`);
            err.code = "IP_CONFLICT";
            throw err;
        }

        if (existing.status === "ACTIVO" && existing.url === url) {
            // Reconexión del mismo worker desde la misma IP
            existing.lastHeartbeat = Date.now();
            Object.assign(existing, meta);
            logger.pulse("Registry", `Worker reconectado: ${name} (${ip})`);
            return { worker: existing, created: false, reactivated: false };
        }

        // Reactivación (estaba CAIDO)
        existing.url           = url;
        existing.status        = "ACTIVO";
        existing.lastHeartbeat = Date.now();
        existing.fallenAt      = null;
        Object.assign(existing, meta);
        logger.recovery("Registry", `Worker reactivado: ${name} (${url})`);
        return { worker: existing, created: false, reactivated: true };
    }

    // Nuevo worker
    const worker = {
        name,
        url,
        ip,
        platform:      meta.platform  || "desconocida",
        hostname:      meta.hostname   || "desconocido",
        status:        "ACTIVO",
        lastHeartbeat: Date.now(),
        registeredAt:  Date.now(),
        fallenAt:      null,
        messages:      [],
        localPort:     meta.localPort || null,
    };
    workers.set(name, worker);
    logger.info("Registry", `Worker registrado: ${name} (${url}) — IP owner: ${ip}`);
    return { worker, created: true, reactivated: false };
}

/**
 * Actualiza el heartbeat de un worker.
 * @returns {object} worker actualizado
 */
function pulse(name) {
    const w = workers.get(name);
    if (!w) return null;
    const wasFallen = w.status === "CAIDO";
    w.lastHeartbeat = Date.now();
    w.status        = "ACTIVO";
    w.fallenAt      = null;
    if (wasFallen) logger.recovery("Registry", `Worker reanudó pulsos: ${name}`);
    return w;
}

/**
 * Resuelve nombre → {url, status}
 */
function resolve(name) {
    return workers.get(name) || null;
}

/**
 * Lista todos los workers.
 */
function list() {
    return [...workers.values()];
}

/**
 * Marca un worker como CAIDO manualmente.
 */
function markFallen(name) {
    const w = workers.get(name);
    if (!w) return null;
    w.status   = "CAIDO";
    w.fallenAt = Date.now();
    return w;
}

/**
 * Elimina un worker del registro.
 */
function unregister(name) {
    return workers.delete(name);
}

/**
 * Purga del registro al propio nodo (si se autoregistró antes que los guards estuvieran activos).
 * Compara solo por nombre para permitir que un worker local use la URL pública del coordinador.
 * @param {string} selfId
 * @param {string} selfUrl
 */
function removeSelf(selfId, selfUrl) {
    for (const [name, w] of workers) {
        if (name === selfId) {
            workers.delete(name);
        }
    }
}

/**
 * Agrega un mensaje al historial del worker.
 */
function addMessage(name, entry) {
    const w = workers.get(name);
    if (w) w.messages.push(entry);
}

module.exports = { register, pulse, resolve, list, markFallen, unregister, removeSelf, addMessage, clientIp };
