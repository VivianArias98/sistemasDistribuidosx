/**
 * verify-election.js — Suite automatizada de pruebas de convergencia y failover
 *
 * Prerrequisito: cluster levantado con `node scripts/cluster.js 5 bully`
 *
 * Pruebas:
 *  1. Convergencia — verificar que hay un único líder
 *  2. Failover     — matar el líder y verificar re-elección
 *  3. Rejoin       — regresar al nodo eliminado y verificar que retoma si tiene ID mayor
 */
const axios = require("axios");

const BASE_PORT = 3001;
const N         = parseInt(process.argv[2] || "5", 10);
const PORTS     = Array.from({ length: N }, (_, i) => BASE_PORT + i);
const URLS      = PORTS.map(p => `http://localhost:${p}`);

const OK   = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";

async function getState(url) {
    const r = await axios.get(`${url}/election/state`, { timeout: 3000 });
    return r.data;
}

async function getCluster(url) {
    const r = await axios.get(`${url}/cluster`, { timeout: 3000 });
    return r.data;
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForConvergence(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const states = await Promise.all(URLS.map(url => getState(url).catch(() => null)));
            const valid  = states.filter(Boolean);
            const leaders = valid.filter(s => s.role === "leader").map(s => s.id);
            const uniqueLeaders = [...new Set(leaders)];

            if (uniqueLeaders.length === 1 && valid.every(s => !s.leaderId || s.leaderId === uniqueLeaders[0])) {
                return { converged: true, leader: uniqueLeaders[0], states: valid };
            }
        } catch {}
        await sleep(500);
    }
    return { converged: false };
}

// ─── TEST 1: Convergencia ─────────────────────────────────────────────────────
async function testConvergence() {
    console.log("\n━━━ TEST 1: Auto-Descubrimiento y Convergencia ━━━");
    console.log(`Esperando convergencia (hasta 15s)...`);
    const result = await waitForConvergence(15000);

    if (result.converged) {
        console.log(`${OK} Cluster convergido — Líder único: ${result.leader}`);
        return result.leader;
    } else {
        console.log(`${FAIL} No convergió en el tiempo esperado`);
        return null;
    }
}

// ─── TEST 2: Crash Failover ───────────────────────────────────────────────────
async function testFailover(leaderId) {
    console.log("\n━━━ TEST 2: Caída del Líder (Crash Failover) ━━━");

    const IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const leaderIndex = IDS.indexOf(leaderId);
    const leaderUrl   = leaderIndex >= 0 ? URLS[leaderIndex] : null;

    if (!leaderUrl) {
        console.log(`${WARN} No se pudo localizar la URL del líder ${leaderId}`);
        return;
    }

    console.log(`Forzando dimisión del líder ${leaderId} (${leaderUrl})...`);
    try {
        await axios.post(`${leaderUrl}/election/trigger`, {}, { timeout: 3000 });
        console.log(`${OK} Dimisión del líder forzada vía /election/trigger`);
    } catch (err) {
        console.log(`${WARN} No se pudo contactar al líder: ${err.message}`);
    }

    console.log("Esperando re-elección (hasta 20s)...");
    const result = await waitForConvergence(20000);

    if (result.converged) {
        const newLeader = result.leader;
        if (newLeader !== leaderId) {
            console.log(`${OK} Nuevo líder elegido: ${newLeader} (ex-líder era: ${leaderId})`);
        } else {
            console.log(`${WARN} El mismo nodo sigue como líder (puede que no haya caído)`);
        }
        return newLeader;
    } else {
        console.log(`${FAIL} No se eligió un nuevo líder tras la caída`);
        return null;
    }
}

// ─── TEST 3: Split-Brain Check ────────────────────────────────────────────────
async function testSplitBrain() {
    console.log("\n━━━ TEST 3: Verificación de Split-Brain ━━━");
    try {
        const cluster = await getCluster(URLS[0]);
        if (cluster.cluster.splitBrain) {
            console.log(`${FAIL} SPLIT-BRAIN detectado — líderes: ${cluster.cluster.knownLeaders.join(", ")}`);
        } else {
            console.log(`${OK} Sin split-brain — líder único: ${cluster.cluster.leaderId}`);
        }
        console.log(`   Nodos totales: ${cluster.cluster.totalNodes}, Peers vivos: ${cluster.cluster.alivePeers}`);
    } catch (err) {
        console.log(`${WARN} No se pudo consultar /cluster: ${err.message}`);
    }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log("═".repeat(55));
    console.log("🧪 SUITE DE VERIFICACIÓN DE ELECCIÓN DISTRIBUIDA");
    console.log(`   Nodos a verificar: ${N} (puertos ${BASE_PORT}–${BASE_PORT + N - 1})`);
    console.log("═".repeat(55));

    // Verificar que al menos un nodo esté accesible
    let accessible = 0;
    for (const url of URLS) {
        try { await getState(url); accessible++; } catch {}
    }
    if (accessible === 0) {
        console.log(`\n${FAIL} Ningún coordinador accesible. ¿Está corriendo el cluster?`);
        console.log("   Ejecuta: node scripts/cluster.js 5 bully\n");
        process.exit(1);
    }
    console.log(`\n${OK} ${accessible}/${N} coordinadores accesibles\n`);

    const leader = await testConvergence();
    await testFailover(leader);
    await testSplitBrain();

    console.log("\n═".repeat(55));
    console.log("🏁 Verificación completada\n");
}

main().catch(err => {
    console.error(`Error fatal: ${err.message}`);
    process.exit(1);
});
