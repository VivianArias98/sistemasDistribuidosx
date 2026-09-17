/**
 * ids.js — Comparador de identificadores de nodo
 * Los IDs pueden ser letras ("A", "B"…), números o strings.
 * El nodo con el ID "mayor" (según esta comparación) gana la elección Bully.
 */

/**
 * Compara dos IDs. Intenta comparación numérica; si no, lexicográfica.
 * @param {string|number} a
 * @param {string|number} b
 * @returns {number} > 0 si a > b, < 0 si a < b, 0 si iguales
 */
function compareIds(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
}

/**
 * @param {string|number} a
 * @param {string|number} b
 * @returns {boolean} true si a > b
 */
function isHigher(a, b) {
    return compareIds(a, b) > 0;
}

/**
 * Dado un array de peers {id, url}, retorna los que tienen ID mayor al indicado.
 * @param {Array<{id: string, url: string}>} peers
 * @param {string|number} selfId
 */
function higherPeers(peers, selfId) {
    return peers.filter(p => isHigher(p.id, selfId));
}

module.exports = { compareIds, isHigher, higherPeers };
