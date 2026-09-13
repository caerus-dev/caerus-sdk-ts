# @caerus-dev/sdk

> 🌐 [Read in English](README.en.md)

El cliente oficial de Caerus para Node.js. Reserva stock limitado (asientos, cupos, turnos, inventario) y coordina locks distribuidos sin escribir la lógica de concurrencia que evita que dos clientes compren o modifiquen lo mismo al mismo tiempo.

```typescript
const holder = await caerus.unitary('butaca_A12').take();
await chargeCard(4500);
await caerus.confirm(holder.id);
```

El recurso se retiene mientras se procesa el pago y queda confirmado definitivamente una vez liquidado. Si algo falla, `release` lo devuelve inmediatamente a la venta; y si tu proceso se cae antes de liberarlo, la retención expira automáticamente por TTL.

---

## Qué problema resuelve

Vender o asignar recursos únicos concurrentemente es más difícil de lo que parece. Dos usuarios hacen clic en *comprar* en el mismo milisegundo; una pasarela de pago tarda ocho segundos; un tercer cliente abandona la página con la butaca retenida. Resolver esto correctamente requiere locks distribuidos, expiraciones atómicas y workers de fondo para limpiar lo abandonado.

Caerus es esa infraestructura provista como servicio. Este paquete es la forma en que tu aplicación se comunica con ella.

**Corre en tu servidor.** La API Key autentica cada llamada e identifica tu entorno (Environment), por lo que nunca debe exponerse en un cliente o navegador web.

---

## Instalación

```bash
npm install @caerus-dev/sdk
```

Requiere Node 20 o superior. Incluye tipos completos de TypeScript; también funciona con JavaScript puro.

---

## Conexión

```typescript
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  apiKey: process.env.CAERUS_API_KEY!,
});
```

Esa es toda la configuración necesaria. La API Key identifica tu entorno, por lo que el cliente ya sabe adónde conectarse (el mismo patrón que un cliente de S3 o Stripe).

### Apuntar a otro entorno

Solo necesitas especificar `endpoint` cuando el motor no sea el servicio cloud alojado (por ejemplo, un Caerus desplegado por vos o corriendo localmente en Docker):

```typescript
const caerus = new CaerusClient({
  endpoint: 'localhost:9090',
  apiKey: process.env.CAERUS_API_KEY!,
  tls: false, // un motor local escucha en texto plano
});
```

La variable de entorno `CAERUS_ENDPOINT` hace lo mismo sin tocar código, lo cual es la forma habitual de apuntar suites de tests a un motor local. El orden de prioridad es: **explícito en código, luego variable de entorno, y finalmente la dirección cloud por defecto**.

#### Formato de `endpoint`

**Un host y un puerto, separados por dos puntos (`host:port`). Nada más.**

```text
engine.tu-caerus.com:9090     ✓
localhost:9090                ✓  motor local

https://engine.tu-caerus.com  ✗  sin esquema http/https
engine.tu-caerus.com          ✗  falta el puerto
localhost:9090/sre            ✗  sin rutas de URL
```

Caerus habla gRPC binario sobre HTTP/2, no HTTP REST tradicional.

**Un motor local escucha en texto plano**, así que debes acompañarlo con `tls: false`. Si lo olvidas, OpenSSL fallará con un mensaje críptico sobre versión incorrecta.

| Opción | Por defecto | Descripción |
|---|---|---|
| `apiKey` | — | Obtenida del Dashboard de Caerus. Requerida. Identifica tu entorno |
| `endpoint` | Servidor cloud | `host:port` del motor. `CAERUS_ENDPOINT` hace lo mismo |
| `tls` | `true` | Cifra la conexión TLS. Desactivar solo contra motores locales (`CAERUS_TLS=false`). Solo `false` o `0` lo desactivan |
| `timeoutMs` | `10000` | Deadline por defecto para cada llamada gRPC |
| `logger` | `console.error` | Logger para advertencias y diagnósticos del SDK |

> 💡 **Crea una sola instancia del cliente y reutilízala.** El cliente mantiene un pool de conexiones gRPC HTTP/2 compartido; recrearlo en cada request degrada el rendimiento.

```typescript
caerus.close(); // Al apagar tu servidor (Node no se cerrará mientras haya conexiones gRPC abiertas)
```

---

## Ejemplo completo (SRE)

Cuatro butacas a la venta, una de ellas comprada:

```typescript
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  apiKey: process.env.CAERUS_API_KEY!,
});

// 1. Al salir a la venta. "butacas" es una plantilla creada previamente en el dashboard.
for (const numero of [1, 2, 3, 4]) {
  await caerus.createUnitary('butacas', `butaca_A${numero}`, { groupKey: 'fila_A' });
}

// 2. Cada vez que alguien compra.
const holder = await caerus.unitary('butaca_A1').take({ ttlSeconds: 120 });

try {
  const { paymentId } = await cobrarTarjeta(4500);
  await caerus.confirm(holder.id, { metadata: { paymentId } });
} catch (error) {
  await caerus.release(holder.id); // Inmediatamente devuelta al stock
  throw error;
}

// butaca_A1 ahora está confirmada y fuera del mercado.
const fila = await caerus.getResourcesByGroup('fila_A');
console.log(fila.resources.filter((b) => b.availableAmount > 0).length); // 3
```

> ⚠️ **Libera siempre en cualquier ruta de cancelación o error.** De lo contrario, el recurso permanecerá retenido hasta que su TTL expire (lo cual es seguro, pero impide ventas durante esos minutos).

---

## Métodos de SRE (Shared Resource Engine)

### Reservas: `unitary` y `pooled`

Las reservas se solicitan a través de un handle tipado:

```typescript
const butaca = caerus.unitary('butaca_A12'); // Recursos únicos (capacidad: 1)
await butaca.take(opciones?);

const stock = caerus.pooled('entradas_campo'); // Recursos con cupo múltiple
await stock.take(opciones?);
await stock.takeMany(4, opciones?);
```

* **`unitary` no tiene `takeMany`:** Pedir 3 unidades de una butaca numerada específica ni siquiera compila en TypeScript.
* Crear un handle no hace ninguna llamada de red; solo fija el tipo en tu código.

### Gestión de Holders (Retenciones)

```typescript
confirm(resourceHolderId, opciones?)   // Liquida la reserva: las unidades quedan tomadas en firme
release(resourceHolderId)             // Cancela la retención y devuelve el stock al instante
extend(resourceHolderId, extraMs)     // Extiende el tiempo de expiración
getResourceHolder(resourceHolderId)   // Lee el estado actual de la reserva
```

Opciones para `take` y `takeMany`:

| Campo | Descripción |
|---|---|
| `idempotencyKey` | Enviar la misma clave dos veces devuelve el holder original en lugar de tomar stock adicional |
| `ttlSeconds` | Sobrescribe el tiempo de retención configurado en la plantilla |
| `metadata` | Objeto JSON con datos propios que viajan y se auditan junto al holder |

> ⚠️ **`extend` recibe milisegundos, `ttlSeconds` recibe segundos.** Esta diferencia proviene del contrato gRPC del motor y se traslada de forma transparente.

#### Estructura de un Holder

```typescript
{
  id: 'hld_...',
  resourceId: 'res_...',
  status: 'PENDING',
  amount: 1,
  expiresAt: Date,                   // Objeto Date real de JavaScript
  metadata: { pedidoId: 'ord_123' }, // Objeto parseado, no un string crudo
  createdAt: Date,
}
```

#### Estados posibles de un Holder

| Estado | Significado |
|---|---|
| `PENDING` | Retenido temporalmente esperando confirmación o liberación |
| `CONFIRMED` | Confirmado definitivamente. El stock ya fue descontado en firme |
| `RELEASED` | Liberado explícitamente y devuelto al stock disponible |
| `QUEUED` | Sin stock inmediato; la solicitud entró en cola FIFO de espera |
| `EXPIRED` | El tiempo de retención venció sin confirmarse; el stock se liberó automáticamente |

---

## Distributed Locking (DLS)

El motor **DLS** coordina tareas de background, acceso a archivos y sincronización entre workers distribuidos con exclusión mutua (`EXCLUSIVE`), lecturas compartidas (`SHARED_READ`), tokens de fencing (`czxid`) y **detección automática de deadlocks**.

```typescript
import { Dls } from '@caerus-dev/sdk';

const dls = new Dls.DlsClient({
  apiKey: process.env.CAERUS_API_KEY!,
});

// withTransaction orquesta la adquisición, el heartbeat de renovación y la liberación en finally:
await dls.withTransaction(async (tx) => {
  const lock = await tx.acquireLock('task_processing', 'file:reports_export', 'EXCLUSIVE', {
    onQueued: () => console.log('El lock está ocupado; esperando en cola de ZooKeeper...'),
  });

  console.log(`Lock concedido con fencing token #${lock.fencingToken}`);
  // Ejecutar sección crítica de forma exclusiva...
});
```

### Capacidades principales de DLS

* **`withTransaction(callback, options?)`**: Inicia un contexto transaccional, envía latidos periódicos de renovación (`autoRenew`) y garantiza la liberación atómica de todos los locks al finalizar, fallar o ser abortado.
* **`acquireLock(namespace, lockKey, mode, options?)`**: Soporta modos `EXCLUSIVE` y `SHARED_READ`. El callback opcional `onQueued` notifica en tiempo real cuando la petición queda esperando en cola.
* **Tokens de Fencing Monótonos (`fencingToken`)**: Cada lock concedido devuelve un contador monótonamente creciente (`czxid` de ZooKeeper) para prevenir escrituras de *workers zombies* en almacenamientos externos (según el patrón de Martin Kleppmann).
* **Resolución Automática de Deadlocks**: Si dos workers caen en una espera circular cruzada, el detector DFS del backend aborta determinísticamente a la víctima con `DeadlockAbortedError`, liberando sus locks para que el ganador continúe de inmediato.

---

## Webhooks

Permite verificar y procesar notificaciones asíncronas de eventos emitidos por Caerus de forma criptográficamente segura.

Los payloads (`CaerusEvent`) utilizan uniones discriminadas exhaustivas de TypeScript según el campo `eventType`. El SDK se integra de forma transparente con tu framework HTTP preferido (Express, Fastify, Next.js, etc.).

> [!IMPORTANT]
> Debes pasar siempre el cuerpo crudo del request (`Buffer` o `string` sin parsear). Si parseas el JSON antes de verificar la firma, los bytes cambiarán y la validación HMAC fallará.

### Ejemplo con Express

```typescript
import express from 'express';
import { CaerusClient, CaerusSignatureError, CaerusWebhookExpiredError } from '@caerus-dev/sdk';

const app = express();
const caerus = new CaerusClient({ apiKey: process.env.CAERUS_API_KEY! });

// Parser crudo necesario para la verificación criptográfica
app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['caerus-signature'] as string;
  const secret = process.env.CAERUS_WEBHOOK_SECRET!;

  let event;
  try {
    event = caerus.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    if (err instanceof CaerusSignatureError || err instanceof CaerusWebhookExpiredError) {
      return res.status(400).send(`Firma inválida: ${err.message}`);
    }
    return res.status(400).send(`Error: ${(err as Error).message}`);
  }

  // Tipado exhaustivo según eventType:
  switch (event.eventType) {
    case 'resource.taken':
      console.log(`Recurso tomado -> Holder ID: ${event.data.holderId}`);
      break;

    case 'lock.deadlock_detected':
      console.log(`Víctima de deadlock seleccionada: ${event.data.victimTransactionId}`);
      console.log(`Ciclo detectado:`, event.data.cycleTransactionIds);
      break;

    default:
      console.log(`Evento recibido: ${event.eventType}`);
  }

  res.json({ received: true });
});
```

---

## Manejo de Errores

Todos los errores del paquete extienden de `CaerusError`, por lo que un único bloque `catch` puede capturarlos juntos:

```typescript
try {
  await caerus.unitary('butaca_A12').take({ idempotencyKey: clave });
} catch (error) {
  if (error instanceof OutOfStockError) return 'Alguien reservó la butaca un instante antes';
  if (error instanceof HolderNotActiveError) return 'Tu reserva venció; inicia el proceso de nuevo';
  if (error instanceof DeadlockAbortedError) return 'Transacción abortada por deadlock';
  throw error;
}
```

### Mapeo de Códigos y Clases de Error

| Clase de Error | Código (`code`) | Causa / Cuándo ocurre |
|---|---|---|
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | El recurso, plantilla o holder no existen |
| `OutOfStockError` | `CONFLICT` | No quedan unidades libres suficientes |
| `HolderNotActiveError` | `CONFLICT` | El holder ya expiró, fue liberado o confirmado |
| `ResourceHasActiveHoldsError` | `CONFLICT` | No se puede eliminar: tiene reservas activas |
| `ResourceHasQueuedRequestsError`| `CONFLICT` | No se puede eliminar: tiene solicitudes en cola |
| `DeadlockAbortedError` | `CONFLICT` | Transacción abortada como víctima de un deadlock |
| `TransactionNotActiveError` | `CONFLICT` | Transacción expirada, cancelada o inexistente |
| `LockAlreadyHeldError` | `CONFLICT` | La transacción ya posee ese lock de forma exclusiva |
| `LockModeMismatchError` | `VALIDATION` | Modo de lock incompatible con la plantilla |
| `ValidationError` | `VALIDATION` | Solicitud mal formada o falta clave de idempotencia |
| `AuthenticationError` | `AUTHENTICATION` | API Key ausente, revocada o desconocida |
| `TimeoutError` | `TIMEOUT` | La llamada superó el deadline configurado |
| `CaerusError` | `UNKNOWN` | Cualquier otro error interno del servidor |

Cada error incluye además la propiedad tipada `error.reason` con el código canónico del backend (ej: `"OUT_OF_STOCK"`, `"DEADLOCK_DETECTED"`), ideal para estructurar lógica programática mediante la unión de tipos `CaerusErrorReason`.

---

## Testing sin Caerus (`InMemoryClient`)

El SDK provee clientes en memoria tanto para SRE (`InMemoryCaerusClient`) como para DLS (`InMemoryDlsClient`) que implementan las mismas interfaces que los clientes reales:

```typescript
import { InMemoryCaerusClient, type SharedResourceApi } from '@caerus-dev/sdk';

async function comprarEntrada(caerus: SharedResourceApi, butaca: string) {
  const holder = await caerus.unitary(butaca).take();
  await cobrarTarjeta(4500);
  await caerus.confirm(holder.id);
}

const caerusMock = new InMemoryCaerusClient({
  resources: [{ key: 'butaca_A12', availableAmount: 1 }],
});

await comprarEntrada(caerusMock, 'butaca_A12');

// Control explícito del tiempo:
caerusMock.advanceTime(301); // Avanza 301 segundos
const h = await caerusMock.getResourceHolder('hld_...');
console.log(h?.status); // 'EXPIRED'
```

---

## Documentación adicional

La documentación en profundidad se encuentra en la carpeta [`docs/`](docs/):
* [`conceptos.md`](docs/conceptos.md): Modelo de plantillas, recursos, holders y ciclo de vida de inventario.
* [`arquitectura.md`](docs/arquitectura.md): Estructura interna del SDK y diseño de capas.
* [`errores.md`](docs/errores.md): Mapeo exhaustivo de errores y códigos de estado gRPC.
* [`webhooks.md`](docs/webhooks.md): Guía de integración de webhooks y seguridad de firmas.
* [`probar-contra-caerus-real.md`](docs/probar-contra-caerus-real.md): Cómo levantar Caerus en local y correr el SDK contra él.

---

## Licencia

MIT
