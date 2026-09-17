const express = require("express");
const os = require("os");

const app = express();

// Middleware para procesar JSON
app.use(express.json());

// Soporte CORS completo para acceso multiplataforma, multimáquina y túneles ngrok
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// Servir archivos estáticos del panel de observabilidad
app.use(express.static("public"));

// Manejo de JSON inválido
app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "JSON inválido en el cuerpo de la petición" });
    }
    next(err);
});

// Configuración del servidor padre (Middleware)
const PORT = process.env.PORT || 3000;
let PARENT_URL = process.env.PARENT_URL || `http://localhost:${PORT}`;

// Tiempo límite sin pulso para detectar caída (15 segundos)
const TIMEOUT = 15000;

// Almacenamiento en memoria del Servicio de Nombres (Naming Service)
// Estructura por servidor: { name, url, platform, hostname, lastHeartbeat, status, registeredAt, fallenAt }
let servers = {};

// Historial consolidado de mensajes distribuidos
let messageHistory = [];

// Historial estructurado de actividad para Observabilidad (máximo 150 eventos)
let activityLogs = [];

/**
 * Función auxiliar para registrar eventos con marca de tiempo y categorías de observabilidad
 */
function logEvent(type, serverName, message, details = null) {
    const timestamp = new Date();
    const formattedTime = timestamp.toLocaleTimeString();
    
    const event = {
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        timestamp: timestamp.toISOString(),
        timeStr: formattedTime,
        type, // REGISTRO, PULSO, MENSAJE, TIMEOUT, HOTRELOAD, RECUPERACION, ADVERTENCIA, ERROR
        server: serverName || "SISTEMA",
        message,
        details
    };

    activityLogs.unshift(event);
    if (activityLogs.length > 150) {
        activityLogs.pop();
    }

    const icons = {
        REGISTRO: "📝",
        PULSO: "💓",
        MENSAJE: "💬",
        TIMEOUT: "⚠️",
        HOTRELOAD: "🔄",
        RECUPERACION: "🟢",
        ADVERTENCIA: "⚠️",
        ERROR: "❌"
    };

    console.log(`[${formattedTime}] ${icons[type] || "ℹ️"} [${type}] ${serverName ? `[${serverName}] ` : ""}${message}`);
}

// -----------------------------------------------------------------------------
// SERVICIO DE NOMBRES (NAMING SERVICE) - ROBUSTEZ Y PREVENCIÓN DE DUPLICADOS
// -----------------------------------------------------------------------------

/**
 * POST /register
 * Registra un servidor en el Servicio de Nombres.
 * REGLA ESTRICTA: No se pueden crear dos servidores con el mismo nombre si ya existe uno ACTIVO.
 */
app.post("/register", (req, res) => {
    let { name, url, platform, hostname } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "El campo 'name' es obligatorio y debe ser un texto válido" });
    }
    if (!url || typeof url !== "string" || !url.trim()) {
        return res.status(400).json({ error: "El campo 'url' es obligatorio y debe ser una URL válida" });
    }

    name = name.trim();
    url = url.trim();

    // Comprobación de robustez en el Naming Service:
    const existing = servers[name];

    if (existing) {
        // Si el servidor existe y está ACTIVO:
        if (existing.status === "ACTIVO") {
            // Si proviene de una URL diferente, es un conflicto de nombres (suplantación / colisión)
            if (existing.url !== url) {
                const errorMsg = `Conflicto en Servicio de Nombres: Ya existe un servidor ACTIVO con el nombre '${name}' en la URL '${existing.url}'. No se permiten nombres duplicados.`;
                logEvent("ADVERTENCIA", name, `Intento de registro duplicado rechazado desde ${url}`, { urlRechazada: url, urlActiva: existing.url });
                return res.status(409).json({
                    error: errorMsg,
                    code: "NAME_CONFLICT",
                    activeUrl: existing.url
                });
            } else {
                // Es el mismo servidor reconectándose o renovando su registro
                existing.lastHeartbeat = Date.now();
                existing.platform = platform || existing.platform;
                existing.hostname = hostname || existing.hostname;
                logEvent("REGISTRO", name, `Servidor reconectado exitosamente en ${url}`);
                return res.json({
                    message: `Servidor '${name}' reconectado exitosamente`,
                    status: "ACTIVO",
                    server: existing
                });
            }
        } else {
            // El servidor existía pero estaba en estado CAIDO: se reactiva con su nueva o misma URL
            existing.url = url;
            existing.status = "ACTIVO";
            existing.lastHeartbeat = Date.now();
            existing.platform = platform || existing.platform;
            existing.hostname = hostname || existing.hostname;
            existing.fallenAt = null;

            logEvent("RECUPERACION", name, `Servidor previamente CAÍDO se ha reactivado en el Servicio de Nombres con URL: ${url}`);
            return res.json({
                message: `Servidor '${name}' reactivado exitosamente`,
                status: "ACTIVO",
                server: existing
            });
        }
    }

    // Nuevo servidor en el Servicio de Nombres
    const newServer = {
        name,
        url,
        platform: platform || "desconocida",
        hostname: hostname || "desconocido",
        lastHeartbeat: Date.now(),
        status: "ACTIVO",
        registeredAt: Date.now(),
        fallenAt: null,
        messages: []
    };

    servers[name] = newServer;
    logEvent("REGISTRO", name, `Registrado exitosamente en Servicio de Nombres con URL: ${url} (Plataforma: ${newServer.platform})`);

    res.status(201).json({
        message: `Servidor '${name}' registrado exitosamente en el Servicio de Nombres`,
        status: "ACTIVO",
        server: newServer
    });
});

/**
 * GET /resolve/:name
 * Resolución de nombres: busca la URL y estado a partir del nombre en el Servicio de Nombres.
 */
app.get("/resolve/:name", (req, res) => {
    const { name } = req.params;
    const server = servers[name];

    if (!server) {
        return res.status(404).json({ error: `Nombre '${name}' no encontrado en el Servicio de Nombres` });
    }

    res.json({
        name: server.name,
        url: server.url,
        status: server.status,
        platform: server.platform,
        lastHeartbeat: server.lastHeartbeat
    });
});

/**
 * GET /naming y GET /servers
 * Directorio completo del Servicio de Nombres
 */
app.get(["/naming", "/servers"], (req, res) => {
    const list = Object.values(servers).map(s => ({
        name: s.name,
        url: s.url,
        status: s.status,
        platform: s.platform,
        hostname: s.hostname,
        lastHeartbeat: s.lastHeartbeat,
        secondsWithoutPulse: Math.floor((Date.now() - s.lastHeartbeat) / 1000),
        registeredAt: s.registeredAt,
        messagesCount: (s.messages || []).length
    }));
    res.json(list);
});

/**
 * POST /unregister/:name
 * Desregistro voluntario de un servidor
 */
app.post("/unregister/:name", (req, res) => {
    const { name } = req.params;
    if (!servers[name]) {
        return res.status(404).json({ error: `Servidor '${name}' no encontrado` });
    }
    delete servers[name];
    logEvent("REGISTRO", name, `Servidor desregistrado del Servicio de Nombres`);
    res.json({ message: `Servidor '${name}' desregistrado exitosamente` });
});

// -----------------------------------------------------------------------------
// LATIDOS (HEARTBEATS / PULSOS) Y TIMEOUT (DETECCIÓN DE CAÍDA)
// -----------------------------------------------------------------------------

/**
 * POST /heartbeat/:name y POST /pulse/:name
 * Recepción periódica de pulsos desde los hijos.
 */
app.post(["/heartbeat/:name", "/pulse/:name"], (req, res) => {
    const { name } = req.params;
    const server = servers[name];

    if (!server) {
        return res.status(404).json({
            error: `Servidor '${name}' no está registrado en el Servicio de Nombres`,
            mustRegister: true
        });
    }

    const wasFallen = server.status === "CAIDO";
    server.lastHeartbeat = Date.now();
    server.status = "ACTIVO";
    server.fallenAt = null;

    if (wasFallen) {
        logEvent("RECUPERACION", name, `Servidor reanudó pulsos. Estado restaurado a ACTIVO`);
    } else {
        logEvent("PULSO", name, `Pulso de vida recibido`);
    }

    res.json({
        message: "Pulso recibido exitosamente",
        status: "ACTIVO",
        lastHeartbeat: server.lastHeartbeat
    });
});

/**
 * Verificador periódico de Timeout (cada 3 segundos)
 * Si un servidor no envía pulso en más de TIMEOUT (15s), se detecta y marca como CAIDO.
 * IMPORTANTE: NO se borra de la memoria, se conserva su estado como CAIDO para observabilidad.
 */
setInterval(() => {
    const now = Date.now();

    Object.keys(servers).forEach(name => {
        const server = servers[name];
        const elapsed = now - server.lastHeartbeat;

        if (elapsed > TIMEOUT) {
            if (server.status === "ACTIVO") {
                server.status = "CAIDO";
                server.fallenAt = now;
                logEvent("TIMEOUT", name, `Detectado como CAÍDO tras ${Math.floor(elapsed / 1000)}s sin pulso (Límite: ${TIMEOUT / 1000}s)`);
            }
        }
    });
}, 3000);

// -----------------------------------------------------------------------------
// COMUNICACIÓN POR MENSAJES DISTRIBUIDOS
// -----------------------------------------------------------------------------

/**
 * POST /send-message/:name (Compatibilidad con versiones anteriores)
 * Recibe un mensaje enviado por un servidor hacia el middleware.
 */
app.post("/send-message/:name", (req, res) => {
    const { name } = req.params;
    const { message } = req.body;

    if (!servers[name]) {
        return res.status(404).json({ error: "Servidor remitente no está registrado" });
    }
    if (!message) {
        return res.status(400).json({ error: "El campo 'message' es obligatorio" });
    }

    const entry = {
        id: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
        from: name,
        to: "Middleware (Padre)",
        message,
        timestamp: Date.now(),
        status: "ENTREGADO"
    };

    servers[name].messages.push(entry);
    messageHistory.unshift(entry);
    logEvent("MENSAJE", name, `Mensaje enviado al Middleware: "${message}"`);

    res.json({ status: "ok", received: true, entry });
});

/**
 * POST /api/send-message
 * Enrutamiento completo de mensajes de nodo a nodo a través del Servicio de Nombres.
 * Resuelve la URL del destinatario y entrega el mensaje vía HTTP POST al nodo destino.
 */
app.post("/api/send-message", async (req, res) => {
    const { from, to, message } = req.body;

    if (!from || !to || !message) {
        return res.status(400).json({ error: "Los campos 'from', 'to' y 'message' son obligatorios" });
    }

    // Validar remitente
    if (from !== "Admin" && from !== "Middleware" && !servers[from]) {
        return res.status(400).json({ error: `El remitente '${from}' debe estar registrado primero en el Middleware.` });
    }

    const entry = {
        id: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
        from,
        to,
        message,
        timestamp: Date.now(),
        status: "EN_TRANSITO",
        targetUrl: null,
        error: null
    };

    // Si el destino es el propio Middleware
    if (to === "Middleware" || to === "Padre" || to === "Todos") {
        entry.status = "ENTREGADO";
        entry.targetUrl = PARENT_URL;
        messageHistory.unshift(entry);
        logEvent("MENSAJE", from, `Mensaje para '${to}': "${message}"`);
        return res.json({ success: true, entry });
    }

    // Resolver en el Servicio de Nombres
    const targetServer = servers[to];
    if (!targetServer) {
        entry.status = "FALLIDO";
        entry.error = `Destinatario '${to}' no existe en el Servicio de Nombres`;
        messageHistory.unshift(entry);
        logEvent("ERROR", from, `Intento de mensaje a '${to}' falló: Nodo no encontrado`);
        return res.status(404).json({ error: entry.error, entry });
    }

    entry.targetUrl = targetServer.url;

    // Verificar si el destinatario está CAIDO
    if (targetServer.status === "CAIDO") {
        entry.status = "FALLIDO";
        entry.error = `El destinatario '${to}' está detectado como CAÍDO (sin pulso)`;
        messageHistory.unshift(entry);
        logEvent("ADVERTENCIA", from, `Mensaje a '${to}' no entregado: El nodo de destino está CAÍDO`);
        return res.status(503).json({
            error: entry.error,
            entry,
            recipientStatus: "CAIDO"
        });
    }

    // Intentar entrega HTTP al endpoint /receive-message del nodo hijo
    try {
        const axios = require("axios");
        const destinationEndpoint = targetServer.url.replace(/\/$/, "") + "/receive-message";

        const response = await axios.post(destinationEndpoint, {
            from,
            to,
            message,
            timestamp: entry.timestamp
        }, { timeout: 4000 });

        entry.status = "ENTREGADO";
        targetServer.messages.push(entry);
        messageHistory.unshift(entry);

        logEvent("MENSAJE", from, `Mensaje entregado a '${to}' (${targetServer.url}): "${message}"`);

        return res.json({
            success: true,
            entry,
            destinationResponse: response.data
        });
    } catch (err) {
        entry.status = "FALLIDO";
        entry.error = `Error al conectar con la URL ${targetServer.url}: ${err.message}`;
        messageHistory.unshift(entry);

        logEvent("ERROR", from, `Fallo de entrega a '${to}' (${targetServer.url}): ${err.message}`);

        return res.status(502).json({
            error: entry.error,
            entry
        });
    }
});

/**
 * GET /messages y GET /api/messages
 * Historial de mensajes
 */
app.get(["/messages", "/api/messages"], (req, res) => {
    res.json(messageHistory);
});

// -----------------------------------------------------------------------------
// HOTRELOAD: CAMBIO DE URL PADRE/HIJO EN CALIENTE SIN CERRAR EL SERVIDOR
// -----------------------------------------------------------------------------

/**
 * POST /hotreload/:name o PUT /servers/:name/url
 * Permite actualizar en caliente la URL de un servidor registrado (ej. nuevo túnel ngrok)
 * SIN reiniciar el servidor padre ni el nodo hijo.
 */
app.post(["/hotreload/:name", "/servers/:name/url"], (req, res) => {
    const { name } = req.params;
    const { newUrl, url } = req.body;
    const targetUrl = newUrl || url;

    if (!servers[name]) {
        return res.status(404).json({ error: `Servidor '${name}' no encontrado en el Servicio de Nombres` });
    }
    if (!targetUrl || typeof targetUrl !== "string") {
        return res.status(400).json({ error: "Se requiere 'newUrl' o 'url' válida" });
    }

    const previousUrl = servers[name].url;
    servers[name].url = targetUrl.trim();
    servers[name].lastHeartbeat = Date.now(); // Renovar contacto

    logEvent("HOTRELOAD", name, `URL actualizada en caliente: '${previousUrl}' ➔ '${servers[name].url}' (sin reiniciar)`);

    res.json({
        success: true,
        message: `URL de '${name}' actualizada exitosamente en caliente`,
        previousUrl,
        currentUrl: servers[name].url
    });
});

/**
 * POST /api/hotreload-parent
 * Permite cambiar la URL pública del padre (ngrok) sin reiniciar el middleware
 */
app.post("/api/hotreload-parent", (req, res) => {
    const { newParentUrl } = req.body;
    if (!newParentUrl || typeof newParentUrl !== "string") {
        return res.status(400).json({ error: "Debe proporcionar 'newParentUrl'" });
    }

    const prev = PARENT_URL;
    PARENT_URL = newParentUrl.trim();
    logEvent("HOTRELOAD", "Middleware", `URL del Padre actualizada en caliente: '${prev}' ➔ '${PARENT_URL}'`);

    res.json({
        success: true,
        message: "URL del Middleware actualizada en caliente",
        previousParentUrl: prev,
        currentParentUrl: PARENT_URL
    });
});

// -----------------------------------------------------------------------------
// OBSERVABILIDAD Y ESTADO COMPLETO DEL SISTEMA
// -----------------------------------------------------------------------------

/**
 * GET /api/status
 * Estado consolidado de todos los servidores para monitoreo rápido
 */
app.get("/api/status", (req, res) => {
    const now = Date.now();

    const list = Object.values(servers).map(server => {
        const timeWithoutPulse = now - server.lastHeartbeat;
        const hasPulse = timeWithoutPulse <= TIMEOUT;

        return {
            name: server.name,
            url: server.url,
            status: server.status,
            hasPulse,
            platform: server.platform,
            hostname: server.hostname,
            lastHeartbeat: server.lastHeartbeat,
            secondsWithoutPulse: Math.floor(timeWithoutPulse / 1000),
            lastMessage: server.messages && server.messages.length > 0
                ? server.messages[server.messages.length - 1]
                : null
        };
    });

    res.json(list);
});

/**
 * GET /api/logs
 * Devuelve el historial de actividad estructurado para la consola de observabilidad
 */
app.get("/api/logs", (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.json(activityLogs.slice(0, limit));
});

/**
 * GET /api/observability
 * Endpoint integral de observabilidad: qué tiene el servidor, métricas, estado y actividad
 */
app.get("/api/observability", (req, res) => {
    const now = Date.now();
    const serverList = Object.values(servers);
    const activeCount = serverList.filter(s => s.status === "ACTIVO").length;
    const fallenCount = serverList.filter(s => s.status === "CAIDO").length;

    res.json({
        system: {
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            osPlatform: os.platform(),
            osHostname: os.hostname(),
            nodeVersion: process.version,
            parentUrl: PARENT_URL,
            port: PORT,
            timeoutSeconds: TIMEOUT / 1000
        },
        metrics: {
            totalRegistered: serverList.length,
            activeNodes: activeCount,
            fallenNodes: fallenCount,
            totalMessages: messageHistory.length,
            activityLogsCount: activityLogs.length
        },
        servers: serverList.map(s => ({
            name: s.name,
            url: s.url,
            status: s.status,
            platform: s.platform,
            hostname: s.hostname,
            lastHeartbeat: s.lastHeartbeat,
            secondsWithoutPulse: Math.floor((now - s.lastHeartbeat) / 1000),
            messagesCount: (s.messages || []).length
        })),
        recentActivity: activityLogs.slice(0, 30),
        recentMessages: messageHistory.slice(0, 20)
    });
});

// Endpoint de prueba para simular caída manual de un servidor desde la UI
app.post("/api/simulate-failure/:name", (req, res) => {
    const { name } = req.params;
    if (!servers[name]) {
        return res.status(404).json({ error: "Servidor no encontrado" });
    }
    servers[name].status = "CAIDO";
    servers[name].fallenAt = Date.now();
    logEvent("TIMEOUT", name, `Caída simulada manualmente por el usuario`);
    res.json({ message: `Servidor '${name}' marcado como CAIDO para pruebas`, status: "CAIDO" });
});

// -----------------------------------------------------------------------------
// INICIO DEL SERVIDOR
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
    console.log("=========================================================");
    console.log(`🚀 MIDDLEWARE DISTRIBUIDO INICIADO`);
    console.log(`📍 Puerto: ${PORT} | URL Base: ${PARENT_URL}`);
    console.log(`⏱️ Timeout de Inactividad: ${TIMEOUT / 1000}s`);
    console.log(`📊 Panel de Observabilidad: http://localhost:${PORT}`);
    console.log("=========================================================");
    logEvent("REGISTRO", "Middleware", `Middleware iniciado en puerto ${PORT} con Timeout de ${TIMEOUT / 1000}s`);
});
