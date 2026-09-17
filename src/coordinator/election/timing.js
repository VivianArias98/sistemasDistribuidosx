/**
 * timing.js — Perfiles de temporización para el motor de elección
 * Dos presets:
 *   - "lan"  → Localhost / pruebas locales (valores agresivos, convergencia rápida)
 *   - "wan"  → Túneles ngrok / aula (valores conservadores, tolerantes a latencia)
 */

const PRESETS = {
    lan: {
        tick: 250,          // ms — intervalo del loop principal del motor
        heartbeat: 600,     // ms — frecuencia de pings gossip a los peers
        suspect: 2500,      // ms — tiempo sin respuesta antes de marcar nodo como caído
        electionMin: 800,   // ms — espera mínima antes de autoproclamarse líder
        electionMax: 1600,  // ms — espera máxima (ventana antirrebote)
        rpcTimeout: 1000,   // ms — timeout de cada llamada HTTP saliente
    },
    wan: {
        tick: 500,
        heartbeat: 2000,
        suspect: 7000,
        electionMin: 4000,
        electionMax: 9000,
        rpcTimeout: 4000,
    },
    classroom: {   // alias de wan
        tick: 500,
        heartbeat: 2000,
        suspect: 7000,
        electionMin: 4000,
        electionMax: 9000,
        rpcTimeout: 4000,
    }
};

/**
 * Devuelve el preset activo según TIMING_PRESET o el nombre indicado.
 * @param {string} [name] - "lan" | "wan" | "classroom" (opcional)
 * @returns {object} preset de timing
 */
function getTiming(name) {
    const key = (name || process.env.TIMING_PRESET || "lan").toLowerCase();
    return PRESETS[key] || PRESETS.lan;
}

module.exports = { getTiming, PRESETS };
