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
                {},
                { timeout: 3000 }
            );
            _failCount = 0;
            logger.pulse(`Pulso enviado → ${_parentUrl}`);
        } catch (err) {
            // Camino Rápido (Fast Failover): si el nodo responde 409 con el nuevo líder, saltamos de una vez
            if (err.response && err.response.status === 409) {
                const data = err.response.data || {};
                logger.warn(`Coordinador indica que NO es líder. Redirigiendo a: ${data.leader}`);
                clearInterval(_handle);
                _handle = null;
                if (_onLost) _onLost(data.leader, data.peers);
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
