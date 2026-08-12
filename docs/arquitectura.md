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

## Cómo se resuelve la configuración

Dos opciones se pueden dar por variable de entorno: `CAERUS_ENDPOINT` y `CAERUS_TLS`. La
precedencia es siempre la misma, **lo explícito le gana al entorno**:

| | explícito | si no, el entorno | si tampoco |
|---|---|---|---|
| `endpoint` | `{ endpoint }` | `CAERUS_ENDPOINT` | **falla al construir** |
| `tls` | `{ tls }` | `CAERUS_TLS` | `true` |
| `apiKey` | `{ apiKey }` | — | falla al construir |

La API Key **no** se lee del entorno. Es una credencial, y hacer que el SDK la levante
sola de `process.env` invita a que aparezca en lugares donde nadie la puso a propósito.

### No hay ningún endpoint horneado

Si no viene ni por opción ni por variable, el cliente **falla al construirse** con un
mensaje que dice las dos formas de darlo. Es deliberado, y ya se probó al revés: hubo
brevemente un default apuntando a `api.caerus.dev:443`, un servicio que no existe, y el
efecto es que `new CaerusClient({ apiKey })` falla con un error de conexión que no
sugiere en ningún momento que la dirección nunca fue real.

Un default solo tiene sentido apuntando a algo verificado, y agregarlo después no rompe
a nadie.

### `CAERUS_TLS` solo puede apagar el cifrado a propósito

Únicamente `false` o `0` —sin distinguir mayúsculas, tolerando espacios— desactivan TLS.
Cualquier otra cosa lo deja prendido: `TRUE`, `yes`, vacío, un error de tipeo.

Parece pedante hasta que se mira la asimetría. Dejar TLS prendido sin querer falla fuerte
y al instante, con un error de OpenSSL imposible de pasar por alto. Apagarlo sin querer
no dice absolutamente nada, y la API Key —que viaja en cada llamada— sale en texto plano.
Una condición escrita como `=== 'true'` hace que quien escribe `CAERUS_TLS=TRUE` para
*encender* el cifrado lo apague. Eso estuvo en el código y se corrigió.

### Por qué la lista es corta

Cada nombre de variable que el SDK aprende a leer pasa a ser API pública: renombrarla
después le rompe la configuración a todo el mundo. Y una variable suelta en un CI cambia
el comportamiento sin que nadie lo haya escrito en ningún archivo.

Por eso son dos y no diez. Todo lo demás se pasa explícitamente.

## Lo que se genera y no se commitea

`src/generated/` y `src/version.ts` se producen antes de cada build y de cada corrida de
tests, y están en el `.gitignore`.

El motivo es el mismo en los dos casos: una sola fuente de verdad. El cliente sale del
`.proto`; la versión sale del `package.json`. Si estuvieran commiteados podrían decir
algo distinto de su origen, y nadie se enteraría hasta que fuera tarde.
