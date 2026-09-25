# El Worker (Nodo)

Los **Workers** son los nodos que conforman el clúster de cómputo del sistema distribuido. 
Se encuentran en `src/worker/`.

## Ciclo de Vida
1. **Inicio (`index.js` / `app.js`)**: El worker inicializa sus configuraciones y busca al [[Coordinador]] leyendo las variables de entorno (e.g. `PARENT_URL`).
2. **Registro**: Se conecta al Servicio de Nombres. 
3. **Heartbeat**: Mediante la capa de red o utilidades (`utils/`), el worker envía periódicamente un "pulso" (Heartbeat) al Coordinador para evitar ser marcado como inactivo por el servicio de `cleanup.js`.
4. **Trabajo**: Los workers pueden recibir mensajes y tareas.
5. **Chaos Engineering**: Los workers están programados para ser resilientes. Si son terminados repentinamente (Chaos Engineering o kill aleatorio), la red se entera gracias a la ausencia de pulso.

## Resiliencia
Si el Coordinador no responde, los workers desencadenarán mecanismos de salvaguarda (ver [[Algoritmos]]) para mantener la red operando de manera descentralizada o avisando de la caída masiva.
