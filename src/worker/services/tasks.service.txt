const axios = require("axios");

/**
 * math_compute: Calculadora básica que toma una operación y dos operandos.
 */
function mathCompute(payload) {
    const { operation, a, b } = payload;
    if (typeof a !== "number" || typeof b !== "number") {
        throw new Error("Operandos 'a' y 'b' deben ser números");
    }

    switch (operation) {
        case "add": return { result: a + b };
        case "sub": return { result: a - b };
        case "mul": return { result: a * b };
        case "div": 
            if (b === 0) throw new Error("División por cero");
            return { result: a / b };
        default:
            throw new Error(`Operación no soportada: ${operation}`);
    }
}

/**
 * http_fetch: Hace fetch a la URL solicitada y retorna el estado.
 */
async function httpFetch(payload) {
    const { url } = payload;
    if (!url) throw new Error("Se requiere la propiedad 'url'");

    try {
        const resp = await axios.get(url, { timeout: 5000 });
        return { status: resp.status, body: resp.data };
    } catch (err) {
        if (err.response) {
            return { status: err.response.status, body: err.response.data };
        }
        throw err;
    }
}

/**
 * reverse_string: Capacidad propia que invierte una cadena de texto.
 */
function reverseString(payload) {
    const { text } = payload;
    if (typeof text !== "string") throw new Error("Se requiere 'text' como string");
    return { reversed: text.split("").reverse().join("") };
}

/**
 * search_text: Busca en una cadena de texto y retorna cuántas veces encuentra el query.
 */
function searchText(payload) {
    const { text, query } = payload;
    if (typeof text !== "string" || typeof query !== "string") {
        throw new Error("Se requiere 'text' y 'query' como strings");
    }
    const count = (text.match(new RegExp(query, "g")) || []).length;
    return { count };
}

/**
 * stats_compute: Obtiene el promedio, el mínimo y el máximo de una lista de números.
 */
function statsCompute(payload) {
    const { numbers } = payload;
    if (!Array.isArray(numbers) || numbers.length === 0) {
        throw new Error("Se requiere 'numbers' como un arreglo de números con al menos un elemento");
    }
    const sum = numbers.reduce((a, b) => a + b, 0);
    const mean = sum / numbers.length;
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return { mean, min, max };
}

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
 * Enrutador de tareas según el tipo de capacidad requerida.
 */
async function executeTask(taskType, payload) {
    switch (taskType) {
        case "math_compute": return mathCompute(payload);
        case "http_fetch": return await httpFetch(payload);
        case "search_text": return searchText(payload);
        case "stats_compute": return statsCompute(payload);
        case "vector_distance": return vectorDistance(payload);
        case "http_latency": return await httpLatency(payload);
        case "reverse_string": return reverseString(payload);
        default:
            throw new Error(`Capacidad '${taskType}' no soportada por este worker.`);
    }
}

module.exports = { executeTask };

