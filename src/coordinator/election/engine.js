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
const config = require("../config");
const faults = require("./faults");
const transport = require("./transport");
const events = require("./events");
const strategies = require("./strategies");
const logger = require("../utils/logger");

// ─── Estado del nodo ──────────────────────────────────────────────────────────

/** @type {"follower"|"candidate"|"leader"} */
let role = "follower";
let term = 0;
let leaderId = null;
let leaderUrl = null;

/**
 * Peers conocidos: Map<url, { id, url, alive, lastSeen, snapshot }>
 */
const peers = new Map();
const disconnectedPeers = new Set();

// ─── Estrategia activa ────────────────────────────────────────────────────────

let strategy = null;

// ─── API pública (expuesta como "engine") ─────────────────────────────────────

const engine = {
    get selfId() { return config.nodeId; },
    get selfUrl() { return config.baseUrl; },
    get timing() { return config.timing; },

    get role() { return role; },
    set role(v) { role = v; },

    get term() { return term; },
    set term(v) { term = v; },

    get leaderId() { return leaderId; },
    set leaderId(v) { leaderId = v; },

    get leaderUrl() { return leaderUrl; },
    set leaderUrl(v) { leaderUrl = v; },
    //jnd

    /**
     * Retorna array de peers vivos/conocidos como [{id, url, alive, lastSeen}]
     */
    knownPeers() {
        return [...peers.values()];
    },

    /**
     * Permite explícitamente volver a conectar un peer previamente desconectado
     */
    allowPeer(url) {
        if (url) disconnectedPeers.delete(url.replace(/\/$/, ""));
    },

    /**
     * Añade o actualiza un peer conocido.
     */
    upsertPeer(id, url, extraData = {}) {
        const cleanUrl = url ? url.replace(/\/$/, "") : null;
        const cleanSelf = engine.selfUrl ? engine.selfUrl.replace(/\/$/, "") : null;
        if (!cleanUrl || cleanUrl === cleanSelf || disconnectedPeers.has(cleanUrl)) return;
        if (id && engine.selfId && id === engine.selfId) return;

        // Evitar contaminación P2P: si nosotros somos un nodo remoto (ej. ngrok), ignoramos IPs locales de otros nodos mal configurados
        const isSelfRemote = cleanSelf && !cleanSelf.includes("localhost") && !cleanSelf.includes("127.0.0.1");
        const isTargetLocal = cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1");
        if (isSelfRemote && isTargetLocal) {
            return;
        }

        // Limpiar cualquier otra URL que tenga este mismo ID exacto para no tener duplicados (si el ID cambió de URL)
        if (id) {
            for (const [existingUrl, peer] of peers.entries()) {
                if (peer.id === id && existingUrl !== cleanUrl) {
                    peers.delete(existingUrl);
                    logger.warn(engine.selfId, `Limpieza: el peer '${id}' cambió su URL de ${existingUrl} a ${cleanUrl}`);
                }
            }
        }

        const existing = peers.get(cleanUrl) || {};
        const oldId = existing.id;

        peers.set(cleanUrl, {
            ...existing,
            id: id || existing.id || cleanUrl,
            url: cleanUrl,
            alive: true,
            lastSeen: Date.now(),
            discoveredVia: existing.discoveredVia || (extraData ? extraData.discoveredVia : null) || null,
            ...extraData,
        });

        if (oldId && id && oldId !== id && oldId !== cleanUrl) {
            logger.warn(engine.selfId, `Peer renombrado en ${cleanUrl}: era '${oldId}', ahora es '${id}'`);

            // Si el peer que se acaba de renombrar era nuestro líder reconocido, actualizamos el tracker de líder
            if (engine.leaderId === oldId) {
                engine.leaderId = id;
                logger.warn(engine.selfId, `El líder actual ha cambiado su nombre a '${id}'`);
            }
        }
    },

    /**
     * Snapshot del estado actual para compartir vía gossip y endpoints.
     * Cumple estrictamente con el formato JSON requerido:
     * {
     *   "id": "A",
     *   "url": "http://192.168.1.42:3000",
     *   "role": "leader", // "leader" | "follower" | "candidate"
     *   "leader": "A",
     *   "leaderUrl": "http://192.168.1.42:3000",
     *   "peers": [ { "id": "B", "url": "...", "alive": true } ]
     * }
     */
    snapshot() {
        const isLeader = role === "leader";
        const currentLeader = isLeader ? engine.selfId : (leaderId || null);
        const currentLeaderUrl = isLeader ? engine.selfUrl : (leaderUrl || null);

        const snap = {
            id: engine.selfId,
            url: engine.selfUrl,
            role: role,
            leader: currentLeader,
            leaderUrl: currentLeaderUrl,
            peers: engine.knownPeers().map(p => ({
                id: p.id,
                url: p.url,
                alive: Boolean(p.alive),
            })),
        };

        // Propiedades auxiliares para uso interno en JS (no se incluyen en JSON / res.json)
        Object.defineProperty(snap, "leaderId", {
            value: currentLeader,
            enumerable: false,
            writable: true,
        });
        Object.defineProperty(snap, "term", {
            value: term,
            enumerable: false,
            writable: true,
        });
        Object.defineProperty(snap, "uptime", {
            value: process.uptime(),
            enumerable: false,
            writable: true,
        });
        Object.defineProperty(snap, "faults", {
            value: faults.snapshot(),
            enumerable: false,
            writable: true,
        });

        return snap;
    },

    /**
     * Elimina un peer del registro y evita reincorporación automática
     */
    removePeer(url) {
        const cleanUrl = url ? url.replace(/\/$/, "") : null;
        if (!cleanUrl) return false;
        disconnectedPeers.add(cleanUrl);
        let removed = false;

        if (peers.has(cleanUrl)) {
            const peerData = peers.get(cleanUrl);
            const peerId = peerData ? peerData.id : null;

            peers.delete(cleanUrl);
            logger.info(engine.selfId, `Peer desconectado manualmente: ${cleanUrl}`);
            events.emit("cluster-update", { action: "peer-removed", url: cleanUrl });
            removed = true;

            // Si el peer que estamos desconectando era nuestro líder actual, debemos iniciar una elección
            const currentLeader = role === "leader" ? engine.selfId : leaderId;
            if ((peerId && peerId === currentLeader) || cleanUrl === leaderUrl) {
                logger.election(engine.selfId, `Líder ${peerId || cleanUrl} desconectado manualmente → iniciando elección`);
                events.emit("leader-lost", { leaderId: peerId, leader: peerId });
                leaderId = null;
                leaderUrl = null;
                role = "candidate";
                if (strategy && strategy.startElection) {
                    strategy.startElection();
                }
            }
        }
        return removed;
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
                }, { timeout: engine.timing.rpcTimeout }).catch(() => { });
            }
        }
    },

    /**
     * Fuerza una nueva elección (dimisión del líder actual).
     */
    async triggerElection() {
        role = "follower";
        leaderId = null;
        leaderUrl = null;
        events.emit("leader-lost", { from: engine.selfId });
        await strategy.startElection();
    },

    /**
     * Procesa un mensaje de elección entrante.
     */
    async handleElectionMessage(msg, res) {
        if (faults.paused) return res.status(503).json({ error: "Nodo pausado (chaos)" });

        // Evitar que workers participen en la elección
        const senderId = msg?.from?.id;
        if (senderId && !isNaN(Number(senderId))) {
            logger.info(engine.selfId, `Ignorando mensaje de elección de worker/puerto: ${senderId}`);
            return res.status(403).json({ error: "Los workers no pueden participar en la elección" });
        }

        // Evitar contaminación P2P de mensajes de elección: 
        // Si el remitente reporta una URL local pero nosotros somos remotos, lo ignoramos.
        // Esto evita que un peer mal configurado se autoproclame líder inalcanzable.
        const cleanSelf = engine.selfUrl ? engine.selfUrl.replace(/\/$/, "") : null;
        const senderUrl = msg?.from?.url ? msg.from.url.replace(/\/$/, "") : null;
        const isSelfRemote = cleanSelf && !cleanSelf.includes("localhost") && !cleanSelf.includes("127.0.0.1");
        const isTargetLocal = senderUrl && (senderUrl.includes("localhost") || senderUrl.includes("127.0.0.1"));

        if (isSelfRemote && isTargetLocal) {
            logger.warn(engine.selfId, `Ignorando mensaje de elección de ${senderId} por URL local inválida (${senderUrl}) en entorno remoto`);
            return res.status(400).json({ error: "No se admiten URLs locales en entorno remoto" });
        }

        await strategy.handleMessage(msg, res);
    },
};

// ─── Loop principal ────────────────────────────────────────────────────────────

let _loopHandle = null;

function isValidPeer(peerId) {
    if (!peerId) return false;
    if (typeof peerId === "object") return false;
    if (String(peerId) === "[object Object]") return false;
    if (!isNaN(Number(peerId))) return false;
    if (String(peerId).startsWith("http")) return false;
    if (String(peerId).length > 20) return false;
    return true;
}

async function _tick() {
    if (faults.paused) return;

    const now = Date.now();

    // — Limpiar auto-registro fantasma del propio nodo en cada ciclo —
    const registry = require("../services/registry");
    if (engine.selfId && engine.selfId !== "UNCONFIGURED" && registry.removeSelf) {
        registry.removeSelf(engine.selfId, engine.selfUrl);
    }

    // — Gossip: ping a todos los peers enviando snapshot estricto —
    for (const [url, peer] of peers) {
        try {
            const snap = engine.snapshot();
            // Payload dual-formato:
            // - Nuestro formato: { id, url, role, leader, peers }
            // - Formato Juan Diego: { from: {id, url, role, currentLeader, term}, peers }
            const pingPayload = {
                ...snap,
                from: {
                    id: snap.id,
                    url: snap.url,
                    role: snap.role,
                    currentLeader: snap.leader,
                    term: snap.term,
                },
            };
            const resp = await transport.post(
                `${url}/election/ping`,
                pingPayload,
                { timeout: engine.timing.rpcTimeout }
            );

            const data = resp.data || {};

            // Registrarse también como worker en el peer para aparecer en su Naming Service ("Quién se conecta a mi servidor")
            if (engine.selfId && engine.selfId !== "UNCONFIGURED" && engine.selfUrl) {
                transport.post(
                    `${url}/register`,
                    {
                        name: engine.selfId,
                        url: engine.selfUrl,
                        platform: process.platform,
                        hostname: require("os").hostname(),
                    },
                    { timeout: engine.timing.rpcTimeout }
                ).then(() => {
                    return transport.post(
                        `${url}/pulse/${encodeURIComponent(engine.selfId)}`,
                        {},
                        { timeout: engine.timing.rpcTimeout }
                    );
                }).catch(() => { });
            }

            // Actualizar el ID real del peer desde su respuesta
            const resolvedId = data.id || peer.id || url;
            peers.set(url, {
                ...peer,
                id: resolvedId,
                alive: true,
                lastSeen: now,
                snapshot: data,
            });

            // Descubrimiento transitivo: incorporar peers del peer
            if (Array.isArray(data.peers)) {
                const cleanSelf = engine.selfUrl ? engine.selfUrl.replace(/\/$/, "") : null;
                for (const p of data.peers) {
                    const cleanPUrl = p.url ? p.url.replace(/\/$/, "") : null;
                    if (cleanPUrl && cleanPUrl !== cleanSelf && isValidPeer(p.id)) {
                        if (!peers.has(cleanPUrl)) {
                            engine.upsertPeer(p.id, cleanPUrl, { discoveredVia: resolvedId });
                            logger.gossip(engine.selfId, `Nuevo peer descubierto transitivamente: ${p.id} (${cleanPUrl}) vía ${resolvedId}`);
                        } else if (p.id && p.id !== cleanPUrl) {
                            // Actualizar ID si antes teníamos la URL como ID
                            const existing = peers.get(cleanPUrl);
                            if (existing && (!existing.id || existing.id === cleanPUrl)) {
                                peers.set(cleanPUrl, { ...existing, id: p.id });
                            }
                        }
                    }
                }
            }

            // Sincronización de líder por gossip
            if (data.role === "leader") {
                if (engine.role === "follower" && (!leaderId || leaderId === resolvedId)) {
                    leaderId = resolvedId;
                    leaderUrl = data.url || url;
                } else if (engine.role === "leader" && resolvedId !== engine.selfId) {
                    const { isHigher } = require("./ids");
                    if (isHigher(resolvedId, engine.selfId)) {
                        logger.election(engine.selfId, `Gossip: Líder superior detectado (${resolvedId}) → cedo liderazgo`);
                        role = "follower";
                        leaderId = resolvedId;
                        leaderUrl = data.url || url;
                    }
                }
            }

            if (!peer.alive) {
                logger.recovery(engine.selfId, `Peer recuperado: ${resolvedId} (${url})`);
                events.emit("peer-up", { id: resolvedId, url });
            }

        } catch (err) {
            const elapsed = now - (peer.lastSeen || now);

            // Detectar fallos duros instantáneos (ej: ngrok apagado = 502 Bad Gateway / 504, o servidor local apagado = ECONNREFUSED)
            const isHardFailure = err.response && (err.response.status === 502 || err.response.status === 504 || err.response.status === 404) ||
                err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';

            if (peer.alive && (isHardFailure || elapsed > engine.timing.suspect)) {
                peers.set(url, { ...peer, alive: false });

                if (isHardFailure) {
                    logger.timeout(engine.selfId, `Peer CAÍDO INSTANTÁNEAMENTE (Fallo de Red/Ngrok apagado): ${peer.id} (${url})`);
                } else {
                    logger.timeout(engine.selfId, `Peer CAÍDO (${elapsed}ms sin respuesta): ${peer.id} (${url})`);
                }

                events.emit("peer-down", { id: peer.id, url });

                // Si el peer caído era el líder, disparar elección
                const currentLeader = role === "leader" ? engine.selfId : leaderId;
                if (peer.id === currentLeader || url === leaderUrl) {
                    logger.election(engine.selfId, `Líder ${peer.id} caído → iniciando elección`);
                    events.emit("leader-lost", { leaderId: peer.id, leader: peer.id });
                    leaderId = null;
                    leaderUrl = null;
                    strategy.startElection().catch(() => { });
                }
            }

            // Si pasan más de 20 segundos sin respuesta, eliminamos el peer fantasma automáticamente de la tabla de Salientes
            if (elapsed > 20000) {
                peers.delete(url);
                logger.info(engine.selfId, `Peer ELIMINADO automáticamente tras >20s sin respuesta: ${peer.id} (${url})`);
                // También emitimos un evento por si alguna estrategia necesita saber que el peer desapareció por completo
                events.emit("peer-removed", { id: peer.id, url });
            }
        }
    }

    // — Tick del líder (reafirmación periódica via estrategia) —
    if (role === "leader") {
        strategy.leaderTick().catch(() => { });
    }
}

/**
 * Inicia el loop gossip.
 */
function start() {
    if (_loopHandle) return;
    _loopHandle = setInterval(() => _tick().catch(() => { }), engine.timing.heartbeat);
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
            strategy.startElection().catch(() => { });
        }
    }, engine.timing.heartbeat * 2);
}

module.exports = { engine, init, start, stop };
