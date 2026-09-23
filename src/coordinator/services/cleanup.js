/**
 * cleanup.js — Detector de Timeout para workers inactivos
 * Revisa cada 3 segundos si algún worker superó el WORKER_TIMEOUT_MS sin enviar pulso.
 */
const config   = require("../config");
const registry = require("./registry");
const events   = require("../election/events");
const logger   = require("../utils/logger");

let _handle = null;

function start() {
    if (_handle) return;

    _handle = setInterval(() => {
        const now = Date.now();
        for (const worker of registry.list()) {
            const elapsed = now - worker.lastHeartbeat;
            if (elapsed > config.workerTimeoutMs && worker.status === "ACTIVO") {
                registry.markFallen(worker.name);
                logger.timeout("Cleanup", `Worker CAÍDO tras ${Math.floor(elapsed / 1000)}s: ${worker.name}`);
                events.emit("worker-down", { name: worker.name, url: worker.url });
            }
            
            // Si pasan más de 45 segundos sin latido, lo desconectamos/eliminamos automáticamente de la tabla.
            // EXCEPCIÓN: Si tiene localPort, es un proxy de Gateway. NO lo eliminamos para no perder el ruteo.
            if (elapsed > 45000) {
                if (worker.localPort) {
                    // Mantener el mapping del Gateway vivo, pero marcarlo caído visualmente
                    if (worker.status !== "CAIDO") {
                        registry.markFallen(worker.name);
                        logger.info("Cleanup", `Gateway Worker '${worker.name}' marcado como CAIDO pero conservado para ruteo.`);
                    }
                } else {
                    registry.unregister(worker.name);
                    logger.info("Cleanup", `Worker ELIMINADO automáticamente tras >45s sin latido: ${worker.name}`);
                }
            }
        }
    }, 3000);

    logger.info("Cleanup", `Detector de timeout iniciado — límite: ${config.workerTimeoutMs / 1000}s`);
}

function stop() {
    clearInterval(_handle);
    _handle = null;
}

module.exports = { start, stop };
