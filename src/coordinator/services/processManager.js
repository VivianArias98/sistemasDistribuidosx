/**
 * processManager.js — Spawner de procesos worker desde el coordinador
 * Permite lanzar workers programáticamente (usado en scripts/cluster.js y en tests).
 */
const { spawn } = require("child_process");
const path = require("path");

const WORKER_ENTRY = path.resolve(__dirname, "../../worker/index.js");

/** @type {Map<string, import('child_process').ChildProcess>} */
const processes = new Map();

/**
 * Lanza un worker como proceso hijo.
 * @param {string} name
 * @param {number} port
 * @param {string[]} coordinators  - URLs de coordinadores
 * @returns {import('child_process').ChildProcess}
 */
function spawnWorker(name, port, coordinators = []) {
    const env = {
        ...process.env,
        WORKER_PORT:  String(port),
        WORKER_NAME:  name,
        COORDINATORS: coordinators.join(","),
    };

    const child = spawn("node", [WORKER_ENTRY], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
    });

    child.stdout.on("data", d => process.stdout.write(`[Worker:${name}] ${d}`));
    child.stderr.on("data", d => process.stderr.write(`[Worker:${name}] ${d}`));
    child.on("exit", code => {
        processes.delete(name);
        console.log(`[ProcessManager] Worker '${name}' salió con código ${code}`);
    });

    processes.set(name, child);
    return child;
}

/**
 * Termina un worker por nombre.
 */
function killWorker(name) {
    const child = processes.get(name);
    if (child) {
        child.kill("SIGTERM");
        processes.delete(name);
        return true;
    }
    return false;
}

/**
 * Lista de workers activos.
 */
function listWorkers() {
    return [...processes.keys()];
}

module.exports = { spawnWorker, killWorker, listWorkers };
