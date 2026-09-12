# Verificación contra un motor real

Los tests del paquete corren contra un motor falso: son rápidos, no necesitan
infraestructura y entran en el CI. Lo que no pueden probar es que el motor de verdad se
comporte como el SDK espera — ahí entra esta verificación.

```bash
npm run build
CAERUS_API_KEY=tu_clave npm run verify:live
```

Termina con código 0 si todo pasó, y con 1 si falló algo. No corre en el CI porque necesita
un Caerus levantado.

## Qué comprueba

| Escenario | Qué demuestra |
|---|---|
| Dos lectores `SHARED_READ` sobre la misma clave | Entran a la vez, y `getLockStatus` los lista a los dos |
| Un escritor con lectores activos | No entra |
| `releaseLock` de un solo lector | El otro sigue |
| Lock denegado en namespace `FAIL` | Llega como `LockDeniedError`, no como valor de retorno |
| Deadlock de dos | Se aborta una sola, con `DEADLOCK_DETECTED` |
| Deadlock triangular | Se rompe el ciclo sin matar a las tres |
| Deadlock con estrategia `ALERT` | No se aborta a nadie |
| `getTransactionStatus` con un lock en la cola | Responde en vez de fallar |
| `onQueued` mientras un pedido espera en la cola | Avisa una sola vez y antes de que se conceda, aunque el motor mande keep-alives |

## Qué necesita del ambiente

Cuatro namespaces, porque cada uno ejercita una configuración distinta. Se crean desde el
dashboard, o por SQL contra la base del data plane:

| Namespace | `lock_type` | `conflict_resolution` | `deadlock_resolution_strategy` |
|---|---|---|---|
| `cuenta` | `EXCLUSIVE` | `FAIL` | `KILL_PRIORITY` |
| `cuenta_cola` | `EXCLUSIVE` | `QUEUE` | `KILL_PRIORITY` |
| `cuenta_alerta` | `EXCLUSIVE` | `QUEUE` | `ALERT` |
| `archivo` | `READ_WRITE` | `QUEUE` | `KILL_PRIORITY` |

Los nombres se pueden cambiar por variables de entorno: `DLS_NS_FAIL`, `DLS_NS_QUEUE`,
`DLS_NS_ALERT` y `DLS_NS_READ_WRITE`.

El endpoint sale de `CAERUS_ENDPOINT` y por defecto es `localhost:9090` sin TLS. Contra el
ambiente desplegado hay que pasar `CAERUS_ENDPOINT` y `CAERUS_TLS=true`.

## Por qué existe aparte de los tests

Un mock prueba que el SDK hace lo que creemos que el motor pide. Solo el motor puede decir
si eso era cierto. Las dos veces que el SDK tuvo un defecto de contrato —un lock denegado
que volvía como valor, y un `fencingToken` en cero— los tests contra el mock pasaban.
