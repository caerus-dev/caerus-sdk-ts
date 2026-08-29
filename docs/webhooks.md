# Webhooks

Caerus emite eventos asíncronos para notificar a los sistemas cliente sobre cambios en
recursos compartidos (SRE), candados distribuidos (DLS) o el Control Plane.

El módulo `webhooks` del SDK provee utilidades puramente criptográficas y de tipado.
**No levanta un servidor HTTP**: se integra en el framework web que ya uses (Express,
Fastify, Next.js o el servidor nativo de Node.js).

---

## Cómo funciona la verificación

El SDK expone `caerus.webhooks.constructEvent(payload, signatureHeader, secret, toleranceSeconds?)`.

```typescript
const event = caerus.webhooks.constructEvent(rawBody, signature, webhookSecret);
```

### 1. Cabecera `Caerus-Signature`
Llega con el formato:
```
t=1700000000,v1=6b8a...3f
```
Puede incluir múltiples firmas `v1=` en caso de rotación de claves (*key rollover*). Si
al menos una firma coincide con el secreto configurado, se considera válida.

### 2. Seguridad criptográfica
- **HMAC-SHA256 en Hexadecimal:** Se firma la cadena `${timestamp}.${rawPayload}` con el secreto configurado.
- **Prevención de Timing Attacks:** Se compara usando `crypto.timingSafeEqual`, validando antes las longitudes de los buffers para evitar excepciones en runtime.
- **Prevención de Replay Attacks:** Valida que `|t_actual - t_evento| <= toleranceSeconds` (por defecto 300s / 5 minutos).
- **Preservación del payload original:** Requiere el `Buffer` o `string` crudo recibido en la petición HTTP. Parsear el body a JSON antes de la verificación alterará los caracteres e invalidará la firma.

---

## Errores específicos de Webhooks

A diferencia de las operaciones de gRPC (que heredan de `CaerusError`), los errores de
webhooks son puramente locales y extienden de `Error`:

| Error | Cuándo ocurre |
|---|---|
| `CaerusSignatureError` | Falta el header, el formato es inválido o ninguna firma coincide |
| `CaerusWebhookExpiredError` | La marca de tiempo está fuera de la tolerancia permitida |

---

## Tipado de eventos (Discriminated Unions)

`CaerusEvent` discrimina por `eventType`. Al hacer un `switch (event.eventType)`, TypeScript
infiere automáticamente la estructura de `event.data`:

```typescript
switch (event.eventType) {
  case 'resource.taken':
    // event.data es ResourceTakenData
    console.log(event.data.holderId, event.data.amount);
    break;

  case 'lock.deadlock_detected':
    // event.data es DeadlockDetectedData
    console.log(event.data.victimTransactionId);
    break;
}
```

Ver ejemplo ejecutable en [`examples/06-webhooks.ts`](../examples/06-webhooks.ts).

---

## Catálogo de Eventos

### 📦 Eventos SRE (`product: 'SRE'`)

| `eventType` | Descripción | Objeto Afectado (`objectType`) | Payload (`event.data`) |
|---|---|---|---|
| `resource.created` | Se crea un nuevo recurso compartido | `SHARED_RESOURCE` | `ResourceCreatedData` |
| `resource.taken` | Un holder toma cupo de un recurso | `RESOURCE_HOLDER` | `ResourceTakenData` |
| `resource.confirmed` | Se confirma la reserva de un recurso | `RESOURCE_HOLDER` | `ResourceConfirmedData` |
| `resource.released` | Se libera el cupo reservado de un recurso | `RESOURCE_HOLDER` | `ResourceReleasedData` |
| `resource.extended` | Se extiende el tiempo de vida (TTL) | `RESOURCE_HOLDER` | `ResourceExtendedData` |
| `resource.expired` | Expira la reserva de un recurso por timeout | `RESOURCE_HOLDER` | `ResourceExpiredData` |
| `resource.updated` | Se actualizan metadatos o capacidad | `SHARED_RESOURCE` | `ResourceUpdatedData` |
| `resource.deleted` | Se elimina un recurso compartido | `SHARED_RESOURCE` | `ResourceDeletedData` |
| `resource.queued` | Solicitud entra en cola por falta de cupo | `RESOURCE_HOLDER` | `ResourceQueuedData` |
| `resource.take_failed` | Falla el intento de tomar un recurso | `SHARED_RESOURCE` | `ResourceTakeFailedData` |

### 🔒 Eventos DLS (`product: 'DLS'`)

| `eventType` | Descripción | Objeto Afectado (`objectType`) | Payload (`event.data`) |
|---|---|---|---|
| `lock.acquired` | Candado adquirido exitosamente | `DISTRIBUTED_LOCK` | `LockAcquiredData` |
| `lock.released` | Candado liberado | `DISTRIBUTED_LOCK` | `LockReleasedData` |
| `lock.acquire_failed` | Falló la adquisición del candado | `DISTRIBUTED_LOCK` | `LockAcquireFailedData` |
| `lock.deadlock_detected` | Se detectó interbloqueo y se eligió víctima | `DISTRIBUTED_LOCK` | `DeadlockDetectedData` |
| `lock.abandoned` | Candado abandonado por inactividad | `DISTRIBUTED_LOCK` | `LockAbandonedData` |
| `transaction.started` | Inicio de transacción de bloqueos | `DISTRIBUTED_LOCK_TRANSACTION` | `TransactionStartedData` |
| `transaction.completed` | Transacción completada con éxito | `DISTRIBUTED_LOCK_TRANSACTION` | `TransactionCompletedData` |
| `transaction.aborted` | Transacción abortada | `DISTRIBUTED_LOCK_TRANSACTION` | `TransactionAbortedData` |
| `transaction.renewed` | Transacción renovada | `DISTRIBUTED_LOCK_TRANSACTION` | `TransactionRenewedData` |
| `transaction.expired` | Transacción expirada por timeout | `DISTRIBUTED_LOCK_TRANSACTION` | `TransactionExpiredData` |

