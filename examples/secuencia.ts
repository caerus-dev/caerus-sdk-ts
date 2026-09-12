import { Dls } from '../src/index.js';
import { execSync } from 'child_process';

const API_KEY_ID = '11111111-1111-1111-1111-111111111111';
const TEMPLATE_ID = '33333333-3333-3333-3333-333333333333';

function ejecutarSql(sql: string, descripcion: string) {
  console.log(`\n[DB] ${descripcion}...`);
  try {
    execSync('docker exec -i postgres-dev-common psql -U admin -d caerus_data_plane', {
      input: sql,
      stdio: ['pipe', 'ignore', 'pipe'] // Ignoramos stdout puro, guardamos stderr para errores
    });
    console.log('[DB] Listo.');
  } catch (err: any) {
    console.error(`[DB ERROR] Falló al ejecutar SQL: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
  }
}

function inyectarDatosPrueba() {
  const sql = `
    INSERT INTO api_keys (id, environment_id, key_hash, key_prefix, state)
    VALUES (
        '${API_KEY_ID}', 
        '22222222-2222-2222-2222-222222222222', 
        'ca6f2e39b2ff141859b18bb5283aadd5093c8ede2869f3656231a054e54bfc22', 
        'demo', 
        'ACTIVE'
    ) ON CONFLICT DO NOTHING;

    INSERT INTO distributed_lock_templates (
        id, environment_id, namespace, description, lock_type, 
        conflict_resolution, retry_interval_ms, max_retry_count, 
        fencing_token_required, deadlock_resolution_strategy, is_active
    ) VALUES (
        '${TEMPLATE_ID}',
        '22222222-2222-2222-2222-222222222222',
        'inventario',
        'Plantilla de prueba',
        'EXCLUSIVE',
        'QUEUE',
        500,
        3,
        false,
        'KILL_PRIORITY',
        true
    ) ON CONFLICT DO NOTHING;
  `;
  ejecutarSql(sql, 'Inyectando API Key temporal y plantilla DLS');
}

function limpiarDatosPrueba() {
  const sql = `
    DELETE FROM distributed_lock_templates WHERE id = '${TEMPLATE_ID}';
    DELETE FROM api_keys WHERE id = '${API_KEY_ID}';
  `;
  ejecutarSql(sql, 'Eliminando API Key temporal y plantilla DLS de la base de datos');
}


async function probarCicloDeVidaDls() {
  // 0. Preparar la BD
  inyectarDatosPrueba();

  // 1. Inicializamos el cliente real
  const client = new Dls.DlsClient({
    endpoint: 'localhost:9090',
    apiKey: 'demo-api-key',
    tls: false,
  });

  try {
    console.log('\n--- Iniciando Prueba Secuencial DLS ---');

    console.log('\n[1] beginTransaction()');
    const tx = await client.beginTransaction({ timeoutMs: 15000 });
    console.log(`Transacción iniciada: ${tx.transactionId}`);

    console.log('\n[2] acquireLock()');
    const lock = await client.acquireLock('inventario', 'item-123', tx.transactionId, 'EXCLUSIVE');
    console.log(`Lock adquirido. Status: ${lock.status}, ID: ${lock.lockId}`);

    if (lock.status !== 'ACQUIRED') {
      console.log('El lock no pudo ser adquirido. Abortando secuencia.');
      return;
    }

    console.log('\n[3] getLockStatus()');
    const lockStatus = await client.getLockStatus('inventario', 'item-123');
    console.log(`¿Está ocupado?: ${lockStatus.isHeld}`);

    console.log('\n[4] getTransactionStatus()');
    const txStatus = await client.getTransactionStatus(tx.transactionId);
    console.log(`Estado de Transacción: ${txStatus.status}`);

    console.log('\n[5] renewTransaction()');
    await client.renewTransaction(tx.transactionId, 5000);
    console.log(`Transacción renovada exitosamente.`);

    console.log('\n[6] releaseLock()');
    await client.releaseLock(lock.lockId, tx.transactionId);
    console.log(`Lock específico liberado.`);

    // Volvemos a tomar otro lock para probar el release global
    await client.acquireLock('inventario', 'item-999', tx.transactionId, 'EXCLUSIVE');

    console.log('\n[7] releaseTransactionLocks()');
    await client.releaseTransactionLocks(tx.transactionId);
    console.log(`Todos los locks de la transacción fueron liberados.`);

    console.log('\n--- Secuencia Finalizada con Éxito ---');

  } catch (error: any) {
    console.error('\n[ERROR] Hubo una falla en la secuencia:', error.message);
  } finally {
    client.close();
    // 8. Limpiar la BD
    limpiarDatosPrueba();
  }
}

// Ejecutar
probarCicloDeVidaDls();