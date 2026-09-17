const { spawn } = require("child_process");
const path      = require("path");

const COORDINATOR_ENTRY = path.resolve(__dirname, "../src/coordinator/server.js");

// ─── Configuración de la prueba del profesor ───
// 3 Nodos, donde cada uno SÓLO conoce a UNO de los otros (Topología en Anillo: A->B, B->C, C->A)
const nodes = [
    { id: "A", port: 3000, url: "http://localhost:3000", peer: "http://localhost:3001" },
    { id: "B", port: 3001, url: "http://localhost:3001", peer: "http://localhost:3002" },
    { id: "C", port: 3002, url: "http://localhost:3002", peer: "http://localhost:3000" }
];

console.log(`\n${"═".repeat(60)}`);
console.log(`🎓 PRUEBA DE COMPROBACIÓN (Topología Transitiva)`);
console.log(`- 3 Coordinadores`);
console.log(`- Cada uno apunta SOLO a UNO de los otros`);
console.log(`- Preset WAN (ngrok-ready) → Caídas se detectan en <10s (7s)`);
console.log(`${"═".repeat(60)}\n`);

const children = [];

nodes.forEach(n => {
    const env = {
        ...process.env,
        NODE_ID:       n.id,
        PORT:          String(n.port),
        BASE_URL:      n.url,
        PEERS:         n.peer,   // SOLO APUNTA A UNO
        ALGO:          "bully",
        TIMING_PRESET: "wan"     // Tolerancia alta (ngrok), timeout de caída 7 segundos
    };

    const child = spawn("node", [COORDINATOR_ENTRY], { env });
    
    const prefix = `[${n.id}:${n.port}]`;
    child.stdout.on("data", d => process.stdout.write(`${prefix} ${d}`));
    child.stderr.on("data", d => process.stderr.write(`${prefix} ${d}`));
    children.push(child);
    
    console.log(`✅ Iniciando Nodo ${n.id} apuntando a ${n.peer}`);
});

console.log(`\n🌐 Mira la magia en: http://localhost:3001/election.html`);
console.log(`👉 A los pocos segundos, verás que los 3 se descubren y la gráfica se conecta completa.`);
console.log(`👉 Luego, pausa un nodo desde la interfaz y verás que en ~7 segundos se marca rojo.\n`);

function shutdown() {
    children.forEach(c => c.kill("SIGTERM"));
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
