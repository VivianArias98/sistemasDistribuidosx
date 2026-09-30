/**
 * pulse.service.js — Latidos periódicos del worker hacia su coordinador padre
 * Si el pulso falla repetidamente, señaliza pérdida de contacto para activar el hunting loop.
 */
const axios   = require("axios");
const journal = require("./journal.service");
const logger  = require("../utils/logger");

const PULSE_INTERVAL = parseInt(process.env.PULSE_INTERVAL_MS || "3000", 10);
const MAX_FAILURES   = 3;

let _handle       = null;
let _failCount    = 0;
let _parentUrl    = null;
let _workerName   = null;
let _onLost       = null;   // callback cuando pierde al coordinador

/**
 * Inicia el servicio de pulsos.
 * @param {string} parentUrl    - URL del coordinador padre
 * @param {string} workerName
 * @param {function} onLost     - callback cuando se detecta pérdida de coordinador
 */
function start(parentUrl, workerName, onLost) {
    _parentUrl  = parentUrl;
    _workerName = workerName;
    _onLost     = onLost;
    _failCount  = 0;

    if (_handle) clearInterval(_handle);

    _handle = setInterval(async () => {
        try {
            await axios.post(
                `${_parentUrl}/pulse/${_workerName}`,
                {
                    type: "pulse",
                    data: {
                        id: _workerName,
                        load: parseFloat((Math.random() * 0.5).toFixed(2)) // Simulación de carga
                    }
                },
                { timeout: 3000 }
            );
            _failCount = 0;
            logger.pulse(`Pulso enviado → ${_parentUrl}`);

            // [COMPATIBILIDAD] Polling de mensajes para SistemasDistribuidos-main
            try {
                const pollResp = await axios.get(`${_parentUrl}/send-message/${_workerName}`, { timeout: 2000 });
                if (pollResp.data && Array.isArray(pollResp.data.messages)) {
                    // Solo evitamos imprimir repetidos guardando los IDs recientes
                    if (!global._seenMessages) global._seenMessages = new Set();
                    pollResp.data.messages.forEach(msg => {
                        const msgId = msg.id || (msg.timestamp + msg.message);
                        if (!global._seenMessages.has(msgId)) {
                            global._seenMessages.add(msgId);
                            const from = msg.sender || "Coordinador";
                            console.log(`\n📥 [MENSAJE RECIBIDO] de ${from}: "${msg.message}"`);
                            if (global._onMessageReceived) {
                                global._onMessageReceived(msg);
                            }
                            
                            // Guardar 100 max en el Set para no llenar memoria
                            if (global._seenMessages.size > 100) {
                                const iter = global._seenMessages.values();
                                global._seenMessages.delete(iter.next().value);
                            }
                        }
                    });
                }
            } catch (pollErr) {
                // Ignorar 404 (el coordinador es sistemasDistribuidosx y usa PUSH, o la ruta no existe)
            }
        } catch (err) {
            // Camino Rápido (Fast Failover): si el nodo responde con redirect
            if (err.response && err.response.data && err.response.data.type === "redirect") {
                const data = err.response.data.data || {};
                logger.warn(`Coordinador indica que NO es líder. Redirigiendo a: ${data.leaderUrl}`);
                clearInterval(_handle);
                _handle = null;
                if (_onLost) _onLost(data.leaderUrl);
                return;
            }

            _failCount++;
            logger.warn(`Pulso fallido (${_failCount}/${MAX_FAILURES}): ${err.message}`);

            if (_failCount >= MAX_FAILURES) {
                logger.warn("Coordinador perdido — activando hunting loop");
                journal.record("caida", { coordinador: _parentUrl, razon: err.message });
                clearInterval(_handle);
                _handle = null;
                if (_onLost) _onLost();
            }
        }
    }, PULSE_INTERVAL);

    logger.pulse(`Pulsos iniciados → ${parentUrl} cada ${PULSE_INTERVAL}ms`);
}

/**
 * Detiene el servicio de pulsos.
 */
function stop() {
    clearInterval(_handle);
    _handle = null;
}

/**
 * Actualiza el coordinador padre en caliente.
 */
function setParent(parentUrl) {
    _parentUrl = parentUrl;
    _failCount = 0;
}

module.exports = { start, stop, setParent };
