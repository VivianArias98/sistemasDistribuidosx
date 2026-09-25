# Contexto del Proyecto: Sistema Distribuido Resiliente

Este repositorio contiene la implementación de un **Sistema Distribuido Resiliente** diseñado bajo la arquitectura **Coordinador-Worker**.

## Características Principales

1. **Servicio de Nombres (Naming Service):**
   - El sistema actúa como un directorio para registrar servidores (workers).
   - Previene conflictos de nombres y maneja la reconexión de nodos caídos.
   - Ruta principal de registro: `POST /register`.

2. **Algoritmos y Patrones Distribuidos:**
   - **Algoritmo Bully:** Usado para elección de líder entre los nodos.
   - **Protocolo Gossip:** Utilizado para la diseminación de información en la red.
   - **Chaos Engineering:** Herramientas para inyectar fallos y probar la resiliencia del sistema.

3. **Monitorización y Observabilidad:**
   - Panel de observabilidad estático (servido desde `/public`).
   - Mantenimiento de un historial de actividad (`activityLogs`) con un máximo de 150 eventos.
   - Eventos categorizados: REGISTRO, PULSO, MENSAJE, TIMEOUT, HOTRELOAD, RECUPERACION, ADVERTENCIA, ERROR.

4. **Heartbeats (Pulsos):**
   - El coordinador monitorea la salud de los nodos usando un tiempo límite (`TIMEOUT` de 15 segundos). Si un nodo no envía pulso en este tiempo, se marca como caído.

## Estructura del Código

- `server.js` / `miniServer.js`: Scripts legacy o alternativos de inicio del servidor.
- `src/coordinator/server.js`: Punto de entrada principal del coordinador.
- `src/worker/index.js`: Punto de entrada principal de los workers.
- `scripts/`: Contiene scripts de utilidad para orquestación de cluster y verificación de elecciones.
- `public/`: Archivos estáticos para el panel de monitoreo.

## Scripts de NPM

- `npm start` / `npm run dev`: Inicia el coordinador.
- `npm run worker`: Inicia un worker individual.
- `npm run cluster`: Despliega un cluster completo de prueba.
- `npm run verify`: Ejecuta el script de verificación de elecciones.

## Tecnologías
- **Node.js** con **Express**
- **Axios** para peticiones HTTP
- **Dotenv** para variables de entorno

---
*Este vault de Obsidian ha sido inicializado para permitir explorar el código fuente conectando los conceptos.*
