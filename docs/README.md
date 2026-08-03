# Documentación del SDK

El [README](../README.md) alcanza para usar el SDK. Esto es para entenderlo: por qué
tiene la forma que tiene y qué hace el servidor del otro lado.

| Documento | De qué trata |
|---|---|
| [conceptos.md](conceptos.md) | El modelo de Caerus: plantillas, recursos, holders, el ciclo de vida de una reserva |
| [arquitectura.md](arquitectura.md) | Cómo está armado el SDK por dentro y por qué |
| [errores.md](errores.md) | Qué error tira cada cosa y cómo se decide |
| [probar-contra-caerus-real.md](probar-contra-caerus-real.md) | Levantar un Caerus y correr el SDK contra él |

Para trabajar **sobre** el SDK, arrancá por [`AGENTS.md`](../AGENTS.md).

## Lo que conviene saber antes que nada

**El SDK no toma decisiones.** No reintenta, no cachea, no mantiene estado. Traduce
llamadas a gRPC y respuestas a tipos del dominio. Si algo falla, se entera quien llamó.
Eso es deliberado: un SDK que reintenta por su cuenta convierte un problema visible en
uno intermitente.

**Hay dos implementaciones de la misma interfaz.** `CaerusClient` habla con un motor
real; `InMemoryCaerusClient` hace lo mismo en memoria. Tu código puede pedir
`SharedResourceApi` y no enterarse de cuál le tocó.

**El `.proto` de este repo es una copia**, no el original. Ver
[`proto/README.md`](../proto/README.md); importa más de lo que parece.
