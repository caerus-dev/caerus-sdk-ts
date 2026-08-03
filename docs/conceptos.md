# Los conceptos de Caerus

Caerus resuelve un problema viejo: varias personas queriendo lo mismo al mismo tiempo,
cuando hay menos de lo que se pide. Butacas de un cine, cupos de un curso, unidades de
stock. La parte difícil no es restar uno; es restar uno sin que dos restas simultáneas
terminen entregando la misma butaca dos veces.

## Plantilla y recurso

Son dos cosas distintas y se confunden seguido.

Una **plantilla** define cómo se comportan los recursos de una clase: cuánto dura una
reserva antes de vencer, si exige clave de idempotencia, si acepta metadata, qué pasa
cuando hay conflicto. Las crea el equipo dueño de la aplicación desde el dashboard.

Un **recurso** es una cosa concreta que se puede tomar: la butaca J12 de la función de
las 22, el curso de Análisis Matemático II comisión 3. Se crea desde el SDK, con
`createUnitary` o `createMultiple`, nombrando la plantilla que lo rige.

```typescript
await caerus.createUnitary('butaca', 'funcion-882-J12');
await caerus.createMultiple('curso', 'analisis-2-com-3', 40);
```

El SDK **no puede crear plantillas**. Solo recursos.

## Unitario y con cupo

Un recurso **unitario** tiene exactamente una unidad. Una butaca numerada. No tiene
sentido pedir tres.

Un recurso **con cupo** tiene varias unidades intercambiables. Cuarenta vacantes: no
importa cuál te toca.

El SDK hace que esa diferencia sea de tipos, no de convención:

```typescript
caerus.unitary('funcion-882-J12').take();        // ✓
caerus.unitary('funcion-882-J12').takeMany(3);   // ✗ no compila

caerus.pooled('analisis-2-com-3').takeMany(3);   // ✓
```

`unitary()` y `pooled()` no consultan nada. Declaran lo que ya sabés que el recurso es,
para que el compilador te lo haga cumplir donde efectivamente se reserva.

Si te equivocás y llamás `unitary()` sobre un recurso con cupo, el error no lo da el
SDK: lo da el motor, que valida contra la plantilla.

## El ciclo de vida de una reserva

Lo que devuelve `take` es un **holder**: el comprobante de que unas unidades quedaron
apartadas a tu nombre.

```
                    ┌──────────────┐
     take   ───────▶│   PENDING    │
                    └──────┬───────┘
                           │
          confirm  ────────┼────────▶  CONFIRMED   (las unidades quedan tomadas)
          release  ────────┼────────▶  RELEASED    (vuelven al stock)
       se vence   ────────┴────────▶  RELEASED    (vuelven solas)
```

Un holder nace **PENDING** con un vencimiento. Ese vencimiento es la red de seguridad:
si el usuario abandona el checkout, si el proceso se cae, si nadie hace nada, las
unidades vuelven al stock sin que nadie tenga que acordarse de devolverlas.

`extend` corre el vencimiento, en milisegundos. Sirve mientras el usuario sigue
completando el pago.

`confirm` lo cierra: las unidades quedan tomadas para siempre y el vencimiento deja de
importar.

`release` las devuelve antes de tiempo.

En el estado `QUEUED` no entramos acá: aparece solo con plantillas configuradas con la
estrategia de conflicto `QUEUE`, que a la fecha sigue en desarrollo del lado del motor.

## Idempotencia

Una red no confiable te deja en la peor situación posible: mandaste un `take`, no llegó
respuesta, y no sabés si el servidor lo procesó. Reintentar puede reservar dos veces.

La clave de idempotencia lo resuelve. Mandás la misma clave, y el motor devuelve el
holder que ya había creado en vez de crear otro.

```typescript
const holder = await caerus.pooled('analisis-2-com-3').takeMany(1, {
  idempotencyKey: `inscripcion-${alumnoId}-${cursoId}`,
});
```

**Algunas plantillas la exigen.** Si la plantilla tiene `useIdempotency` prendido y no
mandás clave, el motor rechaza la llamada con un `ValidationError` que dice
`Idempotency key is required by this template configuration`.

Y como el SDK nunca reintenta por su cuenta, la clave de idempotencia es la única forma
segura de reintentar vos.

## Grupos

Un recurso puede llevar un `groupKey` que lo ata a otros: todas las butacas de una
función, todas las comisiones de una materia.

```typescript
await caerus.createUnitary('butaca', 'funcion-882-J12', { groupKey: 'funcion-882' });
const page = await caerus.getResourcesByGroup('funcion-882');
```

**Ojo con esta consulta: es eventualmente consistente y las otras no.**

`getResource` le pregunta al motor, que responde desde Redis y está siempre al día.
`getResourcesByGroup` va derecho a PostgreSQL, que se sincroniza de forma asincrónica.
Un recurso recién creado puede tardar un momento en aparecer en la consulta por grupo.

No es un defecto, es cómo está construido el motor: Redis responde, PostgreSQL se pone
al día después. Pero si escribís un test que crea un recurso y acto seguido lo busca por
grupo, te va a fallar de manera intermitente. Reintentá con un límite de tiempo.

## Metadata

Tanto los recursos como los holders pueden llevar metadata: un objeto libre que Caerus
guarda y devuelve sin interpretar. Sirve para el id de pago, el del carrito, lo que
necesites correlacionar.

La plantilla puede tener la metadata **deshabilitada**. Si mandás metadata a una
plantilla que no la acepta, el motor rechaza la llamada.
