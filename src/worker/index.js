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
const app = require("./app");
const axios = require("axios");
const journal = require("./services/journal.service");
const pulse = require("./services/pulse.service");
const msgService = require("./services/message.service");
const tasks = require("./services/tasks.service");
const logger = require("./utils/logger");

// ─── Configuración ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.WORKER_PORT || "4001", 10);
const WORKER_NAME = process.env.WORKER_NAME || "Worker1";
const WORKER_URL = process.env.WORKER_URL || `http://localhost:${PORT}`;
let COORDINATORS = (process.env.COORDINATORS || "http://localhost:3001")
    .split(",").map(u => u.trim()).filter(Boolean);

// ─── Estado global del worker ─────────────────────────────────────────────────
let status = "iniciando";    // iniciando | registrado | buscando | apagado
let parentUrl = null;           // URL del coordinador actual (líder)
let parentName = "Coordinador";  // Nombre del líder

// ─── Inbox local ──────────────────────────────────────────────────────────────
const inbox = [];

// ─── Hunting Loop ─────────────────────────────────────────────────────────────

// Capacidades de ESTE worker (sección 9 del examen):
//   - 2 capacidades asignadas: vector_distance (9.5) + http_latency (9.6)
//   - 1 capacidad propia nueva: generate_password
// El coordinador las conoce desde el JSON del register; no se anuncian por chat.
const DEFAULT_CAPABILITIES = [
    "vector_distance",   // 9.5 - Distancia entre vectores
    "http_latency",      // 9.6 - Latencia HTTP
    "count_vowels"       // Tarea asignada
];

/**
 * Obtiene las capacidades del worker consultando su propio endpoint.
 * Si el endpoint falla, usa las capacidades por defecto.
 */
async function getWorkerCapabilities() {
    try {
        const resp = await axios.get(`http://localhost:${PORT}/task/capabilities`, { timeout: 2000 });
        if (resp.data && Array.isArray(resp.data.capabilities)) {
            const caps = resp.data.capabilities;
            logger.info(`📋 Capacidades obtenidas dinámicamente: [${caps.join(", ")}]`);
            return caps;
        }
    } catch (e) {
        logger.warn(`No se pudieron obtener capacidades dinámicas, usando por defecto: ${e.message}`);
    }
    return DEFAULT_CAPABILITIES;
}

/**
 * Busca al coordinador líder intentando un register/pulse simple.
 * Retorna la URL del líder cuando lo encuentra.
 */
async function huntForLeader() {
    status = "buscando";
    journal.record("busqueda", { coordinadores: COORDINATORS });
    logger.hunt(`Iniciando hunting loop — ${COORDINATORS.length} coordinadores conocidos`);

    // Obtener capacidades dinámicamente antes de registrarse
    const capabilities = await getWorkerCapabilities();

    while (status === "buscando") {
        for (const url of COORDINATORS) {
            journal.record("pregunta", { coordinador: url });
            try {
                // El trabajador intenta conectarse al coordinador con sus capacidades reales
                // Se envían campos planos para compatibilidad con SistemasDistribuidos-main
                const resp = await axios.post(`${url}/register`, {
                    type: "register",
                    name: WORKER_NAME,
                    url: WORKER_URL,
                    role: "worker",
                    capabilities,
                    data: {
                        id: WORKER_NAME,
                        url: WORKER_URL,
                        localPort: PORT,
                        capabilities
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
                    return { url, name: responseData.leaderId || "Coordinador", capabilities };
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
 * El coordinador ya conoce las capacidades desde el payload del register.
 * @param {string} coordinatorUrl
 * @param {string[]} [capabilities] - Lista de capacidades del worker
 */
function registerWithCoordinator(coordinatorUrl, capabilities = DEFAULT_CAPABILITIES) {
    parentUrl = coordinatorUrl;
    status = "registrado";
    msgService.setParent(coordinatorUrl, WORKER_NAME);
    journal.record("registro", { coordinador: coordinatorUrl, capabilities });
    logger.reg(`Registrado y acoplado con coordinador: ${coordinatorUrl}`);
    logger.reg(`Capacidades declaradas: [${capabilities.join(", ")}]`);
    // NO se envía mensaje automático: el coordinador ya conoce las capacidades
    // desde el JSON { type: "register", data: { id, url, capabilities } }
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

            // 2. Registrarse (pasando las capacidades obtenidas dinámicamente)
            const leaderCaps = typeof leaderData === "object" ? (leaderData.capabilities || DEFAULT_CAPABILITIES) : DEFAULT_CAPABILITIES;
            await registerWithCoordinator(leaderUrl, leaderCaps);

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
        name: WORKER_NAME,
        url: WORKER_URL,
        status,
        parent: parentUrl,
        journal: journal.getAll(30),
        inbox: inbox.slice(0, 20),
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

// Alias /inbox para compatibilidad con parcial-ssd-main (el coordinador entrega mensajes aquí)
app.post("/inbox", (req, res) => {
    const { from, name, message, timestamp } = req.body;
    const sender = from || name || "desconocido";
    const text = message || "";
    if (!text) return res.status(400).json({ error: "Se requiere 'message'" });
    const entry = {
        id: "recv_" + Date.now(),
        from: sender,
        to: WORKER_NAME,
        message: text,
        timestamp: timestamp || Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    };
    inbox.unshift(entry);
    if (inbox.length > 50) inbox.pop();
    logger.msg(`Mensaje (inbox) de '${sender}': "${text}"`);
    res.json({ ok: true, received: true });
});
// Callback global para que pulse.service.js inyecte los mensajes del polling
global._onMessageReceived = (msg) => {
    let senderName = msg.sender || "Coordinador";
    // Si viene del dashboard de Camilo, forzar a "Coordinador" para que la UI lo asigne al chat principal
    if (senderName.toLowerCase().includes("admin") || senderName.toLowerCase().includes("dashboard") || senderName === parentName || senderName === parentUrl) {
        senderName = "Coordinador";
    }
    const entry = {
        id: "recv_" + Date.now() + Math.random(),
        from: senderName,
        fromUrl: null,
        to: WORKER_NAME,
        message: msg.message,
        timestamp: msg.timestamp || Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    };
    inbox.unshift(entry);
    if (inbox.length > 50) inbox.pop();
};

app.get("/messages", (req, res) => {
    res.json(inbox);
});

// POST /coordinators — El coordinador parcial-ssd-main "invita" al worker a conectarse
app.post("/coordinators", async (req, res) => {
    const url = (req.body?.url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) {
        return res.status(400).json({ ok: false, error: "URL inválida" });
    }
    if (!COORDINATORS.includes(url)) {
        COORDINATORS.push(url);
    }
    logger.info(`Coordinador agregado por invitación: ${url}`);
    // Si no estamos registrados con nadie, intentar conectarse
    if (status !== "registrado") {
        parentUrl = url;
        // Reiniciar el mainLoop se encargará de registrarse
    }
    res.json({ ok: true, registered: status === "registrado", coordinator: parentUrl });
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
            return res.json({ leader: parentName !== "Coordinador" ? parentName : parentUrl, workers: response.data });
        }
    } catch (e) {
        // Compatibilidad con SistemasDistribuidos-main
        if (e.response && e.response.status === 404) {
            let allWorkers = [];
            let leaderName = parentName !== "Coordinador" ? parentName : parentUrl;
            try {
                const srvRes = await axios.get(`${parentUrl}/servers`, { timeout: 3000 });
                const serversArr = Array.isArray(srvRes.data) ? srvRes.data : (srvRes.data.servers || []);
                allWorkers = allWorkers.concat(serversArr.map(s => ({
                    name: s.name,
                    url: s.url,
                    status: s.status === "active" ? "ACTIVO" : "CAIDO",
                    role: "worker"
                })));

                const peersRes = await axios.get(`${parentUrl}/election/state`, { timeout: 3000 });
                if (peersRes.data) {
                    if (peersRes.data.leader) leaderName = peersRes.data.leader;
                    const peersArr = Array.isArray(peersRes.data.peerDetails) ? peersRes.data.peerDetails : (Array.isArray(peersRes.data.peers) ? peersRes.data.peers : []);
                    allWorkers = allWorkers.concat(peersArr.map(p => {
                        if (typeof p === "string") {
                            return { name: p, url: p, status: "ACTIVO", role: "follower" };
                        }
                        return {
                            name: p.id || p.url,
                            url: p.url,
                            status: p.alive ? "ACTIVO" : "CAIDO",
                            role: p.id === leaderName ? "leader" : "follower"
                        };
                    }));
                    
                    // Añadir al propio coordinador si no está
                    if (!allWorkers.find(w => w.name === peersRes.data.id)) {
                        allWorkers.unshift({
                            name: peersRes.data.id,
                            url: peersRes.data.url || parentUrl,
                            status: "ACTIVO",
                            role: peersRes.data.role
                        });
                    }
                }
            } catch (err2) {}
            
            return res.json({ leader: leaderName, workers: allWorkers });
        }
    }
    res.json({ leader: parentName !== "Coordinador" ? parentName : parentUrl, workers: [] });
});

app.post("/send-to", async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: "Faltan datos" });

    if (status === "registrado" && parentUrl) {
        try {
            // Enviar al coordinador para que lo enrute al destinatario correcto (worker o coordinador)
            const resp = await axios.post(`${parentUrl}/messages`, {
                sender: WORKER_NAME,
                target: to,
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
    // Formato compatible con parcial-ssd-main: objetos descriptivos con type, description, payload, example, result
    const CAPABILITY_DESCRIPTIONS = {
        vector_distance: {
            description: "Distancia entre dos vectores de dos dimensiones",
            payload: { a: "number[2]", b: "number[2]" },
            example: { a: [0, 0], b: [3, 4] },
            result: { distance: "number" }
        },
        http_latency: {
            description: "Latencia en milisegundos de una URL",
            payload: { url: "string" },
            example: { url: "https://example.com" },
            result: { ms: "number" }
        },
        generate_password: {
            description: "Genera una contraseña aleatoria de la longitud especificada",
            payload: { length: "number (opcional, por defecto 12)" },
            example: { length: 16 },
            result: { password: "string" }
        },
        math_compute: {
            description: "Calculadora básica: una operación y dos operandos",
            payload: { operation: "add | sub | mul | div", a: "number", b: "number" },
            example: { operation: "add", a: 10, b: 5 },
            result: { result: "number" }
        },
        http_fetch: {
            description: "Hace fetch a una URL y devuelve status y cuerpo",
            payload: { url: "string" },
            example: { url: "https://example.com" },
            result: { status: "number", body: "any" }
        },
        search_text: {
            description: "Cuenta cuántas veces aparece el query dentro del texto",
            payload: { text: "string", query: "string" },
            example: { text: "hola mundo hola", query: "hola" },
            result: { count: "number" }
        },
        stats_compute: {
            description: "Promedio, mínimo y máximo de una lista de números",
            payload: { numbers: "number[]" },
            example: { numbers: [1, 2, 3, 4, 5] },
            result: { mean: "number", min: "number", max: "number" }
        },
        count_vowels: {
            description: "Cuenta las vocales de un texto",
            payload: { text: "string" },
            example: { text: "hola mundo" },
            result: { vowels: "number" }
        },
        text_transform: {
            description: "Transforma un texto a mayúsculas o minúsculas",
            payload: { text: "string", operation: "uppercase|lowercase" },
            example: { text: "hola", operation: "uppercase" },
            result: { text: "string" }
        }
    };

    // Obtener las capacidades reales del tasks.service
    const allCapabilities = tasks.getSupportedCapabilities();

    const capabilitiesDetail = allCapabilities.map(type => {
        const desc = CAPABILITY_DESCRIPTIONS[type] || {};
        return {
            type,
            description: desc.description || type,
            payload: desc.payload || null,
            example: desc.example || null,
            result: desc.result || null
        };
    });

    // Respuesta compatible con parcial-ssd-main Y con nuestro formato
    res.json({
        type: "capabilities",
        data: {
            id: WORKER_NAME,
            capabilities: capabilitiesDetail
        },
        // Mantener retrocompatibilidad con nuestro coordinador
        capabilities: allCapabilities,
        schemas: {
            "generate_password": { "length": 12 }
        }
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

    // ✔️ GUARDIA DE CAPACIDADES: verificar con las capacidades reales del tasks.service
    const allCapabilities = tasks.getSupportedCapabilities();
    if (!allCapabilities.includes(taskType)) {
        const errorResult = {
            type: "task-result",
            data: {
                taskId,
                status: "error",
                error: `Este worker no puede realizar la tarea '${taskType}'. Mis capacidades son: [${allCapabilities.join(", ")}]`,
                workerId: WORKER_NAME,
                taskType: taskType
            }
        };
        logger.warn(`Tarea rechazada: '${taskType}' no está en mis capacidades`);
        journal.record("tarea_rechazada", { taskId, taskType });
        // Responder 400 con formato compatible con parcial-ssd-main
        res.status(400).json({ type: "error", data: { message: `No tengo la capacidad '${taskType}'`, capabilities: allCapabilities } });
        if (parentUrl) {
            try {
                console.log("📤 [JSON ENVIADO - RECHAZO]:", JSON.stringify(errorResult, null, 2));
                await axios.post(`${parentUrl}/task/receive`, errorResult, { timeout: 3000 });
            } catch (e) {
                logger.error(`No se pudo notificar rechazo de ${taskId}: ${e.message}`);
            }
        }
        return;
    }

    // Responder inmediatamente con 202 (Accepted) — formato compatible con parcial-ssd-main
    res.status(202).json({ type: "task-accepted", data: { taskId, workerId: WORKER_NAME } });

    logger.info(`Iniciando tarea ${taskId} de tipo ${taskType}`);
    journal.record("tarea_iniciada", { taskId, taskType });
    
    // Inyectar en el chat de la UI que se recibió la tarea
    inbox.unshift({
        id: "task_start_" + Date.now(),
        from: "Coordinador",
        fromUrl: null,
        to: WORKER_NAME,
        message: `⚙️ [NUEVA TAREA] ${taskType} | ID: ${taskId}`,
        timestamp: Date.now(),
        receivedAt: new Date().toLocaleTimeString()
    });
    if (inbox.length > 50) inbox.pop();

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
                result,
                workerId: WORKER_NAME,
                taskType: taskType
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
                error: err.message,
                workerId: WORKER_NAME,
                taskType: taskType
            }
        };
        logger.error(`Error en tarea ${taskId}: ${err.message}`);
        journal.record("tarea_error", { taskId, error: err.message });
    }

    // Enviar el resultado al coordinador actual (workerId dentro del body para compatibilidad)
    if (parentUrl) {
        try {
            console.log("📤 [JSON ENVIADO - RESULTADO]:", JSON.stringify(resultMsg, null, 2));
            await axios.post(`${parentUrl}/task/receive`, resultMsg, { timeout: 3000 });
            
            // Inyectar en el chat de la UI el resultado
            const resTxt = resultMsg.data.status === "ok" ? JSON.stringify(resultMsg.data.result) : `Error: ${resultMsg.data.error}`;
            inbox.unshift({
                id: "task_res_" + Date.now(),
                from: WORKER_NAME,
                fromUrl: null,
                to: "Coordinador",
                message: `✅ [TAREA COMPLETADA] ${taskType} | Resultado: ${resTxt}`,
                timestamp: Date.now(),
                receivedAt: new Date().toLocaleTimeString()
            });
            if (inbox.length > 50) inbox.pop();
            
        } catch (e) {
            logger.error(`No se pudo enviar el resultado de ${taskId} al coordinador: ${e.message}`);
        }
    }
});

app.post("/stop-pulse", (_req, res) => { pulse.stop(); res.json({ ok: true, pulsing: false }); });
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
    res.json({ ok: true, message: `${WORKER_NAME} dejó de enviar pulsos` });
    setTimeout(() => process.exit(0), 500);
});

// ─── GET /health — Sonda activa del coordinador (compatibilidad con parcial-ssd-main) ──
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        name: WORKER_NAME,
        uptimeMs: Math.floor(process.uptime() * 1000),
        pulsing: status === "registrado",
        registered: status === "registrado",
        load: parseFloat((Math.random() * 0.5).toFixed(2)),
        host: {
            hostname: require("os").hostname(),
            platform: require("os").platform(),
            arch: require("os").arch(),
            node: process.version
        }
    });
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
