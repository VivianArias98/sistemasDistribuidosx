const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');

const port = process.argv[2];
const url = process.argv[3];

if (!port || !url) {
    console.error("Uso: node index.js {PUERTO} {URL_NGROK}");
    console.error("Ejemplo: node index.js 3000 https://nombre-random-ngrok.dev");
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log("==================================================");
console.log("    SISTEMA DISTRIBUIDO COORDINADOR-TRABAJADOR");
console.log("==================================================");
console.log(`Puerto asignado: ${port}`);
console.log(`URL asignada: ${url}\n`);

rl.question('¿Qué deseas iniciar? (1 para Coordinador, 2 para Trabajador): ', (answer) => {
    rl.question('Ingresa tu nombre (ej. jose): ', (nombre) => {
        rl.question('Ingresa tu código estudiantil (ej. 55217003): ', (codigo) => {
            const isWorker = answer.trim() === '2';
            const roleName = isWorker ? 'worker' : 'coordinator';
            
            const preguntaUrl = isWorker 
                ? 'Ingresa la URL del Coordinador al que te vas a conectar: '
                : 'Ingresa la URL de otro Coordinador (deja en blanco si eres el primero): ';
                
            rl.question(preguntaUrl, (urls) => {
                rl.close();

                const id = `${roleName}-${nombre.trim()}-${codigo.trim()}`;

                console.log(`\nIniciando como ${id} en puerto ${port}...`);

                // Configurar variables de entorno requeridas por el código
                const env = {
                    ...process.env,
                    PORT: port,
                    BASE_URL: url,
                    WORKER_PORT: port,
                    WORKER_URL: url,
                    NODE_ID: id,
                    WORKER_NAME: id
                };
                
                if (urls.trim()) {
                    if (isWorker) {
                        env.COORDINATORS = urls.trim();
                    } else {
                        env.PEERS = urls.trim();
                    }
                }

                const scriptPath = isWorker 
                    ? path.join(__dirname, 'src', 'worker', 'index.js')
                    : path.join(__dirname, 'src', 'coordinator', 'server.js');

                const child = spawn('node', [scriptPath], { stdio: 'inherit', env });

                child.on('close', (code) => {
                    console.log(`Proceso terminado con código ${code}`);
                });
            });
        });
    });
});
