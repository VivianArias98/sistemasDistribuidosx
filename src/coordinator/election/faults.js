/**
 * faults.js — Motor de Inyección de Caos
 * Controla: tasa de pérdida de paquetes, latencia artificial, particiones de red y pausa del nodo.
 */
const logger = require("../utils/logger");

const state = {
    paused:    false,       // Si true, el nodo ignora ticks y no responde
    dropRate:  0.0,         // 0.0–1.0: probabilidad de descartar una petición saliente
    latencyMs: 0,           // ms de retardo añadido a peticiones salientes
    partitions: new Set(),  // URLs con las que el tráfico está bloqueado bidireccionalmente
};

/**
 * Pausa el nodo (ignora ticks del engine, no responde peticiones entrantes de elección).
 */
function pause() {
    state.paused = true;
    logger.fault("Faults", "🧊 Nodo CONGELADO (pause)");
}

/**
 * Reanuda el nodo.
 */
function resume() {
    state.paused = false;
    logger.fault("Faults", "▶️  Nodo REANUDADO (resume)");
}

/**
 * Aísla tráfico bidireccional hacia una URL específica.
 * @param {string} targetUrl
 */
function partition(targetUrl) {
    state.partitions.add(targetUrl);
    logger.fault("Faults", `🔌 Partición activa hacia: ${targetUrl}`);
}

/**
 * Elimina todas las particiones activas (sana la red).
 */
function healAll() {
    const count = state.partitions.size;
    state.partitions.clear();
    logger.fault("Faults", `🩹 Todas las particiones eliminadas (${count} particiones sanadass)`);
}

/**
 * Elimina la partición hacia una URL específica.
 * @param {string} targetUrl
 */
function heal(targetUrl) {
    state.partitions.delete(targetUrl);
    logger.fault("Faults", `🩹 Partición eliminada hacia: ${targetUrl}`);
}

/**
 * Establece la tasa de pérdida de paquetes salientes.
 * @param {number} rate  0.0–1.0
 */
function setDropRate(rate) {
    state.dropRate = Math.max(0, Math.min(1, rate));
    logger.fault("Faults", `📉 Drop rate ajustado a ${(state.dropRate * 100).toFixed(0)}%`);
}

/**
 * Establece la latencia artificial en peticiones salientes.
 * @param {number} ms
 */
function setLatency(ms) {
    state.latencyMs = Math.max(0, ms);
    logger.fault("Faults", `⏳ Latencia artificial: ${state.latencyMs}ms`);
}

/**
 * Verifica si el tráfico hacia una URL está permitido.
 * @param {string} targetUrl
 * @returns {boolean}
 */
function isAllowed(targetUrl) {
    if (state.partitions.has(targetUrl)) return false;
    // Verificar prefijos de URL (por si la URL varía en path)
    for (const blocked of state.partitions) {
        if (targetUrl.startsWith(blocked)) return false;
    }
    return true;
}

/**
 * Simula el modelo de caos: retorna false si el paquete debe descartarse.
 * @returns {boolean} true si la petición debe continuar
 */
function shouldDrop() {
    return Math.random() < state.dropRate;
}

/**
 * Retorna una promesa que resuelve tras la latencia configurada.
 * @returns {Promise<void>}
 */
function applyLatency() {
    if (state.latencyMs <= 0) return Promise.resolve();
    return new Promise(r => setTimeout(r, state.latencyMs));
}

/**
 * Snapshot del estado de fallos (para observabilidad).
 */
function snapshot() {
    return {
        paused: state.paused,
        dropRate: state.dropRate,
        latencyMs: state.latencyMs,
        partitions: [...state.partitions],
    };
}

module.exports = {
    pause, resume,
    partition, healAll, heal,
    setDropRate, setLatency,
    isAllowed, shouldDrop, applyLatency,
    snapshot,
    get paused() { return state.paused; },
};
