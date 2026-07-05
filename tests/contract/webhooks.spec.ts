// Contract: /webhooks/subscriptions + /webhooks/deliveries and the
// /simulator/webhooks/{id}/replay envelope (openapi/vaultchain.yaml).

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import {
  itemsOnly,
  WebhookDeliverySchema,
  WebhookReplayResultSchema,
  WebhookSubscriptionSchema,
} from './schemas/index.js';

test('POST /webhooks/subscriptions -> 201 WebhookSubscription echoing the events', async ({
  asOperatorA,
  build,
}) => {
  const events = ['deposit.credited', 'withdrawal.broadcast'];
  const res = await new ApiClient(asOperatorA).post('/webhooks/subscriptions', {
    url: `https://hooks.example/${build.uniqueRef('sink')}`,
    secret: 'contract-suite-secret',
    events,
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(WebhookSubscriptionSchema);
  expect((res.json as { events: string[] }).events).toEqual(events);
});

test('POST /webhooks/subscriptions with an unknown event -> 400 problem+json', async ({
  asOperatorA,
  build,
}) => {
  const res = await new ApiClient(asOperatorA).post('/webhooks/subscriptions', {
    url: `https://hooks.example/${build.uniqueRef('sink')}`,
    secret: 'contract-suite-secret',
    events: ['nope.event'],
  });
  expectProblem(res, 400);
});

test('GET /webhooks/subscriptions -> 200 {items} including the new subscription', async ({
  asOperatorA,
  build,
}) => {
  const api = new ApiClient(asOperatorA);
  const created = await api.post('/webhooks/subscriptions', {
    url: `https://hooks.example/${build.uniqueRef('sink')}`,
    secret: 'contract-suite-secret',
    events: ['hold.opened'],
  });
  expect(created.status).toBe(201);

  const res = await api.get('/webhooks/subscriptions');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(itemsOnly(WebhookSubscriptionSchema));
  const ids = (res.json as { items: Array<{ id: string }> }).items.map((i) => i.id);
  expect(ids).toContain((created.json as { id: string }).id);
});

test('deliveries are recorded and signed; /simulator replay returns the replay envelope', async ({
  asOperatorA,
  asAdmin,
  build,
  chain,
}) => {
  const api = new ApiClient(asOperatorA);
  const sub = await api.post<{ id: string }>('/webhooks/subscriptions', {
    url: `https://hooks.example/${build.uniqueRef('sink')}`,
    secret: 'contract-suite-secret',
    events: ['deposit.credited'],
  });
  expect(sub.status).toBe(201);

  // A credited deposit (builder) must produce a delivery for our subscription.
  const funded = await build.fundedWallet();

  type DeliveryPage = { items: Array<{ id: string; subscriptionId: string; payload: string }> };
  const fetchMine = async () => {
    const res = await api.get<DeliveryPage>('/webhooks/deliveries?event=deposit.credited');
    expect(res.status).toBe(200);
    expect(res.json).toMatchSchema(itemsOnly(WebhookDeliverySchema));
    return res.json.items.find(
      (d) => d.subscriptionId === sub.json.id && d.payload.includes(funded.walletId),
    );
  };

  let mine = await fetchMine();
  if (!mine) {
    // Belt-and-braces re-advance: settlement is CAS-guarded and the clock is
    // forward-only (D22/D28), so if this worker's first advance didn't reach
    // the deposit's confirmation requirement, advancing further will.
    await chain.advanceBlocks(12);
    mine = await fetchMine();
  }
  expect(mine, 'crediting our deposit records a delivery for our subscription').toBeTruthy();

  // Replay OUR OWN delivery (ADMIN): asserts the envelope only — credit
  // idempotency semantics belong to the workflow suite.
  const replay = await new ApiClient(asAdmin).post(`/simulator/webhooks/${mine!.id}/replay`);
  expect(replay.status).toBe(200);
  expect(replay.json).toMatchSchema(WebhookReplayResultSchema);
});

test('POST /simulator/webhooks/{unknown}/replay -> 404 problem+json', async ({ asAdmin }) => {
  const res = await new ApiClient(asAdmin).post('/simulator/webhooks/no-such-delivery/replay');
  expectProblem(res, 404);
});
