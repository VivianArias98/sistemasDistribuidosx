/**
 * message.service.js — Envío de mensajes al coordinador con soporte de redirección
 * Si el coordinador responde con leaderUrl diferente, se redirige automáticamente.
 */
const axios   = require("axios");
const journal = require("./journal.service");
const logger  = require("../utils/logger");

let _parentUrl  = null;
let _workerName = null;

function setParent(url, name) {
    _parentUrl  = url;
    _workerName = name;
}

/**
 * Envía un mensaje al coordinador padre.
 * Si el coordinador devuelve un 3xx o leaderUrl diferente, reintenta hacia el nuevo líder.
 * @param {string} message
 * @param {number} [retries=2]
 */
async function send(message, retries = 2) {
    let currentUrl = _parentUrl;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await axios.post(
                `${currentUrl}/send-message/${_workerName}`,
                { message },
                { timeout: 4000, maxRedirects: 0, validateStatus: s => s < 500 }
            );

            // Redirección explícita vía leaderUrl en body
            if (resp.data?.leaderUrl && resp.data.leaderUrl !== currentUrl) {
                logger.msg(`Redireccionado al líder: ${resp.data.leaderUrl}`);
                journal.record("redireccion", { de: currentUrl, a: resp.data.leaderUrl });
                currentUrl = resp.data.leaderUrl;
                continue;
            }

            if (resp.status >= 200 && resp.status < 300) {
                logger.msg(`Mensaje entregado: "${message}"`);
                journal.record("mensaje", { mensaje: message, coordinador: currentUrl });
                return { ok: true, response: resp.data };
            }

            logger.warn(`Respuesta inesperada (${resp.status}) de ${currentUrl}`);
        } catch (err) {
            logger.warn(`Error enviando mensaje (intento ${attempt + 1}): ${err.message}`);
            if (attempt === retries) throw err;
        }
    }
    throw new Error("No se pudo entregar el mensaje tras todos los reintentos");
}

module.exports = { send, setParent };
