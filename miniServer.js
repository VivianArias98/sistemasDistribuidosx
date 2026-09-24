const express = require("express");
const axios = require("axios");
const os = require("os");
const readline = require("readline");

const askQuestion = (query) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

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
let allMessagesHistory = []; // Almacena tanto enviados como recibidos
let knownPeers = []; // Para failover si el líder cae


// -----------------------------------------------------------------------------
// RUTAS BÁSICAS
// -----------------------------------------------------------------------------

const path = require("path");

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "miniUI.html"));
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
        messagesCount: allMessagesHistory.length,
        uptime: Math.floor(process.uptime()),
        isConnected: pulseInterval !== null
    });
});

app.post("/api/connect", async (req, res) => {
    const { middlewareUrl } = req.body;
    if (!middlewareUrl) return res.status(400).json({ error: "Falta middlewareUrl" });
    
    MIDDLEWARE_URL = middlewareUrl.trim().replace(/\/$/, "");
    try {
        await register();
        startHeartbeatLoop();
        res.json({ success: true, middlewareUrl: MIDDLEWARE_URL });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/contacts", async (req, res) => {
    if (!MIDDLEWARE_URL) return res.json({ leader: "Admin", workers: [] });
    try {
        let leaderName = "Admin";
        try {
            const leaderRes = await axios.get(`${MIDDLEWARE_URL}/api/leader-info`, { timeout: 2000 });
            if (leaderRes.data && leaderRes.data.name) leaderName = leaderRes.data.name;
        } catch (err) {
            // Ignorar si falla el nuevo endpoint
        }

        const response = await axios.get(`${MIDDLEWARE_URL}/api/status`, { timeout: 3000 });
        if (Array.isArray(response.data)) {
            res.json({ leader: leaderName, workers: response.data });
        } else {
            res.json({ leader: leaderName, workers: [] });
        }
    } catch (e) {
        res.status(500).json({ error: "No se pudo obtener contactos" });
    }
});

// -----------------------------------------------------------------------------
// COMUNICACIÓN POR MENSAJES (RECEPCIÓN Y ENVÍO)
// -----------------------------------------------------------------------------

/**
 * POST /receive-message
 * Endpoint donde este nodo recibe mensajes despachados por el Middleware u otros nodos.
 */
app.post("/receive-message", (req, res) => {
    const { from, message, timestamp, fromUrl } = req.body;

    const entry = {
        id: "recv_" + Date.now(),
        from: from || "Desconocido",
        fromUrl: fromUrl || null,
        to: NAME,
        message: message || "",
        timestamp: timestamp || Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    };

    allMessagesHistory.unshift(entry);

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
 * Devuelve la lista de mensajes enviados y recibidos por este nodo
 */
app.get("/messages", (req, res) => {
    res.json(allMessagesHistory);
});

/**
 * DELETE /messages
 * Limpia el historial de mensajes
 */
app.delete("/messages", (req, res) => {
    allMessagesHistory = [];
    res.json({ success: true });
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

        // Guardar en el historial local
        allMessagesHistory.unshift({
            id: "sent_" + Date.now(),
            from: NAME,
            to: to,
            message: message,
            timestamp: Date.now(),
            receivedAt: new Date().toLocaleTimeString()
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

async function register(retryCount = 0) {
    if (retryCount > 3) {
        throw new Error("Demasiados intentos de redirección o reintento de registro.");
    }
    try {
        const response = await axios.post(`${MIDDLEWARE_URL}/register`, {
            name: NAME,
            url: MY_URL,
            localPort: PORT,
            platform: os.platform(),
            hostname: os.hostname()
        });

        console.log(`✅ [REGISTRO] Registrado exitosamente en el Líder como '${NAME}' (${MY_URL})`);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 409) {
            const data = error.response.data;
                if (data.leader) {
                console.log(`🔀 [REDIRECCIÓN] Este nodo no es el líder. El líder es: ${data.leader}. Reconectando...`);
                MIDDLEWARE_URL = data.leader.replace(/\/$/, "");
                allMessagesHistory = []; // Borrar historial al cambiar de líder
                if (data.peers && Array.isArray(data.peers)) knownPeers = data.peers;
                return await register(retryCount + 1); // Intentar con el nuevo líder
            } else if (data.code === "IP_CONFLICT" || data.error?.includes("duplicado")) {
                console.error("=========================================================");
                console.error(`❌ [ERROR 409 - CONFLICTO DE NOMBRES]`);
                console.error(`   ${data.error}`);
                console.error("=========================================================");
                throw error;
            }
        }

        if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED') || error.response?.status >= 500) {
            console.error(`❌ [ERROR] El servidor en ${MIDDLEWARE_URL} no está encendido o no responde.`);
            const newUrl = await askQuestion("🔗 Ingresa la nueva URL a la que te vas a conectar (Ej: https://...): ");
            if (newUrl && newUrl.trim()) {
                MIDDLEWARE_URL = newUrl.trim().replace(/\/$/, "");
                console.log(`🔄 Intentando conectar a la nueva URL: ${MIDDLEWARE_URL} ...`);
                return await register(retryCount); // Reintentar con la nueva URL sin aumentar el contador (porque es un cambio manual)
            }
        }

        console.error(`❌ [ERROR AL REGISTRAR] en ${MIDDLEWARE_URL}:`, error.response?.data?.error || error.message);
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
            const resp = await axios.post(`${MIDDLEWARE_URL}/pulse/${NAME}`);
            // Actualizar lista de peers conocidos para failover
            if (resp.data && resp.data.peers) {
                knownPeers = resp.data.peers;
            }
        } catch (error) {
            if (error.response?.status === 409 && error.response?.data?.leader) {
                console.log(`🔀 [REDIRECCIÓN] El líder cambió a: ${error.response.data.leader}. Reconectando...`);
                MIDDLEWARE_URL = error.response.data.leader.replace(/\/$/, "");
                allMessagesHistory = []; // Borrar historial al cambiar de líder
                try { await register(); } catch (e) { }
            } else if (error.response?.data?.mustRegister) {
                console.log("ℹ️ Re-registrando en el Servicio de Nombres (me eliminaron)...");
                try { await register(); } catch (e) { }
            } else {
                console.log(`⚠️ Error al enviar pulso al middleware: ${error.message}`);
                // Si hay un error de conexión (el líder cayó), intentar con un follower
                if (!error.response && knownPeers.length > 0) {
                    console.log("🔄 El líder parece estar caído. Buscando un nuevo líder entre los peers conocidos...");
                    // Elegir un peer aleatorio distinto al actual
                    const availablePeers = knownPeers.filter(p => p !== MIDDLEWARE_URL);
                    if (availablePeers.length > 0) {
                        const nextPeer = availablePeers[Math.floor(Math.random() * availablePeers.length)];
                        MIDDLEWARE_URL = nextPeer.replace(/\/$/, "");
                        console.log(`🔌 Conectando al peer de respaldo: ${MIDDLEWARE_URL} ...`);
                        allMessagesHistory = []; // Borrar historial al cambiar de líder
                        try { await register(); } catch (e) { }
                    }
                }
            }
        }
    }, 5000);
}

// -----------------------------------------------------------------------------
// CHAT INTERACTIVO (Consola)
// -----------------------------------------------------------------------------
function startInteractiveChat() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `💬 Escribe al líder (Enter para enviar) > `
    });

    console.log("\n💬 ¡Modo chat activado! Escribe un mensaje y presiona Enter para enviarlo al líder actual.");
    rl.prompt();

    rl.on("line", async (line) => {
        const msg = line.trim();
        if (msg) {
            try {
                // Se envía al middleware actual (líder)
                await axios.post(`${MIDDLEWARE_URL}/send-message/${NAME}`, { message: msg });
                console.log(`📤 Enviado al líder: "${msg}"`);
            } catch (error) {
                console.log(`❌ Error al enviar mensaje: ${error.message}`);
            }
        }
        rl.prompt();
    });
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
        // En vez de registrar obligatoriamente, solo iniciaremos el chat interactivo 
        // y esperaremos a que el usuario se conecte por la interfaz web
        console.log(`💡 Ve a http://localhost:${PORT} en tu navegador para usar la interfaz gráfica.`);
        startInteractiveChat();
    } catch (error) {
        console.log("💡 Error al iniciar chat.");
    }
});