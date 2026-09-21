---
name: distributed-system
description: Context and guidelines for developing the Distributed Resilient System (Coordinador-Worker, Bully, Gossip).
---

# Distributed Resilient System Development Guide

This skill provides context and guidelines for working on the `distributed-resilient-system` project.

## Architecture & Concepts
- **Coordinator-Worker Architecture**: The system uses a coordinator and multiple workers.
- **Algorithms**: Implements the Bully Algorithm for leader election and Gossip protocol for node discovery/communication.
- **Chaos Engineering**: Includes fault injection and debug routes to test system resilience.
- **Dynamic Setup**: The system allows hot-configuration via the Setup Wizard (`/setup.html` and `/api/setup`).

## Running the System
- **Start Coordinator**: `npm start` or `npm run dev`
- **Start Worker**: `npm run worker`
- **Cluster/MiniServer**: `node miniServer.js 4001 MiWorker1 http://localhost:4001 http://localhost:3000` (Based on `links.md` instructions).

## Development Guidelines
1. **Routing**: API and Coordinator routes are located in `src/coordinator/routes/`. 
   - `election.routes.js`: Bully/Gossip logic.
   - `debug.routes.js`: Chaos engineering and debugging.
   - `server.routes.js`: General API and worker registration.
2. **Resilience First**: Always handle potential network failures, timeouts, and node disconnections. The `transport.js` layer should be used for inter-node communication.
3. **CORS & ngrok**: The system is designed to work across ngrok tunnels. Ensure `ngrok-skip-browser-warning` headers are maintained.
4. **State Management**: Node configuration is hot-loaded through the `config.js` and engine is started dynamically if not configured initially.

## Key Files
- `src/coordinator/app.js`: Express setup, middleware, ngrok URL detection, and hot-setup logic.
- `src/coordinator/election/engine.js`: Leader election state machine and logic.
- `package.json`: Main scripts (`dev`, `start`, `worker`, `cluster`).
- `miniServer.js`: Local testing server script.
