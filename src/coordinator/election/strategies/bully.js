/**
 * bully.js — Implementación del Algoritmo Bully (Garcia-Molina, 1982)
 *
 * Estados del nodo: follower | candidate | leader
 *
 * Protocolo:
 *  - ELECTION:    Enviado a todos los peers con ID > selfId.
 *  - ANSWER:      Respuesta de un peer superior ("sigues vivo, cede").
 *  - COORDINATOR: Broadcast proclamándose nuevo líder.
 */
const ElectionStrategy = require("./_template");
const { isHigher, higherPeers } = require("../ids");
const transport = require("../transport");
const events    = require("../events");
const logger    = require("../../utils/logger");

class BullyStrategy extends ElectionStrategy {
    constructor(engine) {
        super(engine);
        this._electionTimer = null;    // Timer de autoproclamación si nadie responde
        this._reaffirmCount = 0;       // Contador de ticks del líder para reafirmación periódica
    }

    get name() { return "bully"; }

    // ─── INICIAR ELECCIÓN ────────────────────────────────────────────────────

    async startElection() {
        const e = this.engine;
        if (e.role === "candidate") return;   // Ya hay elección en curso (antirrebote)

        e.role = "candidate";
        e.term += 1;
        events.emit("election-start", { from: e.selfId, term: e.term });
        logger.election(e.selfId, `Iniciando elección — Término ${e.term}`);

        const higher = higherPeers(e.knownPeers(), e.selfId);

        if (higher.length === 0) {
            // Soy el de mayor ID, me proclamo líder directamente
            this._becomeLeader();
            return;
        }

        // Enviar ELECTION a todos los peers con ID mayor
        higher.forEach(peer => {
            transport.post(`${peer.url}/election/message`, {
                from: { id: e.selfId, url: e.selfUrl },
                type: "ELECTION",
                payload: { term: e.term }
            }, { timeout: e.timing.rpcTimeout }).catch(() => {});
        });

        // Ventana antirrebote: esperar electionMin..electionMax ms antes de autoproclamarse
        // Si no responde nadie de ID mayor con 'ANSWER' en este tiempo -> me proclamo líder
        const wait = e.timing.electionMin + Math.random() * (e.timing.electionMax - e.timing.electionMin);
        clearTimeout(this._electionTimer);
        this._electionTimer = setTimeout(() => {
            // Solo autoproclamarse si todavía somos candidatos (nadie mandó ANSWER)
            if (e.role === "candidate") {
                this._becomeLeader();
            }
        }, wait);
    }

    // ─── MANEJAR MENSAJES ENTRANTES ──────────────────────────────────────────

    async handleMessage({ from, type, payload }, res) {
        const e = this.engine;

        if (type === "ELECTION") {
            // Un nodo inferior nos pregunta si seguimos vivos
            logger.election(e.selfId, `ELECTION recibido de ${from.id}`);
            // Responde {"ok":true} y ya. Las respuestas del algoritmo viajan como mensajes nuevos
            res.json({ ok: true });

            // Contesta 'ANSWER' enviando mensaje al emisor
            if (from?.url) {
                transport.post(`${from.url}/election/message`, {
                    from: { id: e.selfId, url: e.selfUrl },
                    type: "ANSWER",
                    payload: { term: e.term }
                }, { timeout: e.timing.rpcTimeout }).catch(() => {});
            }

            // Si somos follower/candidate y tenemos ID mayor, iniciar nuestra propia elección
            if (e.role !== "leader" && isHigher(e.selfId, from.id)) {
                setImmediate(() => this.startElection());
            }

        } else if (type === "ANSWER") {
            // Alguien mayor que yo está vivo → el retador se calla y espera
            logger.election(e.selfId, `ANSWER recibido de ${from.id} (Alguien mayor que yo está vivo) — El retador se calla y espera`);
            clearTimeout(this._electionTimer);
            e.role = "follower";
            res.json({ ok: true });

        } else if (type === "COORDINATOR") {
            // Si recibo un COORDINATOR de alguien menor que yo → no lo acepto, convoco elección (soy el matón)
            if (isHigher(e.selfId, from.id) && e.role !== "follower") {
                logger.election(e.selfId, `COORDINATOR de ${from.id} rechazado (menor que yo) — no lo acepto, convoco elección (soy el matón)`);
                res.json({ ok: true });
                setImmediate(() => this.startElection());
            } else {
                // Acepto al nuevo líder
                clearTimeout(this._electionTimer);
                e.role = "follower";
                e.leaderId  = from.id;
                e.leaderUrl = from.url;
                e.term = payload?.term ?? e.term;
                logger.leader(e.selfId, `Aceptan al nuevo líder: ${from.id} (${from.url})`);
                events.emit("leader-accepted", { leader: from.id, leaderUrl: from.url, term: e.term });
                res.json({ ok: true });
            }

        } else {
            res.status(400).json({ error: `Tipo de mensaje desconocido: ${type}` });
        }
    }

    // ─── TICK DEL LÍDER (reafirmación periódica) ─────────────────────────────

    async leaderTick() {
        this._reaffirmCount++;
        // Reafirmar cada 3 ticks de heartbeat
        if (this._reaffirmCount % 3 !== 0) return;

        const e = this.engine;
        logger.leader(e.selfId, "Reafirmando liderazgo en broadcast");
        const peers = e.knownPeers();
        peers.forEach(peer => {
            transport.post(`${peer.url}/election/message`, {
                from: { id: e.selfId, url: e.selfUrl },
                type: "COORDINATOR",
                payload: { term: e.term }
            }, { timeout: e.timing.rpcTimeout }).catch(() => {});
        });
    }

    // ─── PRIVADO ─────────────────────────────────────────────────────────────

    _becomeLeader() {
        const e = this.engine;
        e.role      = "leader";
        e.leaderId  = e.selfId;
        e.leaderUrl = e.selfUrl;
        logger.leader(e.selfId, `👑 Me proclamo líder (no respondió nadie de ID mayor) -> a todos — Término ${e.term}`);
        events.emit("election-won", { leader: e.selfId, leaderUrl: e.selfUrl, term: e.term });

        // Broadcast COORDINATOR a todos los peers
        e.knownPeers().forEach(peer => {
            transport.post(`${peer.url}/election/message`, {
                from: { id: e.selfId, url: e.selfUrl },
                type: "COORDINATOR",
                payload: { term: e.term }
            }, { timeout: e.timing.rpcTimeout }).catch(() => {});
        });
    }
}

module.exports = BullyStrategy;
