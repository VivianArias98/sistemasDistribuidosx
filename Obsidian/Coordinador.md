# El Coordinador

El **Coordinador** actúa como el punto central de registro y observabilidad (Servicio de Nombres / Naming Service). Su rol principal NO es hacer el procesamiento pesado, sino mantener el estado de la red.

## Estructura
Ubicado en `src/coordinator/`.

- **server.js**: Inicializa el servidor Express, carga middlewares y arranca los [[Servicios]].
- **public/**: Panel visual (Frontend) para la observabilidad del sistema en tiempo real.
- **services/**:
  - `registry.js`: Lógica dura para inscribir nuevos workers. Revisa que no haya colisiones de nombre e IP.
  - `cleanup.js`: Un cron/intervalo que limpia o marca como inactivos los nodos que han excedido su `TIMEOUT` sin enviar un pulso.
  - `messages.js`: Maneja el historial de mensajes de la red (para debug o observabilidad).
  - `processManager.js`: Gestiona (si aplica) el ciclo de vida de otros procesos locales si se corre en un solo servidor de prueba.

## Relación
El Coordinador es la fuente de la verdad inicial. Si el Coordinador cae, los workers usan [[Algoritmos]] como el **Algoritmo Bully** para elegir a un nuevo coordinador (o al menos un líder temporal de los workers).
