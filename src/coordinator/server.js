/**
 * server.js — Entry point del Coordinador
 * Inicia Express, el engine de elección y los servicios de soporte.
 */
const app     = require("./app");
const config  = require("./config");
const { init } = require("./election/engine");
const cleanup = require("./services/cleanup");
const logger  = require("./utils/logger");

const ALGO = process.env.ALGO || "bully";

app.listen(config.port, async () => {
    console.log("═".repeat(60));
    console.log(`🚀 COORDINADOR DISTRIBUIDO INICIADO`);
    console.log(`🆔 ID del Nodo  : ${config.nodeId}`);
    console.log(`📍 Puerto       : ${config.port}`);
    console.log(`🌐 URL Base     : ${config.baseUrl}`);
    console.log(`⚙️  Algoritmo   : ${ALGO}`);
    console.log(`⏱️  Preset      : ${config.timingPreset} (heartbeat: ${config.timing.heartbeat}ms)`);
    console.log(`🔗 Peers config : ${config.peerUrls.join(", ") || "ninguno (modo standalone)"}`);
    console.log(`📊 Dashboard    : http://localhost:${config.port}`);
    console.log(`🗳️  Elección    : http://localhost:${config.port}/election.html`);
    console.log("═".repeat(60));

    // Iniciar detector de timeout de workers
    cleanup.start();

    // Iniciar engine de elección
    await init(ALGO);

    logger.info(config.nodeId, `Coordinador listo — Algoritmo: ${ALGO}, Peers: ${config.peerUrls.length}`);
});

// ─── Apagado limpio ────────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
    logger.warn(config.nodeId, "SIGTERM recibido — apagando...");
    cleanup.stop();
    process.exit(0);
});

process.on("SIGINT", () => {
    logger.warn(config.nodeId, "SIGINT recibido — apagando...");
    cleanup.stop();
    process.exit(0);
});
