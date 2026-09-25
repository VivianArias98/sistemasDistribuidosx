# API, Endpoints y Variables de Entorno

Este documento recopila la configuración disponible a través de variables de entorno, los scripts de ejecución de procesos y todos los endpoints HTTP del Coordinador (y Naming Service).

---

## ⚙️ Variables de Entorno (`.env`)

Las configuraciones se manejan por variables de entorno, típicamente definidas en el archivo `.env`.

### Para el Coordinador
- **`NODE_ID`**: Identificador único del nodo coordinador (Ej: `A`, `B`, `C`).
- **`PORT`**: Puerto HTTP donde corre el coordinador (Ej: `3001`).
- **`PEERS`**: URLs iniciales de otros coordinadores separadas por comas (Ej: `http://localhost:3002,http://localhost:3003`). Sirven como semillas para el Gossip Protocol.
- **`TIMING_PRESET`**: Perfil de tiempos de red. `lan` (rápido, localhost) o `wan` (para túneles como ngrok con más tolerancia a latencia).
- **`ALGO`**: (Opcional) Define el algoritmo inicial, por defecto `bully`.
- **`WORKER_TIMEOUT_MS`**: (Opcional) Tiempo en milisegundos tras el cual un worker sin pulso se marca como caído. Por defecto `15000`.

### Para el Worker
- **`WORKER_PORT`**: Puerto HTTP donde corre el worker.
- **`WORKER_NAME`**: Identificador único en el Naming Service.
- **`WORKER_URL`**: URL que enviará al coordinador para su registro.
- **`COORDINATORS`**: Lista de URLs de coordinadores separados por comas para buscar en dónde registrarse.
- **`PULSE_INTERVAL_MS`**: Frecuencia de envío del latido (heartbeat).

---

## 🚀 Procesos y Scripts de Ejecución (`npm run`)

Listado en `package.json`:
- `npm start` / `npm run dev`: Ejecuta el coordinador (`src/coordinator/server.js`).
- `npm run worker`: Inicia una instancia de worker.
- `npm run cluster`: Despliega múltiples nodos en modo clúster local para probar los algoritmos localmente (`scripts/cluster.js`).
- `npm run verify`: Ejecuta verificaciones post-elección en el clúster.

---

## 🌐 Endpoints del Coordinador (Naming Service & Server)

El Coordinador expone los siguientes endpoints para el registro y resolución. Si una petición requiere el Líder (ej. `/register`), pero llega a un nodo Seguidor, este devolverá un 409 o 200 con formato `redirect` indicando el `leaderUrl`.

### Naming Service
- **`POST /register`**: Registra un worker y su URL (previene colisiones de IP/nombre).
- **`GET /resolve/:name`**: Busca la URL de un nombre en la red (resuelve localmente y distribuidamente usando vecinos si es necesario).
- **`GET /naming` / `GET /servers`**: Devuelve la lista completa de workers y peers.
- **`POST /unregister/:name`**: Desregistro voluntario.
- **`POST /hotreload/:name` / `POST /servers/:name/url`**: Actualiza dinámicamente la URL de un worker registrado.

### Mensajería
- **`POST /send-message/:name`**: Mensaje de un worker al coordinador principal.
- **`POST /api/send-message`**: API de enrutamiento avanzado, manda un mensaje desde un worker `from` a uno `to`. Enruta utilizando peers o búsqueda distribuida.
- **`POST /receive-message`**: Recibe un mensaje dirigido al Coordinador o enruta a un Worker local (modo Gateway).
- **`GET /messages` / `GET /api/messages`**: Devuelve el historial de mensajes de la red.
- **`DELETE /api/messages`**: Borra el historial.

### Pulsos y Mantenimiento
- **`POST /heartbeat/:name` / `POST /pulse/:name`**: Endpoint donde el worker confirma que está vivo. Devuelve el estado actual de los pares del coordinador y la dirección del líder actual.

---

## 🗳️ Endpoints de Elección y Protocolo Gossip

Usados internamente por los Coordinadores (engine) para elegir al líder.

- **`POST /election/message`**: Recibe mensajes del Algoritmo Bully (Election, Ok, Coordinator).
- **`POST /election/ping`**: Heartbeat distribuido de **Gossip**. Se usa para intercambiar `peers` activos (quién conoce a quién).
- **`GET /election/state`**: Devuelve la foto actual de este nodo (su ID, Rol, Término y Líder conocido).
- **`GET /cluster`**: Devuelve la visión global del cluster (nodos vivos, split-brain, si se convergió en un líder, etc).
- **`POST /election/algorithm`**: Cambia en caliente (`hot swap`) el algoritmo a usar (`{ algo: "bully" }`).
- **`POST /election/trigger`**: Dispara forzosamente una nueva elección (dimisión).
- **`POST /election/kill-leader`**: Contacta remotamente al líder actual para ordenarle que dimita.
- **`DELETE /election/peers?url=...`**: Elimina a un peer de la lista del clúster (desconexión).
- **`GET /events`**: Server-Sent Events (SSE). Los clientes pueden suscribirse a este endpoint para reaccionar a cambios en tiempo real del clúster.

---

## 🌪️ Endpoints de Chaos Engineering (Debug / Fallos)

Permiten probar la resiliencia de la red simulando caídas sin detener el proceso real de Node.js.

- **`POST /debug/faults/pause`**: Pone al nodo en modo pausa (ignora pings, no participa).
- **`POST /debug/faults/resume`**: Despausa el nodo.
- **`POST /debug/faults/partition`**: `{ target: "url" }`. Crea una partición de red con ese `target`.
- **`POST /debug/faults/heal`**: Cura las particiones (si no hay body `target`, cura a todos).
- **`POST /debug/faults/latency`**: `{ ms: 500 }`. Inyecta latencia a todas las llamadas emitidas.
- **`POST /debug/faults/drop-rate`**: `{ rate: 0.3 }`. Genera pérdida de paquetes (30% de rechazos al azar).
- **`GET /debug/faults`**: Devuelve la foto de configuración actual del Chaos Engineering.
- **`POST /api/simulate-failure/:name`**: Apaga lógicamente a un worker/peer (lo marca como CAIDO forzando que el timeout lo detecte).
