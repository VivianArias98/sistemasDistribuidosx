/**
 * index.js — Registro dinámico de estrategias de elección
 * Permite cambiar el algoritmo en caliente sin reiniciar el coordinador.
 */
const BullyStrategy = require("./bully");

const REGISTRY = {
    bully: BullyStrategy,
};

/**
 * Instancia una estrategia por nombre.
 * @param {string} name  - nombre del algoritmo ("bully", …)
 * @param {object} engine
 * @returns {import('./_template')}
 */
function create(name, engine) {
    const Cls = REGISTRY[name.toLowerCase()];
    if (!Cls) throw new Error(`Algoritmo desconocido: "${name}". Disponibles: ${Object.keys(REGISTRY).join(", ")}`);
    return new Cls(engine);
}

/**
 * Lista de algoritmos disponibles.
 */
function available() {
    return Object.keys(REGISTRY);
}

module.exports = { create, available };
