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
        let anyAnswered = false;
        const answers = higher.map(peer =>
            transport.post(`${peer.url}/election/message`, {
                from: { id: e.selfId, url: e.selfUrl },
                type: "ELECTION",
                payload: { term: e.term }
            }, { timeout: e.timing.rpcTimeout })
            .then(() => { anyAnswered = true; })
            .catch(() => {})
        );

        await Promise.allSettled(answers);

        // Si ningún superior respondió tras el timeout de RPC, iniciar ventana de espera
        if (!anyAnswered) {
            logger.election(e.selfId, "Nadie respondió — esperando ventana de autoproclamación");
        }

        // Ventana antirrebote: esperar electionMin..electionMax ms antes de autoproclamarse
        const wait = e.timing.electionMin + Math.random() * (e.timing.electionMax - e.timing.electionMin);
        clearTimeout(this._electionTimer);
        this._electionTimer = setTimeout(() => {
            // Solo autoproclamarse si todavía somos candidatos
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
            res.json({ ok: true, type: "ANSWER", from: { id: e.selfId, url: e.selfUrl } });

            // Si somos follower/candidate y tenemos ID mayor, iniciar nuestra propia elección
            if (e.role !== "leader" && isHigher(e.selfId, from.id)) {
                setImmediate(() => this.startElection());
            }

        } else if (type === "ANSWER") {
            // Un superior nos dice que sigue vivo → cancelar autoproclamación
            logger.election(e.selfId, `ANSWER recibido de ${from.id} — cancelo autoproclamación`);
            clearTimeout(this._electionTimer);
            e.role = "follower";
            res.json({ ok: true });

        } else if (type === "COORDINATOR") {
            // Alguien se proclama líder
            if (isHigher(e.selfId, from.id) && e.role !== "follower") {
                // Soy superior y no estoy siguiendo — reto al nuevo "líder"
                logger.election(e.selfId, `COORDINATOR de ${from.id} rechazado — tengo mayor ID, iniciando elección`);
                res.json({ ok: false, reason: "challenger" });
                setImmediate(() => this.startElection());
            } else {
                // Acepto al nuevo líder
                clearTimeout(this._electionTimer);
                e.role = "follower";
                e.leaderId  = from.id;
                e.leaderUrl = from.url;
                e.term = payload?.term ?? e.term;
                logger.leader(e.selfId, `Nuevo líder aceptado: ${from.id} (${from.url})`);
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
        logger.leader(e.selfId, `👑 Me proclamo LÍDER — Término ${e.term}`);
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
