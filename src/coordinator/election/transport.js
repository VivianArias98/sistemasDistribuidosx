/**
 * transport.js — Capa HTTP con interceptor de fallos de caos
 * Envuelve axios para aplicar las reglas de faults.js antes de cada petición saliente.
 */
const axios  = require("axios");
const faults = require("./faults");
const logger = require("../utils/logger");

/**
 * Realiza un POST con interceptación de caos.
 * @param {string} url
 * @param {object} data
 * @param {object} [opts]  opciones extra de axios
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function post(url, data = {}, opts = {}) {
    // 1. Verificar partición
    if (!faults.isAllowed(url)) {
        const err = new Error(`[PARTITION] Tráfico bloqueado hacia ${url}`);
        err.code = "PARTITION";
        throw err;
    }

    // 2. Drop aleatorio de paquetes
    if (faults.shouldDrop()) {
        const err = new Error(`[DROP] Paquete descartado por drop rate hacia ${url}`);
        err.code = "DROP";
        throw err;
    }

    // 3. Aplicar latencia artificial
    await faults.applyLatency();

    // 4. Realizar la petición
    const timeout = opts.timeout || 2000;
    const headers = { ...opts.headers, "ngrok-skip-browser-warning": "true" };
    return axios.post(url, data, { timeout, ...opts, headers });
}

/**
 * Realiza un GET con interceptación de caos.
 */
async function get(url, opts = {}) {
    if (!faults.isAllowed(url)) {
        const err = new Error(`[PARTITION] Tráfico bloqueado hacia ${url}`);
        err.code = "PARTITION";
        throw err;
    }
    if (faults.shouldDrop()) {
        const err = new Error(`[DROP] Paquete descartado por drop rate hacia ${url}`);
        err.code = "DROP";
        throw err;
    }
    await faults.applyLatency();
    const timeout = opts.timeout || 2000;
    const headers = { ...opts.headers, "ngrok-skip-browser-warning": "true" };
    return axios.get(url, { timeout, ...opts, headers });
}

module.exports = { post, get };
