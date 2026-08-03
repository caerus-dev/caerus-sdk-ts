# @caerus-dev/sdk

The Caerus client for Node.js. Reserve limited stock — seats, slots, inventory — without
writing the concurrency logic that keeps two customers from buying the same thing.

```typescript
const holder = await caerus.unitary('seat_A12').take();
await chargeCard(4500);
await caerus.confirm(holder.id);
```

The seat is held while the payment runs, and taken for good once it settles. If anything
goes wrong, `release` puts it straight back on sale — and if your process dies before it
can, the hold expires on its own.

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
  await caerus.createUnitary('seat', `seat_A${number}`, { groupKey: 'row_A' });
}

// Every time somebody buys.
const holder = await caerus.unitary('seat_A1').take({ ttlSeconds: 120 });

try {
  const { paymentId } = await chargeCard(4500);
  await caerus.confirm(holder.id, { metadata: { paymentId } });
} catch (error) {
  await caerus.release(holder.id);   // straight back on sale
  throw error;
}

// seat_A1 is now confirmed and off the market.
const row = await caerus.getResourcesByGroup('row_A');
console.log(row.resources.filter((seat) => seat.availableAmount > 0).length);  // 3
```

**Release on every path that abandons a checkout.** Without it the seat stays held until
its TTL runs out — correct, but minutes of stock nobody can buy.

More in `examples/01-holding-a-resource.ts`, in the repository.

---

## The methods

### Taking: `unitary` and `pooled`

You take through a handle, and the handle says what kind of resource it is.

```typescript
const seat = caerus.unitary('seat_A12');       // one of it
await seat.take(options?);

const pool = caerus.pooled('general_admission'); // many of it
await pool.take(options?);
await pool.takeMany(4, options?);
```

**`unitary` has no `takeMany`.** Asking for three of a numbered seat does not compile —
which is the point of splitting them.

Making a handle fetches nothing. It records what *you* know the resource to be, so the
type holds wherever the taking happens, which is rarely the service that declared the
inventory in the first place.

> That also means the SDK believes you. `pooled('seat_A12').takeMany(3)` compiles, and
> the engine refuses it at runtime just as it would have before. This is a safety net,
> not a guarantee.

### Holders

```typescript
confirm(resourceHolderId, options?)   // settle it: the units stay taken
release(resourceHolderId)             // give them back early
extend(resourceHolderId, extraMs)     // push the expiry out
getResourceHolder(resourceHolderId)   // read it as it stands
```

These take a holder id rather than a resource, which is why they live on the client and
not on the handles.

`options` for `take` and `takeMany`:

| Field | What it does |
|---|---|
| `idempotencyKey` | Sending the same key twice returns the first holder instead of taking more. Some templates require it |
| `ttlSeconds` | Overrides the template's hold time |
| `metadata` | An object of your own that travels with the holder |

> ⚠️ **`extend` takes milliseconds, `ttlSeconds` takes seconds.** That mismatch is in the
> contract, not something this SDK invented, so it is passed through rather than papered
> over. The engine works in whole seconds and rounds up: anything under 1000 buys exactly
> one second.

More in `examples/02-holders.ts`, in the repository.

#### What a holder looks like

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
`getResourceHolder` returns it: asking what state something is in and being told `FAILED` is
an answer, not a failure.

### Inventory

```typescript
createUnitary(templateName, key, options?)                    // one unit, no amount
createMultiple(templateName, key, availableAmount, options?)  // several
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
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | No such resource, template or holder |
| `ConflictError` | `CONFLICT` | The state does not allow it — **including no stock** |
| `ValidationError` | `VALIDATION` | The request was rejected |
| `AuthenticationError` | `AUTHENTICATION` | API Key missing, unknown or revoked |
| `TimeoutError` | `TIMEOUT` | The call ran past its deadline |
| `CaerusError` | `UNKNOWN` | Anything else |

```typescript
try {
  await caerus.unitary('seat_A12').take();
} catch (error) {
  if (error instanceof ConflictError) {
    // Sold out, or the holder was in the wrong state — see Known limitations
  }
}
```

More in `examples/04-errors.ts`, in the repository.

---

## Testing without Caerus

`InMemoryCaerusClient` implements the same interface as the real client, so the code
under test cannot tell them apart. It keeps real stock: a test that takes more than
exists fails the way production would.

```typescript
import { InMemoryCaerusClient, type SharedResourceApi } from '@caerus-dev/sdk';

// Take the interface, not the class.
async function buySeat(caerus: SharedResourceApi, seat: string) {
  const holder = await caerus.unitary(seat).take();
  await chargeCard(4500);
  await caerus.confirm(holder.id);
}

const caerus = new InMemoryCaerusClient({
  resources: [{ key: 'seat_A12', availableAmount: 1 }],
});

await buySeat(caerus, 'seat_A12');
```

**Time does not pass on its own**, which is the point:

```typescript
const holder = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });

caerus.advanceTime(301);                 // 301 seconds later
await caerus.getResourceHolder(holder.id);   // status: 'FAILED'
```

A mock that expired holders on a real clock would make your tests wait, and fail now
and then depending on how busy the machine was. Here time is an input, like the stock.

**Forcing failures**, for the paths you cannot otherwise reach:

```typescript
caerus.failNext('release', new ConflictError('release exploded'));
caerus.clearFailures();
```

Also available: `expire(resourceHolderId)` for one holder, and `snapshot()` for
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

### "Sold out" arrives as a generic conflict

The engine reports no-stock and every other invalid state with the same code, so both
become `ConflictError`. Telling them apart means reading the message text, which will
break the first time the wording changes.

**In the meantime:** check the stock with `getResource` before deciding what to tell your
customer, rather than parsing the message.

### Slow work can outlive its own hold

If whatever you do between `take` and `confirm` takes longer than the hold, the
holder expires while you are still working and the `confirm` afterwards fails. Your
work already happened — the payment went through — but the seat went back on sale in the
middle.

This is correct behaviour and still a surprise. It is a real risk with slow payment
providers and short hold times.

**Avoid it by** setting `ttlSeconds` above your payment provider's worst case, not its
average, and by calling `extend` when you are about to run out.

### The in-memory client is not the engine

It is faithful to how we understand Caerus, which is not the same as being faithful to
Caerus. Specifically:

- **`QUEUED` is not simulated.** Out of stock always throws `ConflictError`, like the
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

The gRPC client is generated from `proto/sre_service.proto` before every build and is
not committed, so it cannot drift from the contract. That `.proto` is a copy of the one
in `caerus-back`; see [`proto/README.md`](proto/README.md).

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

Deeper documentation lives in [`docs/`](docs/) — the Caerus model, how the SDK is put
together, the error mapping, and how to run it against a real engine. It is written in
Spanish, for the teams building on Caerus. If you are going to change this package,
[`AGENTS.md`](AGENTS.md) is the place to start.

## Licence

MIT
