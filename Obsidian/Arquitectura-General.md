# Arquitectura General

El sistema sigue una arquitectura centralizada para el descubrimiento (mediante el [[Coordinador]]) pero distribuida para el trabajo y la tolerancia a fallos mediante los nodos [[Worker]].

## Flujo Principal
1. El **Coordinador** se levanta y expone un API (con Express).
2. Los nodos **Worker** se inician y buscan la URL del Coordinador.
3. El Worker hace un `POST /register` para inscribirse en el **Naming Service** (Servicio de Nombres).
4. El Coordinador registra al Worker y le asigna un estado `ACTIVO`.
5. Comienza el ciclo de monitorización: el Worker emite **Pulsos (Heartbeats)** periódicos para demostrar que está vivo.
6. Si el pulso falla, los [[Servicios]] de limpieza (`cleanup.js`) del Coordinador marcan al Worker como inactivo.

## Conceptos Clave
- [[Algoritmos]]: Cómo maneja la red la elección de un nuevo líder o la diseminación de la información.
- **Observabilidad**: El panel público (`/public/app.js` y `index.html`) monitorea los eventos del sistema usando Long Polling o llamadas periódicas para visualizar caídas y recuperaciones.
