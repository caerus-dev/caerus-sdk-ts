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

## `INTERNAL` siempre dice lo mismo

Cuando algo se rompe del lado del servidor, llega un `CaerusError` con
`Unexpected gRPC error` y nada más. Es a propósito: el servidor no filtra sus internas.

Si ves eso, el detalle está en los logs del data plane. Del lado del cliente no hay más
información por sacar.

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
