# Cómo está armado el SDK

## El recorrido de una llamada

```
  tu codigo
      │
      ▼
  CaerusClient          ── la implementacion publica
      │
      ▼
  internal/handles      ── unitary() y pooled(), que solo restringen que se puede pedir
      │
      ▼
  internal/transport    ── la conexion gRPC: API Key, deadline, credenciales
      │
      ▼
  internal/mapping      ── traduce entre los tipos generados y los del dominio
      │
      ▼
  generated/            ── producido del .proto; nadie de afuera lo ve
      │
      ▼
  el motor, por gRPC
```

En sentido inverso, los errores de gRPC pasan por `errors.ts`, que los convierte en la
jerarquía de `CaerusError`. Está contado en [errores.md](errores.md).

## Por qué los tipos generados no se exportan

ts-proto produce tipos correctos y feos. Tienen la forma que les impone protobuf:
opcionalidad donde el dominio no la tiene, `Long` donde debería ir un número, campos con
nombres de cable.

Si el SDK exportara esos tipos, el formato de cable pasaría a ser parte del contrato con
los usuarios. Cambiar un campo del `.proto` rompería a todo el mundo aunque el dominio
no hubiera cambiado en nada.

Por eso hay una capa de traducción en `internal/mapping.ts`, y por eso `npm run build`
corre `scripts/check-public-api.mjs`, que lee el `.d.ts` construido y falla si algún
tipo generado se filtró. Es una regla que se hace cumplir sola en vez de depender de que
alguien se acuerde.

## Por qué la API es tan poco idiomática de TypeScript

En TypeScript, lo natural sería un solo método:

```typescript
create(templateName, key, availableAmount?)   // no es lo que hace el SDK
take(amount?)                                  // tampoco
```

No está así porque vienen SDKs en Java, Go y Python, y la idea es que se parezcan lo
suficiente como para que alguien que aprendió uno pueda leer otro. El que más restringe
es Go: no tiene sobrecarga de métodos ni argumentos opcionales.

Entonces la regla es: **solo se usan construcciones que existen en los cuatro
lenguajes.** De ahí salen `createUnitary` / `createMultiple` y `take` / `takeMany`. Las
opciones van en un objeto al final, que en Go se traduce a una struct de opciones.

## Los dos clientes

`CaerusClient` y `InMemoryCaerusClient` implementan la misma interfaz,
`SharedResourceApi`.

```typescript
function inscribir(caerus: SharedResourceApi, cursoId: string) { ... }

inscribir(new CaerusClient({ endpoint, apiKey }), c);   // produccion
inscribir(new InMemoryCaerusClient({ ... }), c);        // tests
```

El de memoria no es un stub que devuelve constantes: mantiene stock, respeta el ciclo de
vida de los holders, valida idempotencia y tira los mismos errores. La idea es que un
test que pasa contra el mock signifique algo.

Lo que **no** hace: no vence holders por su cuenta y no simula latencia ni fallas de
red. Si necesitás probar el vencimiento o un timeout, hacelo contra un motor real.

## El transporte

`internal/transport.ts` es lo único que sabe de gRPC.

- **La API Key** va en el header `Authorization: Bearer <key>` en cada llamada.
- **TLS está prendido por defecto.** Un motor local escucha en texto plano, así que
  desarrollando hay que pasar `tls: false`. El default es el seguro a propósito: quien
  se olvida de configurarlo termina con la conexión cifrada, no con la contraria.
- **Cada llamada lleva un deadline**, `DEFAULT_TIMEOUT_MS` salvo que se configure otro.
  Si vence, sale un `TimeoutError` y **no se sabe si el servidor llegó a hacer el
  trabajo**. Es exactamente el caso para el que existen las claves de idempotencia.
- **No hay reintentos.** Ni acá ni en ningún lado del SDK.

`close()` suelta la conexión. En un proceso de vida corta conviene llamarlo; si no, el
proceso puede quedar colgado esperando que el socket se cierre.

## El SDK no lee variables de entorno

No hay un endpoint por defecto horneado adentro, y el SDK tampoco mira `process.env`.
Todo lo que necesita se lo pasás vos:

```typescript
const caerus = new CaerusClient({
  endpoint: process.env.CAERUS_GRPC_URL,
  apiKey: process.env.CAERUS_API_KEY,
  tls: process.env.CAERUS_TLS !== 'false',
});
```

Es una línea más y vale la pena por tres razones. Los nombres de las variables pasarían
a ser API pública, y no se podrían renombrar sin romperle la configuración a todo el
mundo. Una variable suelta en un CI cambiaría el comportamiento de los tests sin que
nadie lo haya escrito en ningún lado. Y las convenciones de entorno difieren entre
lenguajes, mientras que la idea es que los cuatro SDKs se parezcan.

Que la configuración venga del entorno está bien; que la lea el SDK a tus espaldas, no.

## Lo que se genera y no se commitea

`src/generated/` y `src/version.ts` se producen antes de cada build y de cada corrida de
tests, y están en el `.gitignore`.

El motivo es el mismo en los dos casos: una sola fuente de verdad. El cliente sale del
`.proto`; la versión sale del `package.json`. Si estuvieran commiteados podrían decir
algo distinto de su origen, y nadie se enteraría hasta que fuera tarde.
