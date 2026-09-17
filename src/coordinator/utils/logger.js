/**
 * logger.js — Logger con timestamp, nivel e íconos
 */

const ICONS = {
    INFO:        "ℹ️ ",
    WARN:        "⚠️ ",
    ERROR:       "❌",
    ELECTION:    "🗳️ ",
    LEADER:      "👑",
    FOLLOWER:    "📡",
    FAULT:       "💥",
    GOSSIP:      "🔁",
    REGISTER:    "📝",
    PULSE:       "💓",
    MSG:         "💬",
    TIMEOUT:     "⏰",
    RECOVERY:    "🟢",
    HOTRELOAD:   "🔄",
};

function fmt(level, tag, msg) {
    const t = new Date().toLocaleTimeString("es-MX", { hour12: false });
    const icon = ICONS[level] || ICONS[tag] || "  ";
    return `[${t}] ${icon} [${level}] ${tag ? `[${tag}] ` : ""}${msg}`;
}

const logger = {
    info:     (tag, msg) => console.log(fmt("INFO",     tag, msg)),
    warn:     (tag, msg) => console.warn(fmt("WARN",    tag, msg)),
    error:    (tag, msg) => console.error(fmt("ERROR",  tag, msg)),
    election: (tag, msg) => console.log(fmt("ELECTION", tag, msg)),
    leader:   (tag, msg) => console.log(fmt("LEADER",  tag, msg)),
    gossip:   (tag, msg) => console.log(fmt("GOSSIP",  tag, msg)),
    fault:    (tag, msg) => console.log(fmt("FAULT",   tag, msg)),
    pulse:    (tag, msg) => console.log(fmt("PULSE",   tag, msg)),
    msg:      (tag, msg) => console.log(fmt("MSG",     tag, msg)),
    timeout:  (tag, msg) => console.log(fmt("TIMEOUT", tag, msg)),
    recovery: (tag, msg) => console.log(fmt("RECOVERY",tag, msg)),
};

module.exports = logger;
