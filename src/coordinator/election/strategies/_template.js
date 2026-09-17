/**
 * _template.js — Interfaz base para algoritmos de elección
 * Cualquier nueva estrategia debe exportar este contrato.
 *
 * @interface ElectionStrategy
 */

class ElectionStrategy {
    /**
     * @param {object} engine - Referencia al engine del cluster
     */
    constructor(engine) {
        if (new.target === ElectionStrategy) {
            throw new Error("ElectionStrategy es una interfaz abstracta, no instanciar directamente");
        }
        this.engine = engine;
    }

    /**
     * Nombre del algoritmo (para logs y API).
     * @returns {string}
     */
    get name() { throw new Error("name() no implementado"); }

    /**
     * Inicia una elección desde este nodo.
     */
    async startElection() { throw new Error("startElection() no implementado"); }

    /**
     * Procesa un mensaje entrante del protocolo de elección.
     * @param {{ from: {id, url}, type: string, payload: object }} msg
     * @param {import('express').Response} res  - para responder al HTTP
     */
    async handleMessage(msg, res) { throw new Error("handleMessage() no implementado"); }

    /**
     * Lógica periódica del líder (reafirmación, etc.).
     * Llamada cada heartbeat tick por el engine cuando role === "leader".
     */
    async leaderTick() {}
}

module.exports = ElectionStrategy;
