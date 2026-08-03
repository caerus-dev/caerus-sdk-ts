# Instrucciones para agentes

Esto es `@caerus-dev/sdk`, el cliente de Node.js para el Shared Resource Engine de
Caerus. Habla gRPC contra el data plane.

Si vas a trabajar acá, leé esto entero antes de tocar nada. Lo que sigue no son
preferencias de estilo: son cosas que ya salieron mal una vez.

---

## Los comandos

```bash
npm install
npm test          # genera el cliente, tipa, y corre 96 tests
npm run build     # CJS, ESM y .d.ts
npm run generate  # solo regenera src/generated y src/version.ts
```

`npm test` y `npm run build` regeneran el cliente gRPC antes de correr. No hace falta
llamar a `generate` a mano.

Nada de `src/generated/` ni `src/version.ts` se commitea: se producen y ya. Si los ves
en un `git status`, algo se rompió en el `.gitignore`.

---

## ⚠️ Lo primero: el `.proto` es una copia

`proto/sre_service.proto` **no es el contrato**. El contrato vive en el repo
`caerus-dev/caerus-back`, en `data-plane-service`, que es de donde se compila el
servidor. Acá hay una copia porque aquel repo es privado y este es público.

**Consecuencia:** si alguien cambia el contrato del lado del servidor, este repo no se
entera. El build genera el cliente de lo que haya en `proto/` y tipa contra eso, y pasa
igual de contento contra un contrato viejo que contra uno actual.

Lo único que agarra el desfasaje es comparar los checksums o correr el SDK contra un
servidor real. `proto/README.md` explica las dos cosas.

**Si tocás `proto/sre_service.proto`, actualizá también la tabla de `proto/README.md`.**
Una tabla que dice una cosa mientras el archivo dice otra es peor que no tener tabla.

---

## Reglas que el build hace cumplir

**Nada generado del `.proto` puede llegar a la API pública.** `npm run build` corre
`scripts/check-public-api.mjs`, que revisa el `.d.ts` y falla si se filtró un tipo
generado. El motivo: esos tipos tienen la forma que les dio protobuf, no una que alguien
haya diseñado, y exportarlos convertiría el formato de cable en parte del contrato con
los usuarios. La traducción se hace en `src/internal/mapping.ts`.

**Los ejemplos de `examples/` se compilan.** Cambiás la API, te olvidás de un ejemplo, y
el build falla. Es documentación que no puede envejecer en silencio.

---

## Reglas que ningún build puede hacer cumplir

**La API pública tiene que existir en TypeScript, Java, Go y Python.** Vienen SDKs en
esos lenguajes y la idea es que se parezcan. En la práctica el que más restringe es Go:
no tiene sobrecarga de métodos. Por eso hay `createUnitary` y `createMultiple` en vez de
un `create` con firmas distintas, y `take` y `takeMany` en vez de un `take` con un
argumento opcional.

**Antes de cambiar la superficie pública, se propone al equipo.** No se cambia y después
se avisa. Esto salió de dos cambios que se empujaron presentándolos como arreglos cuando
eran decisiones de diseño, y hubo que revertir los dos.

Requiere propuesta previa: la API pública, el `.proto`, los códigos de error y su mapeo,
y cualquier cambio que altere el comportamiento observable de una operación que ya
existe. No la requiere: implementación interna, tests, documentación.

---

## Cómo está armado

```
src/
  index.ts       lo unico que es API publica; si no se exporta acá, no existe para afuera
  client.ts      CaerusClient: la implementacion contra un motor real
  mock.ts        InMemoryCaerusClient: la misma interfaz, en memoria, para tests
  api.ts         SharedResourceApi, la interfaz que implementan los dos
  types.ts       los tipos del dominio
  errors.ts      la jerarquia de errores y la traduccion desde gRPC
  options.ts     opciones del cliente y sus defaults
  internal/
    handles.ts   los manejadores unitary() y pooled()
    transport.ts la conexion gRPC, deadlines y la API Key
    mapping.ts   traduce entre los tipos generados y los del dominio
  generated/     producido del .proto — no se commitea, no se edita
```

Que `CaerusClient` y `InMemoryCaerusClient` implementen la misma interfaz es a
propósito: quien consume el SDK puede aceptar `SharedResourceApi` y recibir cualquiera
de los dos, y sus tests no necesitan un Caerus levantado.

Más detalle en [`docs/`](docs/).

---

## Estilo

Los mensajes de commit van en castellano, sin prefijos tipo `feat:` ni `fix:`, en
imperativo y explicando **por qué**, no qué. El diff ya dice qué.

Los comentarios en el código van en inglés y explican decisiones, no mecánica. Un
comentario que parafrasea la línea de abajo sobra; uno que dice por qué esa línea es así
y no de la otra manera obvia, no.

---

## Probar contra un Caerus real

Los 96 tests no tocan la red: usan un motor gRPC falso. Eso alcanza para casi todo,
pero **no puede detectar que la copia del `.proto` quedó vieja**.

Cuando el cambio lo amerite, corré el SDK contra un motor de verdad. El procedimiento
completo, con los tropezones ya documentados, está en
[`docs/probar-contra-caerus-real.md`](docs/probar-contra-caerus-real.md).
