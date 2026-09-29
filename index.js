const { spawn } = require('child_process');
const path = require('path');
const express = require('express');

const port = process.argv[2];
const url = process.argv[3];

if (!port || !url) {
    console.error("Uso: node index.js {PUERTO} {URL_NGROK}");
    console.error("Ejemplo: node index.js 3000 https://nombre-random-ngrok.dev");
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const htmlUI = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuración de Inicio - Sistema Distribuido</title>
    <style>
        :root {
            --bg-dark: #0f172a;
            --bg-card: #1e293b;
            --primary: #8b5cf6;
            --primary-hover: #7c3aed;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border: #334155;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: var(--bg-dark);
            color: var(--text-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }
        .container {
            background-color: var(--bg-card);
            border-radius: 12px;
            border: 1px solid var(--border);
            padding: 2rem;
            width: 100%;
            max-width: 480px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
        }
        h1 {
            margin-top: 0;
            font-size: 1.5rem;
            text-align: center;
            color: var(--primary);
            margin-bottom: 0.5rem;
        }
        p.subtitle {
            text-align: center;
            color: var(--text-muted);
            margin-bottom: 2rem;
            font-size: 0.9rem;
        }
        .form-group {
            margin-bottom: 1.5rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            font-size: 0.9rem;
        }
        input[type="text"] {
            width: 100%;
            padding: 0.75rem;
            border-radius: 8px;
            border: 1px solid var(--border);
            background-color: var(--bg-dark);
            color: var(--text-main);
            font-size: 1rem;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s;
        }
        input[type="text"]:focus {
            border-color: var(--primary);
        }
        .role-selector {
            display: flex;
            gap: 1rem;
            margin-bottom: 0.5rem;
        }
        .role-btn {
            flex: 1;
            padding: 0.75rem;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--bg-dark);
            color: var(--text-muted);
            cursor: pointer;
            text-align: center;
            font-weight: 600;
            transition: all 0.2s;
        }
        .role-btn.active {
            background: var(--primary);
            color: white;
            border-color: var(--primary);
        }
        input[type="radio"] {
            display: none;
        }
        button.submit-btn {
            width: 100%;
            padding: 1rem;
            background-color: var(--primary);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: bold;
            cursor: pointer;
            transition: background-color 0.2s;
            margin-top: 1rem;
        }
        button.submit-btn:hover {
            background-color: var(--primary-hover);
        }
        .help-text {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-top: 0.25rem;
        }
        
        /* Modal Loading */
        #loading-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(15, 23, 42, 0.9);
            justify-content: center;
            align-items: center;
            flex-direction: column;
            z-index: 1000;
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 5px solid var(--border);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 1rem;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>

    <div id="loading-overlay">
        <div class="spinner"></div>
        <h2 id="loading-msg" style="color: white;">Iniciando sistema...</h2>
        <p style="color: var(--text-muted);">Redirigiendo a la plataforma en unos segundos</p>
    </div>

    <div class="container" id="setup-form">
        <h1>Sistemas Distribuidos</h1>
        <p class="subtitle">Configuración inicial del nodo</p>

        <form onsubmit="iniciar(event)">
            <div class="form-group">
                <label>¿Qué deseas iniciar?</label>
                <div class="role-selector">
                    <label class="role-btn active" id="btn-coord" onclick="selectRole('coordinator')">
                        <input type="radio" name="role" value="coordinator" checked>
                        Coordinador
                    </label>
                    <label class="role-btn" id="btn-worker" onclick="selectRole('worker')">
                        <input type="radio" name="role" value="worker">
                        Trabajador
                    </label>
                </div>
            </div>

            <div class="form-group">
                <label>Tu Nombre</label>
                <input type="text" id="nombre" placeholder=" ej: xxxx" required>
            </div>

            <div class="form-group">
                <label>Código Estudiantil</label>
                <input type="text" id="codigo" placeholder="ej: 55217003" required>
            </div>

            <div class="form-group">
                <label id="url-label">URL de otro Coordinador</label>
                <input type="text" id="urls" placeholder="ej: https://...ngrok.dev">
                <div class="help-text" id="url-help">Deja en blanco si eres el primer coordinador.</div>
            </div>

            <button type="submit" class="submit-btn">Inicializar Nodo 🚀</button>
        </form>
    </div>

    <script>
        function selectRole(role) {
            document.getElementById('btn-coord').classList.remove('active');
            document.getElementById('btn-worker').classList.remove('active');
            
            if(role === 'coordinator') {
                document.getElementById('btn-coord').classList.add('active');
                document.getElementById('btn-coord').querySelector('input').checked = true;
                document.getElementById('url-label').textContent = 'URL de otro Coordinador';
                document.getElementById('url-help').textContent = 'Deja en blanco si eres el primer coordinador del clúster.';
                document.getElementById('urls').required = false;
            } else {
                document.getElementById('btn-worker').classList.add('active');
                document.getElementById('btn-worker').querySelector('input').checked = true;
                document.getElementById('url-label').textContent = 'URL del Coordinador al que te conectarás';
                document.getElementById('url-help').textContent = 'Obligatorio para los trabajadores.';
                document.getElementById('urls').required = true;
            }
        }

        async function iniciar(e) {
            e.preventDefault();
            
            const role = document.querySelector('input[name="role"]:checked').value;
            const nombre = document.getElementById('nombre').value;
            const codigo = document.getElementById('codigo').value;
            const urls = document.getElementById('urls').value;

            document.getElementById('setup-form').style.display = 'none';
            document.getElementById('loading-overlay').style.display = 'flex';
            
            const roleName = role === 'coordinator' ? 'Coordinador' : 'Trabajador';
            document.getElementById('loading-msg').textContent = \`Iniciando \${roleName}...\`;

            try {
                const res = await fetch('/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role, nombre, codigo, urls })
                });
                
                if (res.ok) {
                    // Esperar un poco a que el proceso hijo levante su servidor Express en el mismo puerto
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                } else {
                    alert("Error al iniciar.");
                    window.location.reload();
                }
            } catch (err) {
                // Si el fetch falla es porque el servidor Express de setup se apagó y ya está subiendo el de la app!
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            }
        }
    </script>
</body>
</html>
`;

app.get('*', (req, res) => {
    res.send(htmlUI);
});

let server;

app.post('/start', (req, res) => {
    const { role, nombre, codigo, urls } = req.body;

    const roleName = role === 'worker' ? 'worker' : 'coordinator';
    const id = `${roleName}-${nombre.trim()}-${codigo.trim()}`;

    console.log(`\nIniciando configuración desde UI web...`);
    console.log(`Rol: ${roleName}`);
    console.log(`ID: ${id}`);
    if (urls) console.log(`URLs objetivo: ${urls}`);

    const env = {
        ...process.env,
        PORT: port,
        BASE_URL: url,
        WORKER_PORT: port,
        WORKER_URL: url,
        NODE_ID: id,
        WORKER_NAME: id
    };

    if (urls && urls.trim()) {
        if (role === 'worker') {
            env.COORDINATORS = urls.trim();
        } else {
            env.PEERS = urls.trim();
        }
    }

    const scriptPath = role === 'worker'
        ? path.join(__dirname, 'src', 'worker', 'index.js')
        : path.join(__dirname, 'src', 'coordinator', 'server.js');

    // Respondemos a la UI
    res.json({ ok: true });

    // Apagamos este servidor temporal y lanzamos el hijo
    server.close(() => {
        console.log(`\nCambiando control al ${roleName} en puerto ${port}...`);

        const child = spawn('node', [scriptPath], { stdio: 'inherit', env });

        child.on('close', (code) => {
            console.log(`Proceso terminado con código ${code}`);
        });
    });
});

server = app.listen(port, () => {
    console.log("==================================================");
    console.log("    SISTEMA DISTRIBUIDO - ASISTENTE DE INICIO");
    console.log("==================================================");
    console.log(`Abra su navegador en: http://localhost:${port}`);
    console.log(`O use su URL de Ngrok: ${url}`);
    console.log("Esperando configuración desde la interfaz web...");
});
