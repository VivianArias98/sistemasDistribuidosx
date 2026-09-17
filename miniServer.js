const express = require("express");
const axios = require("axios");
const os = require("os");

const app = express();
app.use(express.json());

// Soporte CORS para peticiones desde cualquier origen o ngrok
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// -----------------------------------------------------------------------------
// CONFIGURACIÓN DINÁMICA (MULTIPLATAFORMA / MULTIMÁQUINA / NGROK)
// -----------------------------------------------------------------------------

// Parámetros flexibles por línea de comandos o variables de entorno:
// Uso: node miniServer.js [PORT] [NAME] [MY_URL] [MIDDLEWARE_URL]
// Ejemplo local: node miniServer.js 4001 Nodo1
// Ejemplo ngrok: node miniServer.js 4001 Nodo1 https://mi-nodo.ngrok-free.dev https://mi-padre.ngrok-free.dev
const PORT = process.argv[2] || process.env.PORT || 4000;
let NAME = process.argv[3] || process.env.NAME || `Nodo_${PORT}`;
let MY_URL = process.argv[4] || process.env.MY_URL || `http://localhost:${PORT}`;
let MIDDLEWARE_URL = process.argv[5] || process.env.MIDDLEWARE_URL || "http://localhost:3000";

let pulseInterval = null;
let isPulseActive = true;
let receivedMessages = [];

// -----------------------------------------------------------------------------
// RUTAS BÁSICAS
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>${NAME} - Nodo Distribuido</title></head>
        <body style="font-family: sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc;">
            <h1>🟢 Nodo Activo: ${NAME}</h1>
            <p><strong>Puerto local:</strong> ${PORT}</p>
            <p><strong>URL registrada (ngrok / IP):</strong> ${MY_URL}</p>
            <p><strong>Middleware (Padre):</strong> ${MIDDLEWARE_URL}</p>
            <p><strong>Plataforma:</strong> ${os.platform()} (${os.hostname()})</p>
            <p><strong>Pulsos activos:</strong> ${isPulseActive ? "SI (cada 5s)" : "NO (Pausado)"}</p>
            <p><strong>Mensajes recibidos:</strong> ${receivedMessages.length}</p>
        </body>
        </html>
    `);
});

app.get("/status", (req, res) => {
    res.json({
        name: NAME,
        port: PORT,
        myUrl: MY_URL,
        middlewareUrl: MIDDLEWARE_URL,
        platform: os.platform(),
        hostname: os.hostname(),
        isPulseActive,
        messagesCount: receivedMessages.length,
        uptime: Math.floor(process.uptime())
    });
});

// -----------------------------------------------------------------------------
// COMUNICACIÓN POR MENSAJES (RECEPCIÓN Y ENVÍO)
// -----------------------------------------------------------------------------

/**
 * POST /receive-message
 * Endpoint donde este nodo recibe mensajes despachados por el Middleware u otros nodos.
 */
app.post("/receive-message", (req, res) => {
    const { from, message, timestamp } = req.body;

    const entry = {
        id: "recv_" + Date.now(),
        from: from || "Desconocido",
        message: message || "",
        timestamp: timestamp || Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    };

    receivedMessages.unshift(entry);

    console.log("---------------------------------------------------------");
    console.log(`📥 [MENSAJE RECIBIDO]`);
    console.log(`   👤 De:      ${entry.from}`);
    console.log(`   💬 Mensaje: "${entry.message}"`);
    console.log(`   ⏰ Hora:    ${entry.receivedAt}`);
    console.log("---------------------------------------------------------");

    res.json({
        status: "recibido",
        node: NAME,
        receivedAt: entry.receivedAt
    });
});

/**
 * GET /messages
 * Devuelve la lista de mensajes recibidos por este nodo
 */
app.get("/messages", (req, res) => {
    res.json(receivedMessages);
});

/**
 * POST /send-message (Compatibilidad previa)
 * Envía un mensaje directamente hacia el Middleware
 */
app.post("/send-message", async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: "El campo 'message' es obligatorio" });
    }

    try {
        const response = await axios.post(`${MIDDLEWARE_URL}/send-message/${NAME}`, { message });
        console.log(`📤 Mensaje enviado al middleware: "${message}"`);
        res.json({ status: "success", serverResponse: response.data });
    } catch (error) {
        console.error("❌ Error al enviar mensaje al middleware:", error.message);
        res.status(500).json({ error: "No se pudo entregar el mensaje al middleware" });
    }
});

/**
 * POST /send-to
 * Envía un mensaje hacia otro nodo distribuido a través del Middleware y su Servicio de Nombres
 */
app.post("/send-to", async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: "Se requieren 'to' (destinatario) y 'message'" });
    }

    try {
        const response = await axios.post(`${MIDDLEWARE_URL}/api/send-message`, {
            from: NAME,
            to,
            message
        });

        console.log(`📤 Mensaje enrutado hacia '${to}': "${message}" [OK]`);
        res.json({ success: true, result: response.data });
    } catch (error) {
        const errDetail = error.response?.data?.error || error.message;
        console.error(`❌ Error al enviar mensaje a '${to}':`, errDetail);
        res.status(error.response?.status || 500).json({ error: errDetail });
    }
});

// -----------------------------------------------------------------------------
// HOTRELOAD: CAMBIO DE URL PADRE/HIJO EN CALIENTE SIN CERRAR EL PROCESO
// -----------------------------------------------------------------------------

/**
 * POST /hotreload o POST /config
 * Cambia la URL del Middleware o la URL propia (ej. nuevo túnel ngrok) en caliente.
 */
app.post(["/hotreload", "/config"], async (req, res) => {
    const { myUrl, middlewareUrl, name } = req.body;
    const changes = {};

    if (name && typeof name === "string" && name.trim() !== NAME) {
        changes.oldName = NAME;
        NAME = name.trim();
        changes.newName = NAME;
    }

    if (middlewareUrl && typeof middlewareUrl === "string" && middlewareUrl.trim() !== MIDDLEWARE_URL) {
        changes.oldMiddlewareUrl = MIDDLEWARE_URL;
        MIDDLEWARE_URL = middlewareUrl.trim();
        changes.newMiddlewareUrl = MIDDLEWARE_URL;
    }

    if (myUrl && typeof myUrl === "string" && myUrl.trim() !== MY_URL) {
        changes.oldMyUrl = MY_URL;
        MY_URL = myUrl.trim();
        changes.newMyUrl = MY_URL;
    }

    console.log("=========================================================");
    console.log(`🔄 [HOTRELOAD] Reconfiguración en caliente recibida:`);
    console.log(`   Nombre:         ${NAME}`);
    console.log(`   URL Propia:     ${MY_URL}`);
    console.log(`   URL Middleware: ${MIDDLEWARE_URL}`);
    console.log("=========================================================");

    // Si cambió la URL propia o el middleware, notificar al padre sin reiniciar el servidor
    try {
        await axios.post(`${MIDDLEWARE_URL}/hotreload/${NAME}`, { newUrl: MY_URL });
        console.log(`✅ Naming Service actualizado con la nueva URL: ${MY_URL}`);
    } catch (e) {
        // Si no estaba registrado o cambió de middleware, registrarlo
        try {
            await register();
        } catch (regErr) {
            console.warn("Aviso durante hotreload:", regErr.message);
        }
    }

    res.json({
        success: true,
        message: "Configuración actualizada en caliente sin reiniciar el servidor",
        changes,
        currentConfig: {
            name: NAME,
            myUrl: MY_URL,
            middlewareUrl: MIDDLEWARE_URL
        }
    });
});

// -----------------------------------------------------------------------------
// SIMULACIÓN DE FALLAS Y TIMEOUT
// -----------------------------------------------------------------------------

/**
 * POST /stop-pulse
 * Detiene los pulsos de vida para permitir probar el TIMEOUT en el padre
 */
app.post(["/stop-pulse", "/shutdown"], (req, res) => {
    if (pulseInterval) {
        clearInterval(pulseInterval);
        pulseInterval = null;
    }
    isPulseActive = false;
    console.log("⚠️ [SIMULACIÓN] Pulsos de vida DETENIDOS. El padre lo detectará como CAÍDO tras 15 segundos.");
    res.json({ message: `${NAME} dejó de enviar pulsos (Simulación de caída iniciada)`, isPulseActive: false });
});

/**
 * POST /start-pulse
 * Reanuda los pulsos de vida para probar la recuperación automática
 */
app.post("/start-pulse", (req, res) => {
    startHeartbeatLoop();
    console.log("🟢 [SIMULACIÓN] Pulsos de vida REANUDADOS.");
    res.json({ message: `${NAME} reanudó el envío de pulsos`, isPulseActive: true });
});

// -----------------------------------------------------------------------------
// REGISTRO EN EL SERVICIO DE NOMBRES Y BUCLE DE PULSOS
// -----------------------------------------------------------------------------

async function register() {
    try {
        const response = await axios.post(`${MIDDLEWARE_URL}/register`, {
            name: NAME,
            url: MY_URL,
            platform: os.platform(),
            hostname: os.hostname()
        });

        console.log(`✅ [REGISTRO] Registrado exitosamente en Servicio de Nombres como '${NAME}' (${MY_URL})`);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 409) {
            console.error("=========================================================");
            console.error(`❌ [ERROR 409 - CONFLICTO DE NOMBRES]`);
            console.error(`   ${error.response.data.error}`);
            console.error(`   Robutez en el Naming Service: NO se permiten nombres duplicados.`);
            console.error("=========================================================");
        } else {
            console.error(`❌ [ERROR AL REGISTRAR] en ${MIDDLEWARE_URL}:`, error.response?.data?.error || error.message);
        }
        throw error;
    }
}

function startHeartbeatLoop() {
    if (pulseInterval) {
        clearInterval(pulseInterval);
    }
    isPulseActive = true;

    pulseInterval = setInterval(async () => {
        if (!isPulseActive) return;
        try {
            await axios.post(`${MIDDLEWARE_URL}/pulse/${NAME}`);
            // console.log(`💓 Pulso enviado a ${MIDDLEWARE_URL}`);
        } catch (error) {
            if (error.response?.data?.mustRegister) {
                console.log("ℹ️ Re-registrando en el Servicio de Nombres...");
                try { await register(); } catch (e) {}
            } else {
                console.log(`⚠️ Error al enviar pulso al middleware: ${error.message}`);
            }
        }
    }, 5000);
}

// -----------------------------------------------------------------------------
// ARRANQUE DEL SERVIDOR
// -----------------------------------------------------------------------------

app.listen(PORT, async () => {
    console.log("=========================================================");
    console.log(`🤖 NODO CLIENTE (miniServer) INICIADO`);
    console.log(`   🏷️  Nombre:          ${NAME}`);
    console.log(`   🔌 Puerto Local:    ${PORT}`);
    console.log(`   🌐 URL Registrada:  ${MY_URL}`);
    console.log(`   📡 Middleware:      ${MIDDLEWARE_URL}`);
    console.log(`   💻 Plataforma:      ${os.platform()} (${os.hostname()})`);
    console.log("=========================================================");

    try {
        await register();
        startHeartbeatLoop();
    } catch (error) {
        console.log("💡 Para reintentar el registro o cambiar el nombre, use el endpoint /hotreload o reinicie el nodo.");
    }
});