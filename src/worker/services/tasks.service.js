const axios = require("axios");

// ─── Implementaciones de capacidades del examen (Sección 9) ──────────────────

/**
 * 9.5 vector_distance: Distancia entre dos vectores de 2 dimensiones.
 */
function vectorDistance(payload) {
    const { a, b } = payload;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) {
        throw new Error("Se requiere 'a' y 'b' como arreglos de 2 dimensiones");
    }
    const distance = Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
    return { distance };
}

/**
 * 9.6 http_latency: Latencia de una URL en milisegundos.
 */
async function httpLatency(payload) {
    const { url } = payload;
    if (!url) throw new Error("Se requiere 'url'");
    const start = Date.now();
    try {
        await axios.head(url, { timeout: 5000 });
    } catch (_) { /* Ignoramos el error, solo queremos la latencia */ }
    return { ms: Date.now() - start };
}

/**
 * count_vowels: Tarea completamente nueva.
 * Cuenta cuántas vocales tiene un string.
 */
function countVowels(payload) {
    // Si el payload viene vacío ({}) o no trae el campo 'text'
    if (!payload || !payload.text || typeof payload.text !== "string") {
        throw new Error("❌ JSON inválido. Para usar count_vowels debes enviar esta estructura: {\"text\": \"tu texto aquí\"}");
    }
    
    const count = (payload.text.match(/[aeiouáéíóúAEIOUÁÉÍÓÚ]/g) || []).length;
    return { vowels: count };
}

// ─── Registro dinámico de handlers ───────────────────────────────────────────
//
// Permite que capacidades DESCONOCIDAS se puedan registrar en tiempo de ejecución.
// Si un worker externo tiene una capacidad nueva, se puede agregar su handler aquí
// mediante registerHandler(name, fn) sin reiniciar el worker.
//
const dynamicHandlers = new Map();

/**
 * Registra un handler para una capacidad personalizada o desconocida.
 * @param {string} name       - Nombre de la capacidad (ej. "image_resize")
 * @param {Function} handler  - Función (payload) => result | Promise<result>
 */
function registerHandler(name, handler) {
    if (typeof handler !== "function") throw new Error("El handler debe ser una función");
    dynamicHandlers.set(name, handler);
    console.log(`🔧 Handler dinámico registrado para capacidad: '${name}'`);
}

// ─── Mapa base de capacidades conocidas ──────────────────────────────────────

const builtinHandlers = {
    "vector_distance":   vectorDistance,
    "http_latency":      httpLatency,
    "count_vowels":      countVowels,
};

/**
 * Ejecuta una tarea según el tipo de capacidad requerida.
 * Primero busca en los handlers registrados dinámicamente,
 * luego en los handlers integrados (built-in).
 *
 * @param {string} taskType
 * @param {object} payload
 */
async function executeTask(taskType, payload) {
    // 1. Buscar en handlers dinámicos (capacidades de otros workers registradas en tiempo real)
    if (dynamicHandlers.has(taskType)) {
        return await Promise.resolve(dynamicHandlers.get(taskType)(payload));
    }

    // 2. Buscar en handlers integrados (capacidades del examen)
    if (builtinHandlers[taskType]) {
        return await Promise.resolve(builtinHandlers[taskType](payload));
    }

    // 3. Capacidad totalmente desconocida — error claro según el formato del examen
    throw new Error(
        `Capacidad '${taskType}' no implementada en este worker. ` +
        `Capacidades disponibles: [${[...Object.keys(builtinHandlers), ...dynamicHandlers.keys()].join(", ")}]`
    );
}

/**
 * Retorna la lista completa de capacidades soportadas por este worker
 * (integradas + dinámicas registradas en runtime).
 */
function getSupportedCapabilities() {
    return [
        ...Object.keys(builtinHandlers),
        ...dynamicHandlers.keys()
    ];
}

module.exports = { executeTask, registerHandler, getSupportedCapabilities };
