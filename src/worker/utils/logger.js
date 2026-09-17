/**
 * logger.js — Logger del Worker (misma interfaz que el coordinador)
 */
function fmt(level, msg) {
    const t = new Date().toLocaleTimeString("es-MX", { hour12: false });
    const icons = { INFO: "ℹ️ ", WARN: "⚠️ ", ERROR: "❌", PULSE: "💓", HUNT: "🔍", REG: "📝", MSG: "💬" };
    return `[${t}] ${icons[level] || "  "} [${level}] ${msg}`;
}

const logger = {
    info:  msg => console.log(fmt("INFO",  msg)),
    warn:  msg => console.warn(fmt("WARN",  msg)),
    error: msg => console.error(fmt("ERROR", msg)),
    pulse: msg => console.log(fmt("PULSE", msg)),
    hunt:  msg => console.log(fmt("HUNT",  msg)),
    reg:   msg => console.log(fmt("REG",   msg)),
    msg:   msg => console.log(fmt("MSG",   msg)),
};

module.exports = logger;
