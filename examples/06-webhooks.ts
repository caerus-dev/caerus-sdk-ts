/**
 * Verifying and handling Caerus Webhooks.
 *
 * Webhooks notify your system about asynchronous events across Caerus (SRE reservations,
 * DLS locks, Control Plane updates). The SDK cryptographically validates the signature
 * header and parses the payload into strongly-typed Discriminated Unions.
 */
import * as http from 'node:http';
import {
  CaerusClient,
  CaerusSignatureError,
  CaerusWebhookExpiredError,
  type CaerusEvent,
  type ResourceTakenData,
  type DeadlockDetectedData,
} from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  apiKey: process.env.CAERUS_API_KEY ?? 'test_key',
});

const WEBHOOK_SECRET = process.env.CAERUS_WEBHOOK_SECRET ?? 'whsec_sample_secret';

//Strongly typed handlers
function handleResourceTaken(data: ResourceTakenData, environmentId: string) {
  console.log(`[${environmentId}] Resource hold created:`, {
    resourceKey: data.resourceKey,
    holderId: data.holderId,
    amount: data.amount,
    expiresAt: new Date(data.expiresAt * 1000).toISOString(),
    idempotencyKey: data.idempotencyKey,
  });
}

function handleDeadlock(data: DeadlockDetectedData) {
  console.warn(`Deadlock detected! Strategy: ${data.resolutionStrategy}`, {
    victim: data.victimTransactionId,
    cycle: data.cycleTransactionIds,
    reason: data.reason,
  });
}

/**
 * Handles incoming webhook payloads in a framework-agnostic way.
 */
export function processWebhook(rawBody: Buffer | string, signatureHeader: string): CaerusEvent {
  const event = caerus.webhooks.constructEvent(rawBody, signatureHeader, WEBHOOK_SECRET);

  console.log(`Received event: ${event.eventType} (id=${event.id}, product=${event.product}, env=${event.environmentId})`);

  // Discriminated union
  switch (event.eventType) {
    case 'resource.taken':
      // TypeScript infers event.data like ResourceTakenData
      handleResourceTaken(event.data, event.environmentId);
      break;

    case 'resource.confirmed':
      console.log(`Resource hold confirmed: holder=${event.data.holderId}, resource=${event.data.resourceKey}`);
      break;

    case 'lock.acquired':
      console.log(`Lock acquired: key=${event.data.lockKey}, tx=${event.data.transactionId}, fencingToken=${event.data.fencingToken}`);
      break;

    case 'lock.deadlock_detected':
      // TypeScript infiere event.data como DeadlockDetectedData
      handleDeadlock(event.data);
      break;

    default:
      console.log(`Unhandled event type: ${event.eventType}`);
  }

  return event;
}

/**
 * Optional: A runnable HTTP server with native Node.js (no extra dependencies).
 */
export function startWebhookServer(port = 3000): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhooks') {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const signature = (req.headers['caerus-signature'] as string) ?? '';

        try {
          const event = processWebhook(rawBody, signature);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true, eventId: event.eventId, product: event.product }));
        } catch (err) {
          if (err instanceof CaerusSignatureError || err instanceof CaerusWebhookExpiredError) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`Signature verification failed: ${err.message}`);
          } else {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Internal error: ${(err as Error).message}`);
          }
        }
      });
    } else {
      res.writeHead(404).end();
    }
  });

  return server.listen(port, () => {
    console.log(`Webhook listener running on http://localhost:${port}/webhooks`);
  });
}
