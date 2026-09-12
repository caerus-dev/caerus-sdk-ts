import { Dls } from '../dist/index.mjs';

const endpoint = process.env.CAERUS_ENDPOINT ?? 'localhost:9090';
const apiKey = process.env.CAERUS_API_KEY;
const tls = process.env.CAERUS_TLS === 'true';

if (!apiKey) {
  console.error('Falta CAERUS_API_KEY. Ver la cabecera de este archivo.');
  process.exit(2);
}

const dls = new Dls.DlsClient({ apiKey, endpoint, tls });

const NS_FAIL = process.env.DLS_NS_FAIL ?? 'cuenta';
const NS_COLA = process.env.DLS_NS_QUEUE ?? 'cuenta_cola';
const NS_ALERTA = process.env.DLS_NS_ALERT ?? 'cuenta_alerta';
const NS_LECTURA = process.env.DLS_NS_READ_WRITE ?? 'archivo';

const uid = () => crypto.randomUUID();
const clave = (n) => `verif-${Date.now()}-${n}`;

let fallos = 0;
const comprobar = (nombre, condicion, detalle) => {
  if (!condicion) fallos += 1;
  console.log(`${condicion ? 'OK  ' : 'MAL '} ${nombre}${detalle ? ` | ${detalle}` : ''}`);
};

async function lecturaCompartida() {
  console.log('\n== lectura compartida y estado del lock');
  const archivo = clave('archivo');
  const [tx1, tx2, tx3] = await Promise.all([
    dls.beginTransaction({ timeoutMs: 20000 }),
    dls.beginTransaction({ timeoutMs: 20000 }),
    dls.beginTransaction({ timeoutMs: 20000 }),
  ]);

  try {
    const l1 = await dls.acquireLock(NS_LECTURA, archivo, tx1.transactionId, 'SHARED_READ');
    const l2 = await dls.acquireLock(NS_LECTURA, archivo, tx2.transactionId, 'SHARED_READ');
    comprobar('dos lectores entran a la vez', l1.status === 'ACQUIRED' && l2.status === 'ACQUIRED');

    const estado = await dls.getLockStatus(NS_LECTURA, archivo);
    comprobar('el estado dice SHARED_READ', estado.currentMode === 'SHARED_READ', String(estado.currentMode));
    comprobar('lista los dos holders', estado.activeHolders.length === 2, `${estado.activeHolders.length}`);

    const escritor = await dls
      .acquireLock(NS_LECTURA, archivo, tx3.transactionId, 'EXCLUSIVE', { timeoutMs: 4000 })
      .catch((e) => e);
    comprobar('el escritor no entra con lectores activos', escritor instanceof Error, escritor?.constructor?.name);

    await dls.releaseLock(l1.lockId, tx1.transactionId);
    const luego = await dls.getLockStatus(NS_LECTURA, archivo);
    comprobar('soltar un lector deja al otro', luego.activeHolders.length === 1, `${luego.activeHolders.length}`);
  } finally {
    for (const tx of [tx1, tx2, tx3]) {
      await dls.releaseTransactionLocks(tx.transactionId).catch(() => {});
    }
  }
}

async function lockDenegado() {
  console.log('\n== lock denegado en un namespace FAIL');
  const cuenta = clave('cuenta');

  await dls.withTransaction(async (tx1) => {
    const propio = await tx1.acquireLock(NS_FAIL, cuenta, 'EXCLUSIVE', { idempotencyKey: uid() });
    comprobar('el primero lo toma', propio.status === 'ACQUIRED');
    comprobar('viene con fencing token', typeof propio.fencingToken === 'number', String(propio.fencingToken));

    await dls.withTransaction(async (tx2) => {
      const error = await tx2
        .acquireLock(NS_FAIL, cuenta, 'EXCLUSIVE', { idempotencyKey: uid(), timeoutMs: 5000 })
        .catch((e) => e);
      comprobar('el segundo recibe una excepcion, no un valor', error instanceof Dls.LockDeniedError, error?.constructor?.name);
      comprobar('con el codigo LOCK_DENIED', error?.reason === 'LOCK_DENIED', String(error?.reason));
    }, { timeoutMs: 8000 });
  }, { timeoutMs: 15000 });
}

async function cicloDeDos() {
  console.log('\n== deadlock de dos, con estrategia KILL_PRIORITY');
  const x = clave('X');
  const y = clave('Y');
  const arranque = Date.now();

  const cruzado = (primero, segundo) =>
    dls.withTransaction(async (tx) => {
      await tx.acquireLock(NS_COLA, primero, 'EXCLUSIVE');
      await new Promise((r) => setTimeout(r, 300));
      return tx.acquireLock(NS_COLA, segundo, 'EXCLUSIVE', { timeoutMs: 30000 });
    }, { timeoutMs: 30000 });

  const resultados = await Promise.allSettled([cruzado(x, y), cruzado(y, x)]);
  const segundos = (Date.now() - arranque) / 1000;
  const victimas = resultados.filter((r) => r.status === 'rejected');

  comprobar('una victima y un ganador', victimas.length === 1, `${victimas.length} victimas`);
  comprobar('la victima sabe que fue un deadlock', victimas[0]?.reason instanceof Dls.DeadlockAbortedError, victimas[0]?.reason?.constructor?.name);
  comprobar('con el codigo DEADLOCK_DETECTED', victimas[0]?.reason?.reason === 'DEADLOCK_DETECTED');
  comprobar('se resuelve en menos de 10 segundos', segundos < 10, `${segundos.toFixed(1)}s`);
}

async function cicloDeTres() {
  console.log('\n== deadlock triangular');
  const [x, y, z] = [clave('TX'), clave('TY'), clave('TZ')];

  const paso = (primero, segundo) =>
    dls.withTransaction(async (tx) => {
      await tx.acquireLock(NS_COLA, primero, 'EXCLUSIVE');
      await new Promise((r) => setTimeout(r, 400));
      return tx.acquireLock(NS_COLA, segundo, 'EXCLUSIVE', { timeoutMs: 30000 });
    }, { timeoutMs: 30000 });

  const resultados = await Promise.allSettled([paso(x, y), paso(y, z), paso(z, x)]);
  const victimas = resultados.filter((r) => r.status === 'rejected');

  comprobar('se rompe el ciclo sin matar a todos', victimas.length >= 1 && victimas.length < 3, `${victimas.length} de 3`);
  comprobar('las victimas son por deadlock', victimas.every((v) => v.reason?.reason === 'DEADLOCK_DETECTED'));
}

async function estrategiaAlerta() {
  console.log('\n== deadlock con estrategia ALERT: no se aborta a nadie');
  const x = clave('LX');
  const y = clave('LY');

  const cruzado = (primero, segundo) =>
    dls.withTransaction(async (tx) => {
      await tx.acquireLock(NS_ALERTA, primero, 'EXCLUSIVE');
      await new Promise((r) => setTimeout(r, 300));
      return tx.acquireLock(NS_ALERTA, segundo, 'EXCLUSIVE', { timeoutMs: 6000 });
    }, { timeoutMs: 20000 });

  const resultados = await Promise.allSettled([cruzado(x, y), cruzado(y, x)]);
  const abortadas = resultados.filter((r) => r.status === 'rejected' && r.reason?.reason === 'DEADLOCK_DETECTED');

  comprobar('nadie fue abortado por deadlock', abortadas.length === 0, `${abortadas.length} abortadas`);
}

async function estadoDeTransaccion() {
  console.log('\n== estado de una transaccion con un lock en la cola');
  const k = clave('cola');
  const tx1 = await dls.beginTransaction({ timeoutMs: 20000 });
  const tx2 = await dls.beginTransaction({ timeoutMs: 20000 });

  try {
    await dls.acquireLock(NS_COLA, k, tx1.transactionId, 'EXCLUSIVE');
    let avisosDeCola = 0;
    let concedidoAntesDelAviso = false;
    const esperando = dls
      .acquireLock(NS_COLA, k, tx2.transactionId, 'EXCLUSIVE', {
        timeoutMs: 8000,
        onQueued: () => {
          avisosDeCola += 1;
        },
      })
      .then(
        () => {
          concedidoAntesDelAviso = avisosDeCola === 0;
        },
        () => {},
      );
    await new Promise((r) => setTimeout(r, 1500));

    const conLock = await dls.getTransactionStatus(tx1.transactionId).catch((e) => e);
    const enCola = await dls.getTransactionStatus(tx2.transactionId).catch((e) => e);

    comprobar('la que tiene el lock informa su estado', !(conLock instanceof Error), conLock?.status ?? conLock?.constructor?.name);
    comprobar('la que espera en la cola tambien', !(enCola instanceof Error), enCola?.status ?? enCola?.constructor?.name);

    await dls.releaseTransactionLocks(tx1.transactionId).catch(() => {});
    await esperando;

    comprobar('onQueued avisa una sola vez mientras espera', avisosDeCola === 1, `${avisosDeCola} avisos`);
    comprobar('y avisa antes de que se conceda', !concedidoAntesDelAviso);
  } finally {
    for (const tx of [tx1, tx2]) {
      await dls.releaseTransactionLocks(tx.transactionId).catch(() => {});
    }
  }
}

const pasos = [
  lecturaCompartida,
  lockDenegado,
  cicloDeDos,
  cicloDeTres,
  estrategiaAlerta,
  estadoDeTransaccion,
];

console.log(`verificando contra ${endpoint}`);
for (const paso of pasos) {
  try {
    await paso();
  } catch (error) {
    fallos += 1;
    console.log(`MAL  ${paso.name} corto por una excepcion | ${error?.constructor?.name}: ${error?.message}`);
  }
}

console.log(fallos === 0 ? '\ntodo en orden' : `\n${fallos} comprobaciones fallaron`);
process.exit(fallos === 0 ? 0 : 1);
