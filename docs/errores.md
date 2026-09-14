# Errores

Todo lo que tira el SDK extiende `CaerusError`, así que un solo `catch` los junta a
todos. Cada uno lleva un `code` que se puede usar en un `switch` sin depender de
`instanceof`.

```typescript
try {
  await caerus.pooled('curso-3').takeMany(1, { idempotencyKey: k });
} catch (e) {
  if (e instanceof ConflictError) return 'no hay lugar';
  throw e;
}
```

## El mapeo

Sale de `sre/errors.ts` y refleja lo que el servidor hace en `GrpcGlobalExceptionHandler`.
No es una convención general de gRPC: es este servidor.

| Estado gRPC | Error del SDK | `code` | Cuándo |
|---|---|---|---|
| `NOT_FOUND` | `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | El recurso, la plantilla o el holder no existen |
| `FAILED_PRECONDITION` | `ConflictError` | `CONFLICT` | El estado no permite la operación |
| `INVALID_ARGUMENT` | `ValidationError` | `VALIDATION` | El pedido en sí está mal formado |
| `UNAUTHENTICATED` | `AuthenticationError` | `AUTHENTICATION` | API Key ausente, mal formada, desconocida o revocada |
| `DEADLINE_EXCEEDED` | `TimeoutError` | `TIMEOUT` | La llamada pasó su deadline |
| cualquier otro | `CaerusError` | `UNKNOWN` | Incluye `INTERNAL` |

## `ConflictError` junta varias cosas, y ahora se distinguen

Cubre quedarse sin stock, operar sobre un holder que ya terminó, y borrar un recurso que
alguien todavía tiene tomado. Las tres llegan como `FAILED_PRECONDITION`.

El motor manda además un código propio, y el SDK lo convierte en subclases:

| Subclase | Cuándo |
|---|---|
| `OutOfStockError` | No quedan unidades libres |
| `HolderNotActiveError` | El holder está `RELEASED`, `CONFIRMED` o `EXPIRED` |
| `ResourceHasActiveHoldsError` | No se puede borrar: alguien lo tiene tomado |
| `ResourceHasQueuedRequestsError` | No se puede borrar: hay gente en la cola |

```typescript
try {
  await caerus.unitary('butaca_A1').take({ idempotencyKey: clave });
} catch (e) {
  if (e instanceof OutOfStockError) return 'ya la tomó otro';
  if (e instanceof HolderNotActiveError) return 'tu reserva venció, empezá de nuevo';
  throw e;
}
```

**Las cuatro siguen siendo `ConflictError`**, así que el código que ya lo capturaba no
cambia. Y cualquier error trae `error.reason` con el código tal cual lo mandó el motor
—`OUT_OF_STOCK`, `TEMPLATE_NOT_FOUND`, los de locks— para los casos que todavía no
tienen subclase propia.

Nunca hace falta leer el texto del mensaje. El mensaje está escrito para personas y puede
cambiar; `reason` es contrato.

Si el motor no manda código —una versión vieja— el SDK devuelve el `ConflictError` de
siempre y `reason` queda en `undefined`.

Vale la pena saber por qué **no** es `RESOURCE_EXHAUSTED`, que a primera vista suena
mejor para "no hay stock". En gRPC ese código es para límites del sistema —cuotas,
tamaño de mensaje, memoria—, no para estado del negocio. Quedarse sin butacas es un
estado perfectamente normal del dominio, no un recurso del sistema agotado. Este SDK ya
tuvo `RESOURCE_EXHAUSTED` y se revirtió por eso.

## Errores en Distributed Locking (DLS)

En DLS (`src/dls/dls-errors.ts`), los errores específicos del motor de locks se mapean a subclases de `DlsError` mediante el trailer `ErrorInfo.reason`:

| Subclase DLS | `reason` | Estado gRPC | Cuándo ocurre |
|---|---|---|---|
| `DeadlockAbortedError` | `DEADLOCK_DETECTED` | `ABORTED` | El detector DFS encontró un ciclo y sacrificó esta transacción como víctima |
| `TransactionNotActiveError` | `TRANSACTION_NOT_ACTIVE` | `FAILED_PRECONDITION` | La transacción ya no está activa: fue completada (`COMPLETED`), cancelada durante la espera (`releaseTransactionLocks`) o expirada por tiempo de vida (`MAX_LIFETIME_EXCEEDED`) |
| `LockAlreadyHeldError` | `LOCK_ALREADY_HELD_EXCLUSIVELY` | `ALREADY_EXISTS` | La transacción ya posee ese lock de forma exclusiva |
| `LockModeMismatchError` | `LOCK_MODE_MISMATCH` | `INVALID_ARGUMENT` | Se pidió un modo incompatible con la plantilla (ej. SHARED_READ en plantilla EXCLUSIVE) |
| `LockAcquisitionCancelledError`| `LOCK_ACQUISITION_CANCELLED` | `CANCELLED` | El cliente canceló el stream antes de que se concediera el lock (ej. mediante `AbortSignal`) |
| `DlsNotFoundError` | `RESOURCE_NOT_FOUND` | `NOT_FOUND` | La transacción o el recurso no existen |

> 💡 **Nota sobre `status: DENIED`:** Cuando un lock no se puede otorgar (estrategia `FAIL` o timeout de cola superado), el stream gRPC responde con éxito `OK` y payload `{ status: DENIED }`. No se lanza excepción para evitar ensuciar el código del cliente con `try/catch`.

### Cancelación de Locks en Espera (`QUEUED`)
En la estrategia `QUEUE`, un cliente no recibe un `lockId` mientras está esperando en cola (solo se asigna al conceder el lock con status `ACQUIRED`). Por ello, no se invoca `releaseLock` sobre locks encolados. Para cancelar una espera, existen dos mecanismos:
1. **Cancelar la llamada gRPC con `AbortSignal`:** Al abortar el stream con `controller.abort()`, el servidor detecta la desconexión del cliente gRPC en milisegundos, remueve el nodo de la cola en ZooKeeper y notifica inmediatamente al siguiente en la fila.
2. **Cancelar la transacción completa:** Al llamar a `releaseTransactionLocks(transactionId)`, el servidor limpia los znodes de los locks encolados y pasa la transacción a `COMPLETED` (o `ABORTED`), haciendo que el stream en espera falle de inmediato con `TransactionNotActiveError` (`TRANSACTION_NOT_ACTIVE`).

## `INTERNAL` y Trazabilidad con `error.requestId`

Cuando ocurre un fallo interno del lado del servidor, llega un `CaerusError` protegiendo las internas del cluster por seguridad. Sin embargo, cada error incluye un identificador único de correlación:

```typescript
try {
  await caerus.unitary('butaca_1').take();
} catch (error) {
  if (error instanceof CaerusError) {
    console.error(`Error: ${error.code} (${error.reason})`);
    console.error(`Request ID: ${error.requestId}`);
    console.error(`Guía de ayuda: ${error.docUrl}`);
  }
}
```

* **`error.requestId`**: Identificador único de la solicitud (ej: `req_3fa85f64-5717-4562-b3fc-2c963f66afa6`).
* **Soporte en Discord**: Puedes ingresar a nuestro canal de `#soporte` en Discord y compartirnos tu `requestId` junto con tu fragmento de código. Con este ID, nuestro equipo puede ubicar la traza exacta en los logs del servidor al milisegundo sin que tengas que compartir claves secretas ni datos de tu aplicación.
* **`error.docUrl`**: Enlace directo a la documentación específica para ese código de error.

## `TimeoutError` no significa que no pasó nada

Significa que la llamada pasó su deadline. **Si el servidor llegó a hacer el trabajo o
no, no se sabe.** Puede haber un holder creado del que nunca te enteraste.

Por eso importa la clave de idempotencia: reintentar con la misma clave devuelve el
holder que ya existía en vez de crear un segundo.

Ojo con qué holder es ese: el motor te devuelve el que corresponda a la clave, en el
estado en que esté ahora, así que puede venir `RELEASED` o `EXPIRED` con respuesta
exitosa. Conviene mirar el `status`. Está explicado en
[conceptos.md](conceptos.md#idempotencia).

## El SDK no reintenta

Ninguna operación se reintenta sola, ni siquiera las de lectura. Es deliberado: un
reintento automático convierte un problema visible en uno intermitente, y en un sistema
de reservas los reintentos silenciosos son exactamente cómo se entrega la misma butaca
dos veces.

Reintentar es decisión de quien llama, y para hacerlo con seguridad están las claves de
idempotencia.
