# Algoritmos Distribuidos

El proyecto `sistemasDistribuidosx` hace uso de varios patrones y algoritmos clásicos de sistemas distribuidos para garantizar resiliencia y consenso.

## Algoritmo Bully (Elección de Líder)
Si un [[Worker]] detecta que el líder actual (o el coordinador) ha dejado de responder, puede iniciar una **Elección**.
1. Un nodo manda un mensaje de elección a todos los nodos con IDs superiores al suyo.
2. Si ninguno responde en un tiempo determinado, este nodo asume el rol de líder (coordinador sustituto).
3. Si un nodo de mayor ID responde, ese asume la elección y este nodo espera.

## Protocolo Gossip (Chisme)
En vez de saturar al coordinador central para enviar estado a todo el mundo, la información puede diseminarse usando **Gossip Protocol**.
- Un nodo elige aleatoriamente a un subconjunto de pares (`peers`) y les manda el estado.
- Esos nodos hacen lo mismo, propagando exponencialmente la información en la red.
- **Ventaja**: Altamente tolerante a fallos y sin cuellos de botella centralizados.

## Chaos Engineering
No es un algoritmo per se, sino una práctica de inyectar fallas.
- Se "mata" un worker o se interrumpe la red aleatoriamente.
- El panel del [[Coordinador]] permite ver si los algoritmos Bully o el servicio de limpieza detectan el fallo adecuadamente y se recuperan de manera autónoma.
