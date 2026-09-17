/**
 * cluster.js — Spawner de N coordinadores locales
 *
 * Uso:
 *   node scripts/cluster.js [N] [algo]
 *
 * Ejemplo:
 *   node scripts/cluster.js 5 bully
 *
 * Levanta N coordinadores en puertos 3001, 3002, … 3001+N-1
 * con IDs A, B, C, D, E (o el número de nodo si N > 26)
 */
const { spawn } = require("child_process");
const path      = require("path");

const N    = parseInt(process.argv[2] || "3", 10);
const ALGO = process.argv[3] || "bully";
const BASE_PORT = 3001;

const IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const COORDINATOR_ENTRY = path.resolve(__dirname, "../src/coordinator/server.js");

// Construir lista de URLs de todos los peers
const allUrls = Array.from({ length: N }, (_, i) => `http://localhost:${BASE_PORT + i}`);

const children = [];

console.log(`\n${"═".repeat(55)}`);
console.log(`🚀 Levantando cluster de ${N} coordinadores — Algoritmo: ${ALGO}`);
console.log(`${"═".repeat(55)}\n`);

for (let i = 0; i < N; i++) {
    const nodeId  = IDS[i] || String(i + 1);
    const port    = BASE_PORT + i;
    const selfUrl = `http://localhost:${port}`;
    const peers   = allUrls.filter(u => u !== selfUrl).join(",");

    const env = {
        ...process.env,
        NODE_ID:  nodeId,
        PORT:     String(port),
        BASE_URL: selfUrl,
        PEERS:    peers,
        ALGO,
        TIMING_PRESET: process.env.TIMING_PRESET || "lan",
    };

    const child = spawn("node", [COORDINATOR_ENTRY], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
    });

    const prefix = `[${nodeId}:${port}]`;
    child.stdout.on("data", d => process.stdout.write(`${prefix} ${d}`));
    child.stderr.on("data", d => process.stderr.write(`${prefix} ${d}`));
    child.on("exit", code => console.log(`\n${prefix} Proceso terminado (código ${code})\n`));

    children.push(child);
    console.log(`✅ Nodo ${nodeId} en puerto ${port} — Peers: ${peers || "ninguno"}`);
}

console.log(`\n🌐 Dashboard primer nodo: http://localhost:${BASE_PORT}`);
console.log(`🗳️  Elección primer nodo: http://localhost:${BASE_PORT}/election.html\n`);

// Apagado limpio: matar todos los hijos
function shutdown() {
    console.log("\n⛔ Apagando cluster...");
    children.forEach(c => c.kill("SIGTERM"));
    process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
