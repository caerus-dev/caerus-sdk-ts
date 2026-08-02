# @caerus-dev/sdk

The Caerus client for Node.js. Reserve limited stock — seats, slots, inventory — without
writing the concurrency logic that keeps two customers from buying the same thing.

```typescript
await caerus.reserve('seat_A12', async () => {
  await chargeCard(4500);
});
```

That call holds the seat, runs your payment, and then either confirms the reservation or
puts the seat back on sale. You never write the rollback.

---

## What problem this solves

Selling something there is only one of is harder than it looks. Two people click *buy* at
the same moment; one payment takes eight seconds; a third customer abandons the page with
the seat still held. Getting that right means distributed locks, timeouts, and a
background job to clean up what was abandoned.

Caerus is that machinery as a service. This package is how you talk to it.

**It runs on your server.** The API Key authenticates every call and identifies your
environment, so it cannot go anywhere a browser could read it.

---

## Install

```bash
npm install @caerus-dev/sdk
```

Node 20 or newer. TypeScript types are included; JavaScript works too.

## Connect

```typescript
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY!,
});
```

> ⚠️ **`REPLACE_ME.caerus.example:9090` is a placeholder.** Ask your Caerus contact for
> the address of your engine. There is deliberately no default: a wrong one baked into
> this package would reach you as a connection error with nothing to suggest it was
> never meant to work.

| Option | Default | What it does |
|---|---|---|
| `endpoint` | — | Host and port of the engine. Required |
| `apiKey` | — | From the Caerus dashboard. Required. Identifies your environment too |
| `tls` | `true` | Encrypts the connection. Turn off only against a local engine |
| `timeoutMs` | `10000` | Deadline on every call |
| `logger` | `console.error` | Where the SDK reports things it handled but you should know about |

Build one client and keep it. It holds a connection that every call shares; making one
per request throws that away.

```typescript
caerus.close();   // on shutdown. Node stays alive while the connection is open
```

---

## A complete example

Four seats on sale, one of them sold.

```typescript
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY!,
});

// Once, when the show goes on sale. "seat" is a template you made in the dashboard.
for (const number of [1, 2, 3, 4]) {
  await caerus.createResource('seat', `seat_A${number}`, 1, { groupKey: 'row_A' });
}

// Every time somebody buys.
const ticket = await caerus.reserve('seat_A1', async (reservation) => {
  const { paymentId } = await chargeCard(4500);
  return issueTicket(paymentId, reservation.id);
});

// seat_A1 is now confirmed and off the market.
const row = await caerus.getResourcesByGroup('row_A');
console.log(row.resources.filter((seat) => seat.availableAmount > 0).length);  // 3
```

If `chargeCard` throws, `seat_A1` is released before the error reaches you, and the error
you get is the one `chargeCard` threw — not one about reservations.

---

## `reserve` — the whole cycle in one call

```typescript
reserve(resourceKey, work, options?)
reserveMany(resourceKey, amount, work, options?)
```

- Your work returns → the reservation is **confirmed**
- Your work throws → the reservation is **released**, and your error is re-thrown untouched
- `reserve` returns whatever your work returned

This exists because forgetting the release on the error path is the mistake everyone
makes, and the stock stays held until the hold expires.

```typescript
const ticketId = await caerus.reserve(
  'seat_A12',
  async (reservation) => {
    console.log(`held until ${reservation.expiresAt.toISOString()}`);
    return issueTicket();
  },
  { ttlSeconds: 120, metadata: { orderId: 'ord_1234' } },
);
```

**If the release also fails**, your error still comes out; the failed release goes to the
logger. The units lapse on their own anyway.

**If the reservation comes back queued**, `reserve` throws without running your work: a
queued reservation is not holding anything yet, and running your payment against it would
charge a card for a seat the customer does not have. Use `take` if you want to handle
queueing yourself.

More in `examples/01-reserve.ts`, in the repository.

---

## The methods

### Reservations

```typescript
take(resourceKey, options?)             // hold one unit
takeMany(resourceKey, amount, options?) // hold several
confirm(reservationId, options?)        // settle it: the units stay taken
release(reservationId)                  // give them back early
extend(reservationId, extraSeconds)     // push the expiry out
getReservation(reservationId)           // read it as it stands
```

`options` for `take` and `takeMany`:

| Field | What it does |
|---|---|
| `idempotencyKey` | Sending the same key twice returns the first reservation instead of taking more. Some templates require it |
| `ttlSeconds` | Overrides the template's hold time |
| `metadata` | An object of your own that travels with the reservation |

Use these when a hold has to outlive a single function — taken on one HTTP request,
confirmed on another. Everywhere else `reserve` is less code and cannot forget the
release.

More in `examples/02-manual-lifecycle.ts`, in the repository.

#### What a reservation looks like

```typescript
{
  id: 'hld_...',
  resourceId: 'res_...',
  status: 'PENDING',
  amount: 1,
  expiresAt: Date,                       // a real Date, not epoch seconds
  metadata: { orderId: 'ord_1234' },     // an object, not a JSON string
}
```

#### Statuses

| Status | What it means |
|---|---|
| `PENDING` | Held and waiting for you to confirm or release |
| `CONFIRMED` | Settled. The units are taken for good |
| `RELEASED` | Given back |
| `QUEUED` | No stock; the engine parked the request. **Nothing is held yet** |
| `FAILED` | The hold did not survive — it expired, most likely |

`take` throws on `FAILED` rather than handing back something that looks successful.
`getReservation` returns it: asking what state something is in and being told `FAILED` is
an answer, not a failure.

### Inventory

```typescript
createResource(templateName, key, availableAmount, options?)
getResource(key)
getResourcesByGroup(groupKey, options?)   // { page?, pageSize? }
```

Templates — hold duration, whether metadata is kept, what happens when stock runs out —
live in the Caerus dashboard. The concrete resources that follow those rules are created
here, and only here.

More in `examples/03-inventory.ts`, in the repository.

---

## Errors

Every error extends `CaerusError`, so one `catch` handles them all. Each keeps the
message the engine sent.

| Error | `code` | When |
|---|---|---|
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | No such resource, template or reservation |
| `OutOfStockError` | `OUT_OF_STOCK` | There is not enough left to hold |
| `ConflictError` | `CONFLICT` | Some other invalid state: already confirmed, already expired |
| `ValidationError` | `VALIDATION` | The request was rejected |
| `AuthenticationError` | `AUTHENTICATION` | API Key missing, unknown or revoked |
| `TimeoutError` | `TIMEOUT` | The call ran past its deadline |
| `CaerusError` | `UNKNOWN` | Anything else |

**`OutOfStockError` extends `ConflictError`**, so code that only cares about "I could not
get it" needs one branch, and code that wants to say *sold out* can have its own:

```typescript
try {
  await caerus.take('seat_A12');
} catch (error) {
  // The specific one first — the other way round this never runs.
  if (error instanceof OutOfStockError) {
    return 'Sold out';
  }
  if (error instanceof ConflictError) {
    return 'Not available right now';
  }
}
```

Switching on `code` instead of the class needs both cases spelled out: `OUT_OF_STOCK`
does not also match `CONFLICT`.

More in `examples/04-errors.ts`, in the repository.

---

## Testing without Caerus

`InMemoryCaerusClient` implements the same interface as the real client, so the code
under test cannot tell them apart. It keeps real stock: a test that reserves more than
exists fails the way production would.

```typescript
import { InMemoryCaerusClient, type SharedResourceApi } from '@caerus-dev/sdk';

// Take the interface, not the class.
async function buySeat(caerus: SharedResourceApi, seat: string) {
  return caerus.reserve(seat, () => chargeCard(4500));
}

const caerus = new InMemoryCaerusClient({
  resources: [{ key: 'seat_A12', availableAmount: 1 }],
});

await buySeat(caerus, 'seat_A12');
```

**Time does not pass on its own**, which is the point:

```typescript
const reservation = await caerus.take('seat_A12', { ttlSeconds: 300 });

caerus.advanceTime(301);                 // 301 seconds later
await caerus.getReservation(reservation.id);   // status: 'FAILED'
```

A mock that expired reservations on a real clock would make your tests wait, and fail now
and then depending on how busy the machine was. Here time is an input, like the stock.

**Forcing failures**, for the paths you cannot otherwise reach:

```typescript
caerus.failNext('release', new ConflictError('release exploded'));
caerus.clearFailures();
```

Also available: `expire(reservationId)` for one reservation, and `snapshot()` for
assertions the API cannot make.

More in `examples/05-testing.ts`, in the repository.

---

## Known limitations

Nothing here is a bug report — it is what this version does not do, so you can plan
around it.

### Nothing that changes state is ever retried

If the network fails mid-call, the SDK cannot know whether the engine processed the
request. Re-sending a `take` could hold the stock twice; re-sending an `extend` would add
the time twice, silently. Since Caerus exists precisely so that two people cannot buy the
same seat, an SDK that could cause that would contradict the product.

**What it does instead:** every call has a deadline, and `idempotencyKey` lets you retry
a `take` safely yourself. Read-only calls are harmless and may be retried freely.

### A slow block can outlive its own reservation

If the work you pass to `reserve` takes longer than the hold, the reservation expires
while your work is still running, and the `confirm` afterwards fails. Your work already
happened — the payment went through — but the seat went back on sale in the middle.

This is correct behaviour and still a surprise. It is a real risk with slow payment
providers and short hold times.

**Avoid it by** setting `ttlSeconds` above your payment provider's worst case, not its
average.

`reserve` also puts **no time limit on your block**. The deadline covers calls to Caerus,
not what happens between them; interrupting your logic is not the SDK's business.

### The in-memory client is not the engine

It is faithful to how we understand Caerus, which is not the same as being faithful to
Caerus. Specifically:

- **`QUEUED` is not simulated.** Out of stock always throws `OutOfStockError`, like the
  `FAIL` strategy. Templates that queue cannot be exercised against it
- **Template rules are not enforced.** A single-unit template requiring exactly 1, or a
  template that rejects metadata, will be accepted here and refused by the engine
- **`templateId` is made up** (`tpl-<name>`), so it will not match a real one
- It is single-threaded, so it says nothing about races

Treat a green test suite against the mock as evidence your code is wired correctly, not
as evidence it works against Caerus.

### No signature on anything

This version has no way to verify that a call came from where it says. There is nothing
to do about it here; it is noted so it is not mistaken for a guarantee.

---

## Contributing

The gRPC client is generated from `data-plane-service/src/main/proto/sre_service.proto`
before every build and is not committed, so it cannot drift from the contract.

```bash
npm install
npm run generate     # produces src/generated and src/version.ts
npm run typecheck    # source, tests and every example
npm test
npm run build        # CJS, ESM and .d.ts
```

Two rules the build enforces:

- **The examples in `examples/` are compiled.** Change the API and forget an example, and
  the build fails. Documentation that cannot go stale quietly
- **Nothing generated from the `.proto` may appear in the published types.** `npm run
  build` checks `dist/*.d.ts` and fails if it finds any

## Licence

MIT
