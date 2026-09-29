const axios = require("axios");

/**
 * vector_distance: Obtiene la distancia entre dos vectores de dos dimensiones.
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
 * http_latency: Obtiene la latencia de una URL determinada en ms.
 */
async function httpLatency(payload) {
    const { url } = payload;
    if (!url) throw new Error("Se requiere 'url'");
    
    const start = Date.now();
    try {
        await axios.head(url, { timeout: 5000 });
    } catch (e) {
        // Ignoramos el error, solo queremos la latencia
    }
    const ms = Date.now() - start;
    return { ms };
}

/**
 * random_number: Genera un número aleatorio entre min y max (Inutilizado por defecto).
 */
function randomNumber(payload) {
    const min = payload.min || 0;
    const max = payload.max || 100;
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    return { number: result };
}

/**
 * Enrutador de tareas según el tipo de capacidad requerida.
 */
async function executeTask(taskType, payload) {
    switch (taskType) {
        case "vector_distance": return vectorDistance(payload);
        case "http_latency": return await httpLatency(payload);
        case "random_number": return randomNumber(payload);
        default:
            throw new Error(`Capacidad '${taskType}' no soportada por este worker.`);
    }
}

module.exports = { executeTask };
