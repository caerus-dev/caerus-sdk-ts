# Probar contra un Caerus real

Los 96 tests del repo no tocan la red: usan un motor gRPC falso. Alcanzan para casi
todo, pero hay una cosa que estructuralmente no pueden detectar: **que la copia del
`.proto` haya quedado vieja**. El build genera el cliente de lo que haya en `proto/` y
tipa contra eso, y pasa igual de contento contra un contrato de hace tres meses.

Lo único que agarra eso es correr el SDK contra un motor de verdad.

Esto necesita acceso al repo `caerus-dev/caerus-back`, que es privado.

> **Nada de lo que generes acá va a un repositorio.** Las claves, contraseñas y valores
> concretos salen de tu entorno local y se quedan ahí. Este documento explica cómo
> obtenerlos, no cuáles son.

---

## 1. Levantar la infraestructura

Desde el checkout de `caerus-back`:

```bash
docker compose up -d postgres-dev-common redis rabbitmq
```

Solo esos tres. El compose también define `control-plane-service` y
`data-plane-service`, pero levantarlos construye las imágenes con un build de Maven
adentro de Docker, que tarda mucho y no hace falta: el data plane conviene correrlo
local.

Los nombres de contenedor, el usuario y la contraseña de la base salen de ese mismo
`docker-compose.yml`. Miralo ahí; no están repetidos acá a propósito.

## 2. Levantar el data plane

```bash
mvn spring-boot:run -pl data-plane-service
```

Queda escuchando gRPC en `localhost:9090`, en texto plano.

Dos cosas que muerden acá:

**Si el arranque falla con `Address already in use`,** quedó un proceso viejo con el
puerto tomado. En Windows:

```bash
Get-NetTCPConnection -LocalPort 9090 -State Listen
```

**Si el build falla con `invalid value for parameter "TimeZone"`,** la JVM está
reportando `America/Buenos_Aires`, que es un alias viejo que PostgreSQL 17 ya no
reconoce. Se arregla de una vez definiendo la variable de entorno de usuario
`JAVA_TOOL_OPTIONS=-Duser.timezone=America/Argentina/Buenos_Aires`. Va ahí y no en
`MAVEN_OPTS` porque surefire levanta su propia JVM.

## 3. Sembrar

**El data plane arranca con `ddl-auto: create`, así que borra y recrea el esquema en
cada arranque.** Todo lo que sembraste antes desaparece. Esto hay que rehacerlo cada vez
que lo reinicies.

En condiciones normales estas filas no se cargan por SQL: llegan por eventos de RabbitMQ
que publica el control plane. Esto es un atajo para no levantar el control plane entero.

### La API Key

Elegí una clave cualquiera para tu entorno local. **No reuses una de un ambiente real y
no la pongas en ningún archivo que vaya a git.**

Lo que guarda la base no es la clave sino su hash: SHA-256 en hexadecimal, sin sal, que
es lo que hace el `PasswordEncoder` del `shared-kernel`. No es BCrypt, así que el mismo
texto da siempre el mismo hash y lo podés calcular vos:

```bash
printf '%s' 'TU_CLAVE_LOCAL' | sha256sum
```

Con ese hash, y eligiendo un UUID cualquiera para el entorno:

```sql
INSERT INTO api_keys (id, environment_id, key_hash, key_prefix, state)
VALUES (
    '<uuid de la key>',
    '<uuid del entorno>',
    '<el hash que calculaste>',
    '<los primeros caracteres de la clave>',
    'ACTIVE'
);
```

El `key_prefix` es solo para mostrar en el dashboard; no participa de la autenticación.

### Las plantillas

Tienen que llevar **el mismo `environment_id`** que la API Key: el interceptor saca el
entorno de la clave y después filtra las plantillas por él.

```sql
-- Ojo: retry_inteval_sec va sin la "r". Esta asi en la entidad y por lo tanto en la
-- tabla. Si lo "corregis" al escribir el INSERT, falla.
INSERT INTO shared_resource_templates (
    id, name, default_ttl_sec, save_metadata, environment_id,
    retry_inteval_sec, max_retry_count, use_idempotency,
    conflict_resolution, type, is_active
) VALUES
    ('<uuid>', 'generales', 300, true, '<uuid del entorno>',
     NULL, NULL, true, 'FAIL', 'MULTIPLE', true),
    ('<uuid>', 'butaca', 300, true, '<uuid del entorno>',
     NULL, NULL, true, 'FAIL', 'UNITARY', true);
```

`conflict_resolution` acepta `FAIL`, `RETRY` o `QUEUE`. `FAIL` es el único que no
necesita configuración extra.

Corré el SQL con `docker exec -i <contenedor> psql -U <usuario> -d caerus_data_plane`,
usando los valores del compose.

## 4. Conectarse

La clave va por variable de entorno. **Nunca literal en el código**, ni siquiera en un
script de prueba que "no vas a commitear".

```typescript
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'localhost:9090',
  apiKey: process.env.CAERUS_API_KEY,
  tls: false,
});
```

**`tls: false` no es opcional acá.** El default del SDK es `true`, que es lo correcto
para producción, pero el motor local escucha en texto plano. Si te lo olvidás, el error
no dice nada útil:

```
SSL routines:ssl3_get_record:wrong version number
```

Eso es el cliente intentando TLS contra un socket en claro.

---

## Los tres tropezones

Son los que aparecieron la primera vez que se hizo esto, en orden.

**1. `wrong version number` de OpenSSL.** Falta `tls: false`. Ver arriba.

**2. `Idempotency key is required by this template configuration`.** Las plantillas de
arriba tienen `use_idempotency` en `true`, así que todo `take` necesita una
`idempotencyKey`. Y si estás probando que tomar dos veces falla, la segunda tiene que
llevar una clave **distinta**: con la misma, la idempotencia te devuelve el primer
holder y el test no prueba nada.

**3. `getResourcesByGroup` devuelve vacío justo después de crear el recurso.** No es un
defecto. `getResource` le pregunta al motor, que responde desde Redis; pero
`getResourcesByGroup` va derecho a PostgreSQL, que se sincroniza de forma asincrónica
por el write-behind. Un recurso recién creado tarda un momento en aparecer ahí.

Si lo estás verificando, reintentá con un límite de tiempo en vez de consultar una sola
vez.

---

## Verificar la persistencia

Que el motor te haya contestado bien no significa que haya quedado bien guardado: son
dos caminos distintos, Redis primero y PostgreSQL después. Vale la pena mirar.

```sql
SELECT r.resource_key, r.available_amount, r.pending_count, r.version AS ver_recurso,
       h.status, h.amount, h.version AS ver_holder
FROM shared_resources r
LEFT JOIN shared_resource_holders h ON h.resource_id = r.id
ORDER BY r.resource_key;
```

Las columnas `version` son las del bloqueo optimista. Que suban es señal de que hubo
escrituras concurrentes sobre la misma fila y que se resolvieron reintentando, que es lo
que tiene que pasar.
