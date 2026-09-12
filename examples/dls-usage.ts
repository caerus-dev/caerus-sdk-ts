import { Dls } from '../src/index.js';

async function runDlsExample() {
  const client = new Dls.DlsClient({
    endpoint: 'localhost:9090',
    apiKey: process.env.CAERUS_API_KEY || 'demo-api-key',
    tls: false,
  });

  console.log('--- DLS Lock Acquisition Example ---');
  let tx: Dls.Transaction | undefined;
  let lock: Dls.LockHolder | undefined;

  try {
    console.log('1. Beginning transaction...');
    tx = await client.beginTransaction({ timeoutMs: 5000 });
    console.log(`   Transaction ID: ${tx.transactionId}`);

    console.log('\n2. Acquiring EXCLUSIVE lock for "stock-update:item-123"...');
    lock = await client.acquireLock('stock-update', 'item-123', tx.transactionId, 'EXCLUSIVE', {
      idempotencyKey: `idemp-update-123-${Date.now()}`
    });

    console.log(`   Status: ${lock.status}`);
    console.log(`   Lock ID: ${lock.lockId}`);
    console.log(`   Fencing Token: ${lock.fencingToken}`);

    if (lock.status === 'ACQUIRED') {
      console.log('\n3. Lock acquired successfully. Performing critical section work...');
      // Simulate some work...
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('   Work complete.');
    } else {
      console.log('\n3. Lock was denied (possibly held by someone else).');
    }

  } catch (err) {
    if (err instanceof Dls.DlsError) {
      console.error(`DLS Error [${err.code}]:`, err.message);
    } else {
      console.error('Unexpected error:', err);
    }
  } finally {
    if (tx) {
      console.log('\n4. Releasing all locks associated with transaction...');
      try {
        await client.releaseTransactionLocks(tx.transactionId);
        console.log('   Locks released successfully.');
      } catch (err) {
        console.error('   Failed to release transaction locks:', err);
      }
    }

    client.close();
    console.log('--- Example finished ---');
  }
}

if (require.main === module) {
  runDlsExample().catch(console.error);
}
