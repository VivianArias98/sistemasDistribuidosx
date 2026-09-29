/**
 * index.js — Entry point del Worker con bucle de registro y hunting loop
 *
 * Flujo:
 *  1. Intentar registrarse con alguno de los coordinadores conocidos.
 *  2. Si el coordinador al que me conecté no es el líder, seguir buscando.
 *  3. Una vez registrado con el líder, iniciar pulsos periódicos.
 *  4. Si el coordinador cae, activar huntForLeader() automáticamente.
 */
require("dotenv").config();
const app        = require("./app");
const axios      = require("axios");
const journal    = require("./services/journal.service");
const pulse      = require("./services/pulse.service");
const msgService = require("./services/message.service");
const tasks      = require("./services/tasks.service");
const logger     = require("./utils/logger");

// ─── Configuración ────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.WORKER_PORT  || "4001", 10);
const WORKER_NAME  = process.env.WORKER_NAME            || "Worker1";
const WORKER_URL   = process.env.WORKER_URL             || `http://localhost:${PORT}`;
let COORDINATORS = (process.env.COORDINATORS || "http://localhost:3001")
    .split(",").map(u => u.trim()).filter(Boolean);

// ─── Estado global del worker ─────────────────────────────────────────────────
let status     = "iniciando";    // iniciando | registrado | buscando | apagado
let parentUrl  = null;           // URL del coordinador actual (líder)
let parentName = "Coordinador";  // Nombre del líder

// ─── Inbox local ──────────────────────────────────────────────────────────────
const inbox = [];

// ─── Hunting Loop ─────────────────────────────────────────────────────────────

/**
 * Busca al coordinador líder intentando un register/pulse simple.
 * Retorna la URL del líder cuando lo encuentra.
 */
async function huntForLeader() {
    status = "buscando";
    journal.record("busqueda", { coordinadores: COORDINATORS });
    logger.hunt(`Iniciando hunting loop — ${COORDINATORS.length} coordinadores conocidos`);

    while (status === "buscando") {
        for (const url of COORDINATORS) {
            journal.record("pregunta", { coordinador: url });
            try {
                // El trabajador intenta conectarse directamente.
                const resp = await axios.post(`${url}/register`, {
                    type: "register",
                    data: {
                        id: WORKER_NAME,
                        url: WORKER_URL,
                        localPort: PORT,
                        capabilities: [
                            "vector_distance", 
                            "http_latency", 
                            "random_number"
                        ]
                    }
                }, { timeout: 3000 });
                
                const responseData = resp.data;

                if (responseData.type === "redirect") {
                    const leaderUrl = responseData.data.leaderUrl;
                    logger.hunt(`➡️  Redirigido al líder: ${leaderUrl}`);
                    if (leaderUrl) {
                        COORDINATORS = [leaderUrl, ...COORDINATORS.filter(u => u !== leaderUrl)];
                    }
                    break; 
                }
                
                if (resp.status === 200 || resp.status === 201) {
                    logger.hunt(`✅ Líder encontrado y registrado: ${url}`);
                    return { url, name: responseData.leaderId || "Coordinador" };
                }
                
                logger.hunt(`${url} respondió código ${resp.status}, continuando...`);
            } catch (err) {
                if (err.response && err.response.data && err.response.data.type === "redirect") {
                    const leaderUrl = err.response.data.data.leaderUrl;
                    logger.hunt(`➡️  Redirigido al líder: ${leaderUrl}`);
                    if (leaderUrl) {
                        COORDINATORS = [leaderUrl, ...COORDINATORS.filter(u => u !== leaderUrl)];
                    }
                    break; // Romper para reiniciar el while loop
                }
                logger.hunt(`${url} no responde o error (${err.message}), continuando...`);
            }
        }
        // Todos fallaron o no hay líder → esperar 2 segundos y reintentar
        logger.hunt("Ningún líder respondió — esperando 2s...");
        await new Promise(r => setTimeout(r, 2000));
    }
}

/**
 * Registra el parent actual localmente (ya fuimos registrados en el hunt).
 * @param {string} coordinatorUrl
 */
function registerWithCoordinator(coordinatorUrl) {
    parentUrl = coordinatorUrl;
    status    = "registrado";
    msgService.setParent(coordinatorUrl, WORKER_NAME);
    journal.record("registro", { coordinador: coordinatorUrl });
    logger.reg(`Registrado y acoplado con coordinador: ${coordinatorUrl}`);

    // Enviar mensaje automático de bienvenida informando las capacidades
    setTimeout(() => {
        const welcomeMsg = `¡Hola Líder! Soy el worker ${WORKER_NAME} y acabo de conectarme. Estoy listo para procesar estas tareas: vector_distance, http_latency y random_number.`;
        msgService.send(welcomeMsg)
            .then(() => {
                console.log(`📤 Mensaje de bienvenida automático enviado al coordinador.`);
                // Agregar al inbox local para que también aparezca en la UI del worker
                const entry = {
                    id: "sent_" + Date.now(),
                    from: WORKER_NAME,
                    to: "Coordinador",
                    message: welcomeMsg,
                    timestamp: Date.now(),
                    receivedAt: new Date().toLocaleTimeString()
                };
                inbox.unshift(entry);
                if (inbox.length > 50) inbox.pop();
            })
            .catch(e => console.log(`❌ Error al enviar mensaje automático: ${e.message}`));
    }, 1500);
}

/**
 * Loop principal: registrar → pulsar → cazar si cae el coordinador.
 */
async function mainLoop() {
    journal.record("arranque", { name: WORKER_NAME, url: WORKER_URL });

    while (status !== "apagado") {
        try {
            // 1. Buscar líder
            const leaderData = await huntForLeader();
            if (!leaderData || status === "apagado") break;
            
            const leaderUrl = typeof leaderData === "string" ? leaderData : leaderData.url;
            parentName = typeof leaderData === "string" ? "Coordinador" : leaderData.name;

            // 2. Registrarse
            await registerWithCoordinator(leaderUrl);

            // 3. Iniciar pulsos; si pierde el coordinador → volver a cazar
            await new Promise(resolve => {
                pulse.start(leaderUrl, WORKER_NAME, (newLeaderUrl, peers) => {
                    if (status === "registrado") {
                        status = "buscando";
                        if (peers && Array.isArray(peers)) {
                            // Enriquecer la lista de coordinadores conocidos para acelerar el Camino Lento
                            peers.forEach(p => {
                                if (p.url && !COORDINATORS.includes(p.url)) COORDINATORS.push(p.url);
                            });
                        }
                        // Si nos dan la URL del nuevo líder (Camino Rápido), intentamos ir allá directo en el próximo ciclo
                        if (newLeaderUrl && !COORDINATORS.includes(newLeaderUrl)) {
                            COORDINATORS.unshift(newLeaderUrl);
                        }
                        resolve();
                    }
                });
            });

            pulse.stop();
        } catch (err) {
            logger.warn(`Error en mainLoop: ${err.message} — reintentando en 3s`);
            status = "buscando";
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ─── Rutas del Worker ──────────────────────────────────────────────────────────

app.get("/status", (_req, res) => {
    res.json({
        name:    WORKER_NAME,
        url:     WORKER_URL,
        status,
        parent:  parentUrl,
        journal: journal.getAll(30),
        inbox:   inbox.slice(0, 20),
        coordinators: COORDINATORS,
    });
});

app.get("/parent", (_req, res) => res.json({ parentUrl }));
app.post("/parent", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Se requiere 'url'" });
    pulse.stop();
    status = "buscando";
    res.json({ ok: true, message: "Migrando al nuevo coordinador...", newParent: url });
    try {
        await registerWithCoordinator(url);
        pulse.start(url, WORKER_NAME, () => { status = "buscando"; mainLoop(); });
    } catch (err) {
        mainLoop();
    }
});

app.post("/send-message", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Se requiere 'message'" });
    if (status !== "registrado") return res.status(503).json({ error: "Worker no conectado a un coordinador" });
    try {
        const result = await msgService.send(message);
        res.json(result);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

app.post("/receive-message", (req, res) => {
    const { from, message, timestamp, fromUrl } = req.body;
    if (!message) return res.status(400).json({ error: "Se requiere 'message'" });
    const entry = {
        id: "recv_" + Date.now(),
        from: from || "desconocido",
        fromUrl: fromUrl || null,
        to: WORKER_NAME,
        message: message,
        timestamp: timestamp || Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    };
    inbox.unshift(entry);
    if (inbox.length > 50) inbox.pop();
    logger.msg(`Mensaje de '${from}': "${message}"`);
    res.json({ ok: true, received: true });
});

app.get("/messages", (req, res) => {
    res.json(inbox);
});

app.get("/", (req, res) => {
    const path = require("path");
    res.sendFile(path.join(__dirname, "../../miniUI.html"));
});

app.get("/status", (req, res) => {
    res.json({
        name: WORKER_NAME,
        port: PORT,
        myUrl: WORKER_URL,
        middlewareUrl: parentUrl || "",
        platform: require("os").platform(),
        hostname: require("os").hostname(),
        isPulseActive: status === "registrado",
        messagesCount: inbox.length,
        uptime: Math.floor(process.uptime()),
        isConnected: status === "registrado"
    });
});

app.post("/api/connect", async (req, res) => {
    const { middlewareUrl } = req.body;
    if (!middlewareUrl) return res.status(400).json({ error: "Falta middlewareUrl" });
    try {
        await registerWithCoordinator(middlewareUrl);
        pulse.start(middlewareUrl, WORKER_NAME, () => { status = "buscando"; mainLoop(); });
        res.json({ success: true, middlewareUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/contacts", async (req, res) => {
    if (!parentUrl) {
        return res.json({ leader: "Desconectado", workers: [] });
    }
    try {
        const response = await axios.get(`${parentUrl}/api/status`, { timeout: 3000 });
        if (Array.isArray(response.data)) {
            res.json({ leader: parentName !== "Coordinador" ? parentName : parentUrl, workers: response.data });
        } else {
            res.json({ leader: parentName !== "Coordinador" ? parentName : parentUrl, workers: [] });
        }
    } catch (error) {
        res.json({ leader: parentName !== "Coordinador" ? parentName : parentUrl, workers: [] });
    }
});

app.post("/send-to", async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: "Faltan datos" });
    
    if (status === "registrado" && parentUrl) {
        try {
            // Enviar al coordinador para que lo enrute al destinatario correcto (worker o coordinador)
            const resp = await axios.post(`${parentUrl}/api/send-message`, {
                from: WORKER_NAME,
                to: to,
                message: message
            }, { timeout: 5000, headers: { "ngrok-skip-browser-warning": "true" } });

            // Si el coordinador responde error (destinatario no encontrado), propagarlo
            if (resp.data && resp.data.error) {
                return res.status(404).json({ error: resp.data.error });
            }

            // Guardar copia local del mensaje enviado para mostrar en miniUI
            inbox.unshift({
                id: "sent_" + Date.now(),
                from: WORKER_NAME,
                to: to,
                message: message,
                timestamp: Date.now(),
                receivedAt: new Date().toLocaleTimeString()
            });
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error enviando mensaje a '${to}': ${error.message}`);
            res.status(500).json({ error: `No se pudo entregar el mensaje: ${error.message}` });
        }
    } else {
        res.status(503).json({ error: "Worker no conectado a coordinador" });
    }
});

function startInteractiveChat() {
    const readline = require("readline");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `💬 Escribe al líder (Enter para enviar) > `
    });
    console.log("\\n💬 ¡Modo chat activado! Escribe un mensaje y presiona Enter para enviarlo al coordinador.");
    rl.prompt();
    rl.on("line", async (line) => {
        const msg = line.trim();
        if (msg) {
            try {
                if (status === "registrado" && parentUrl) {
                    await msgService.send(msg);
                    console.log(`📤 Enviado al coordinador: "${msg}"`);
                    inbox.unshift({
                        id: "sent_" + Date.now(),
                        from: WORKER_NAME,
                        to: "Coordinador",
                        message: msg,
                        timestamp: Date.now(),
                        receivedAt: new Date().toLocaleTimeString()
                    });
                } else {
                    console.log(`❌ No estás conectado a ningún coordinador.`);
                }
            } catch (error) {
                console.log(`❌ Error al enviar mensaje: ${error.message}`);
            }
        }
        rl.prompt();
    });
}

app.get("/task/capabilities", (req, res) => {
    res.json({
        capabilities: [
            "math_compute", 
            "http_fetch", 
            "search_text", 
            "stats_compute", 
            "vector_distance", 
            "http_latency", 
            "reverse_string"
        ]
    });
});

app.post("/task/assign", async (req, res) => {
    const reqBody = req.body || {};
    
    // Log para monitorear el JSON de la comunicación general (Tarea entrante)
    console.log("📥 [JSON RECIBIDO - TAREA]:", JSON.stringify(reqBody, null, 2));

    if (reqBody.type !== "task-assign" || !reqBody.data) {
        return res.status(400).json({ error: "Debe ser de tipo task-assign" });
    }

    const { taskId, type: taskType, payload } = reqBody.data;
    if (!taskId || !taskType) return res.status(400).json({ error: "Falta taskId o type" });
    
    // Responder inmediatamente para liberar al coordinador
    res.json({ ok: true, message: "Tarea encolada" });

    logger.info(`Iniciando tarea ${taskId} de tipo ${taskType}`);
    journal.record("tarea_iniciada", { taskId, taskType });

    let resultMsg;
    
    // Simular un LAG (retardo) configurable como solicitó el profesor
    const lagMs = parseInt(process.env.TASK_LAG_MS || "2000", 10);
    logger.info(`Simulando latencia de ${lagMs}ms para ejecutar la tarea...`);
    await new Promise(resolve => setTimeout(resolve, lagMs));

    try {
        const result = await tasks.executeTask(taskType, payload || {});
        resultMsg = {
            type: "task-result",
            data: {
                taskId,
                status: "ok",
                result
            }
        };
        logger.info(`Tarea ${taskId} completada exitosamente`);
        journal.record("tarea_completada", { taskId });
    } catch (err) {
        resultMsg = {
            type: "task-result",
            data: {
                taskId,
                status: "error",
                error: err.message
            }
        };
        logger.error(`Error en tarea ${taskId}: ${err.message}`);
        journal.record("tarea_error", { taskId, error: err.message });
    }

    // Enviar el resultado al coordinador actual
    if (parentUrl) {
        try {
            // Log para monitorear el JSON saliente (Resultado)
            console.log("📤 [JSON ENVIADO - RESULTADO]:", JSON.stringify(resultMsg, null, 2));
            // Pasamos el workerId por query parameter para NO alterar el JSON estricto del examen
            await axios.post(`${parentUrl}/task/receive?workerId=${WORKER_NAME}`, resultMsg, { timeout: 3000 });
        } catch (e) {
            logger.error(`No se pudo enviar el resultado de ${taskId} al coordinador: ${e.message}`);
        }
    }
});

app.post("/stop-pulse",  (_req, res) => { pulse.stop();  res.json({ ok: true, pulsing: false }); });
app.post("/start-pulse", (_req, res) => {
    if (parentUrl && status === "registrado") {
        pulse.start(parentUrl, WORKER_NAME, () => { status = "buscando"; mainLoop(); });
        res.json({ ok: true, pulsing: true });
    } else {
        res.status(409).json({ error: "No hay coordinador activo" });
    }
});

app.post("/shutdown", (_req, res) => {
    status = "apagado";
    pulse.stop();
    res.json({ ok: true, message: "Worker apagado" });
    setTimeout(() => process.exit(0), 500);
});

// ─── Inicio ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log("═".repeat(55));
    console.log(`🤖 WORKER INICIADO`);
    console.log(`🆔 Nombre  : ${WORKER_NAME}`);
    console.log(`📍 Puerto  : ${PORT}`);
    console.log(`🌐 URL     : ${WORKER_URL}`);
    console.log(`🔗 Coordinadores conocidos: ${COORDINATORS.join(", ")}`);
    console.log(`📋 Panel   : http://localhost:${PORT}`);
    console.log("═".repeat(55));
    
    // Iniciar chat interactivo (como en miniServer.js)
    setTimeout(() => startInteractiveChat(), 1000);

    mainLoop().catch(err => {
        logger.error(`mainLoop fatal: ${err.message}`);
        process.exit(1);
    });
});
