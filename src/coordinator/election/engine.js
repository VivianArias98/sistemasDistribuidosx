/**
 * engine.js — Máquina de estados del cluster + Gossip/Heartbeat + Detector de Fallos
 *
 * Roles: follower → candidate → leader
 *
 * Responsabilidades:
 *  - Mantener el estado del nodo (role, term, leader, peers)
 *  - Ejecutar el loop gossip: ping a cada peer, intercambiar snapshot de peers
 *  - Detectar caídas (suspect timeout) y disparar elecciones
 *  - Delegar la lógica de elección a la estrategia activa (bully, ring, etc.)
 */
const config    = require("../config");
const faults    = require("./faults");
const transport = require("./transport");
const events    = require("./events");
const strategies = require("./strategies");
const logger    = require("../utils/logger");

// ─── Estado del nodo ──────────────────────────────────────────────────────────

/** @type {"follower"|"candidate"|"leader"} */
let role      = "follower";
let term      = 0;
let leaderId  = null;
let leaderUrl = null;

/**
 * Peers conocidos: Map<url, { id, url, alive, lastSeen, snapshot }>
 */
const peers = new Map();

// ─── Estrategia activa ────────────────────────────────────────────────────────

let strategy = null;

// ─── API pública (expuesta como "engine") ─────────────────────────────────────

const engine = {
    get selfId()    { return config.nodeId; },
    get selfUrl()   { return config.baseUrl; },
    get timing()    { return config.timing; },

    get role()      { return role; },
    set role(v)     { role = v; },

    get term()      { return term; },
    set term(v)     { term = v; },

    get leaderId()  { return leaderId; },
    set leaderId(v) { leaderId = v; },

    get leaderUrl() { return leaderUrl; },
    set leaderUrl(v){ leaderUrl = v; },

    /**
     * Retorna array de peers vivos/conocidos como [{id, url, alive, lastSeen}]
     */
    knownPeers() {
        return [...peers.values()];
    },

    /**
     * Añade o actualiza un peer conocido.
     */
    upsertPeer(id, url, extraData = {}) {
        const existing = peers.get(url);
        peers.set(url, {
            id:       id || (existing && existing.id) || url,
            url,
            alive:    true,
            lastSeen: Date.now(),
            snapshot: null,
            ...existing,
            ...extraData,
        });
    },

    /**
     * Snapshot del estado actual para compartir vía gossip.
     */
    snapshot() {
        return {
            id:        engine.selfId,
            url:       engine.selfUrl,
            role,
            term,
            leaderId,
            leaderUrl,
            // ¡Clave para eliminar fantasmas! Solo propagar peers que estén VIVOS.
            peers:     engine.knownPeers().filter(p => p.alive).map(p => ({ id: p.id, url: p.url })),
            faults:    faults.snapshot(),
            uptime:    process.uptime(),
            ts:        Date.now(),
        };
    },

    /**
     * Elimina un peer del registro.
     */
    removePeer(url) {
        if (peers.has(url)) {
            peers.delete(url);
            logger.info(engine.selfId, `Peer eliminado manualmente: ${url}`);
            events.emit("cluster-update", { action: "peer-removed", url });
            return true;
        }
        return false;
    },

    /**
     * Cambia la estrategia de elección en caliente y, si se solicita, la propaga a los peers.
     */
    async setStrategy(name, propagate = false) {
        strategy = strategies.create(name, engine);
        logger.election(engine.selfId, `Estrategia cambiada a: ${name}`);

        if (propagate) {
            for (const peer of peers.values()) {
                transport.post(`${peer.url}/election/algorithm`, {
                    algo: name, propagate: false
                }, { timeout: engine.timing.rpcTimeout }).catch(() => {});
            }
        }
    },

    /**
     * Fuerza una nueva elección (dimisión del líder actual).
     */
    async triggerElection() {
        role = "follower";
        leaderId  = null;
        leaderUrl = null;
        events.emit("leader-lost", { from: engine.selfId });
        await strategy.startElection();
    },

    /**
     * Procesa un mensaje de elección entrante.
     */
    async handleElectionMessage(msg, res) {
        if (faults.paused) return res.status(503).json({ error: "Nodo pausado (chaos)" });
        
        // Evitar que workers (cuyos IDs son números de puertos como 3000, 3002) 
        // participen en la elección y se vuelvan líderes.
        const senderId = msg?.from?.id;
        if (senderId && !isNaN(Number(senderId))) {
            logger.info(engine.selfId, `Ignorando mensaje de elección de worker/puerto: ${senderId}`);
            return res.status(403).json({ error: "Los workers no pueden participar en la elección" });
        }

        await strategy.handleMessage(msg, res);
    },
};

// ─── Loop principal ────────────────────────────────────────────────────────────

let _loopHandle = null;

async function _tick() {
    if (faults.paused) return;

    const now = Date.now();

    // — Gossip: ping a todos los peers —
    for (const [url, peer] of peers) {
        try {
            const resp = await transport.post(
                `${url}/election/ping`,
                { id: engine.selfId, url: engine.selfUrl, peers: engine.knownPeers().map(p => ({ id: p.id, url: p.url })) },
                { timeout: engine.timing.rpcTimeout }
            );

            const data = resp.data || {};

            // Actualizar el ID real del peer desde su respuesta (usa su NODE_ID letra, no la URL)
            const resolvedId = data.id || peer.id || url;
            peers.set(url, {
                ...peer,
                id:       resolvedId,
                alive:    true,
                lastSeen: now,
                snapshot: data,
            });

            // Descubrimiento transitivo: incorporar peers del peer
            if (Array.isArray(data.peers)) {
                for (const p of data.peers) {
                    if (p.url && p.url !== engine.selfUrl) {
                        if (!peers.has(p.url)) {
                            engine.upsertPeer(p.id, p.url);
                            logger.gossip(engine.selfId, `Nuevo peer descubierto transitivamente: ${p.id} (${p.url})`);
                        } else if (p.id && p.id !== p.url) {
                            // Actualizar ID si antes teníamos la URL como ID
                            const existing = peers.get(p.url);
                            if (existing && (!existing.id || existing.id === p.url)) {
                                peers.set(p.url, { ...existing, id: p.id });
                            }
                        }
                    }
                }
            }

            if (!peer.alive) {
                logger.recovery(engine.selfId, `Peer recuperado: ${resolvedId} (${url})`);
                events.emit("peer-up", { id: resolvedId, url });
            }

        } catch (err) {
            const elapsed = now - (peer.lastSeen || now);
            if (peer.alive && elapsed > engine.timing.suspect) {
                peers.set(url, { ...peer, alive: false });
                logger.timeout(engine.selfId, `Peer CAÍDO (${elapsed}ms sin respuesta): ${peer.id} (${url})`);
                events.emit("peer-down", { id: peer.id, url });

                // Si el peer caído era el líder, disparar elección
                if (peer.id === leaderId || url === leaderUrl) {
                    logger.election(engine.selfId, `Líder ${peer.id} caído → iniciando elección`);
                    events.emit("leader-lost", { leaderId: peer.id });
                    leaderId  = null;
                    leaderUrl = null;
                    strategy.startElection().catch(() => {});
                }
            }
        }
    }

    // — Tick del líder (reafirmación periódica via estrategia) —
    if (role === "leader") {
        strategy.leaderTick().catch(() => {});
    }
}

/**
 * Inicia el loop gossip.
 */
function start() {
    if (_loopHandle) return;
    _loopHandle = setInterval(() => _tick().catch(() => {}), engine.timing.heartbeat);
    logger.info(engine.selfId, `Engine iniciado — Preset: ${config.timingPreset}, heartbeat: ${engine.timing.heartbeat}ms`);
}

/**
 * Detiene el loop gossip.
 */
function stop() {
    clearInterval(_loopHandle);
    _loopHandle = null;
}

/**
 * Inicializa el engine con la estrategia y peers de la configuración.
 * @param {string} [algoName="bully"]
 */
async function init(algoName = "bully") {
    await engine.setStrategy(algoName);

    // Registrar peers iniciales desde config
    for (const url of config.peerUrls) {
        if (url !== engine.selfUrl) {
            engine.upsertPeer(null, url);
        }
    }

    start();

    // Dar tiempo al primer gossip antes de intentar arrancar
    setTimeout(() => {
        // Si no hay líder conocido, iniciar elección
        if (!leaderId) {
            logger.election(engine.selfId, "Sin líder conocido al arrancar → iniciando elección");
            strategy.startElection().catch(() => {});
        }
    }, engine.timing.heartbeat * 2);
}

module.exports = { engine, init, start, stop };
