# Billing Connection Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leave real payments disabled while completing durable provider-neutral storage, HTTP, idempotency, ordering, and entitlement boundaries so a future provider requires only an adapter and secrets.

**Architecture:** Provider adapters may create checkout sessions and verify raw webhooks, but they never select an organization or plan. Customer bindings identify organizations and a server-only price catalog selects plans. PostgreSQL atomically writes the normalized event ledger, subscription state, and organization entitlement. Production registry remains empty and all live endpoints fail closed.

**Tech Stack:** TypeScript server-only modules, Next.js route handlers, PostgreSQL 17, Vitest, fake adapter dependency injection.

---

### Task 1: Remove organization and plan authority from provider events

**Files:**
- Modify: `src/lib/paymentProvider.ts`
- Modify: `src/lib/billingProviderContract.server.ts`
- Modify: `src/lib/billingProviderContract.server.test.ts`
- Create: `src/lib/billingPriceCatalog.server.ts`
- Create: `src/lib/billingPriceCatalog.server.test.ts`

- [ ] **Step 1: Write failing provider-authority tests**

```ts
const event = verifiedEnvelope().event;
expect(event).not.toHaveProperty("organizationId");
expect(event).not.toHaveProperty("targetPlan");
expect(event).toMatchObject({
  providerCustomerId: "cus_provider_01",
  providerSubscriptionId: "sub_provider_01",
  priceKey: "omr_pro_monthly_v1",
});
expect(resolveBillingPrice("omr_pro_monthly_v1")).toEqual({ plan: "pro", cycle: "monthly" });
expect(resolveBillingPrice("provider_supplied_unknown")).toBeNull();
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/billingProviderContract.server.test.ts src/lib/billingPriceCatalog.server.test.ts
```

- [ ] **Step 3: Implement server-authoritative normalized types**

```ts
export interface NormalizedSubscriptionWebhookEvent {
  eventId: string;
  eventType: SubscriptionWebhookEventType;
  occurredAt: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  subscriptionStatus: SubscriptionLifecycleStatus;
  priceKey: string;
}
```

The price catalog is a frozen server-only map whose keys are internal aliases, not browser plans:

```ts
export const BILLING_PRICE_CATALOG = Object.freeze({
  omr_pro_monthly_v1: { plan: "pro", cycle: "monthly" },
  omr_pro_annual_v1: { plan: "pro", cycle: "annual" },
  omr_academy_monthly_v1: { plan: "academy", cycle: "monthly" },
  omr_academy_annual_v1: { plan: "academy", cycle: "annual" },
} as const);
```

Checkout browser intent is validated against this catalog on the server. Webhook processing passes
provider identifiers and price key to the store; it never constructs a target plan from event input.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/billingProviderContract.server.test.ts src/lib/billingPriceCatalog.server.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/paymentProvider.ts src/lib/billingProviderContract.server.ts src/lib/billingProviderContract.server.test.ts src/lib/billingPriceCatalog.server.ts src/lib/billingPriceCatalog.server.test.ts
git commit -m "refactor(billing): make price mapping server authoritative"
```

### Task 2: Add a deterministic fake adapter for tests only

**Files:**
- Create: `src/lib/testing/fakePaymentProviderAdapter.ts`
- Create: `src/lib/testing/fakePaymentProviderAdapter.test.ts`
- Modify: `src/lib/billingCheckoutGate.ts`

- [ ] **Step 1: Write failing fake-adapter tests**

```ts
expect(fake.key).toBe("toss");
await expect(fake.createCheckoutSession(request)).resolves.toMatchObject({
  status: "created",
  provider: "toss",
  checkoutSessionId: "checkout_test_0001",
});
await expect(fake.verifyWebhook({ headers: { "x-test-signature": "invalid" }, body }))
  .resolves.toEqual({ ok: false, error: "invalid_signature" });
expect(LIVE_CHECKOUT_IMPLEMENTED).toBe(false);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/testing/fakePaymentProviderAdapter.test.ts
```

- [ ] **Step 3: Implement test-only deterministic behavior**

The module accepts a fixed secret and injected clock, signs `timestamp.rawBody` with HMAC-SHA256,
returns monotonically numbered checkout IDs, and emits only valid normalized events. It must throw when
`NODE_ENV === "production"` and must not be imported by the production registry.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/testing/fakePaymentProviderAdapter.test.ts src/lib/billingProviderContract.server.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/testing/fakePaymentProviderAdapter.ts src/lib/testing/fakePaymentProviderAdapter.test.ts src/lib/billingCheckoutGate.ts
git commit -m "test(billing): add deterministic fake adapter"
```

### Task 3: Add the four durable billing tables and atomic apply RPC

**Files:**
- Create: `supabase/migrations/202608080006_billing_connection_boundary.sql`
- Create: `src/lib/billingConnectionBoundaryMigrationContract.test.ts`
- Modify: `supabase/production-server-boundary.sql`
- Modify: `supabase/production-server-boundary-rollback.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `supabase/live-test-rollback-assertions.sql`
- Modify: `scripts/backup-restore-core.mjs`
- Modify: `src/lib/backupRestoreCore.test.ts`
- Modify: `src/lib/productionServerBoundaryContract.test.ts`

- [ ] **Step 1: Write the failing migration contract**

Require exact tables:

```ts
expect(canonicalTables).toEqual(expect.arrayContaining([
  "omr_billing_checkout_intents",
  "omr_billing_customers",
  "omr_billing_subscriptions",
  "omr_billing_webhook_events",
]));
expect(sql).toContain("omr_apply_billing_event_v1");
expect(sql).not.toMatch(/raw_payload|email|student_name/i);
expect(sql).not.toMatch(/grant execute[^;]+\bto\s+(anon|authenticated)\b/i);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/billingConnectionBoundaryMigrationContract.test.ts src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts
```

- [ ] **Step 3: Create the durable schema**

Use hashed provider identifiers and these bounded states:

```text
checkout intent: pending | created | failed | expired
subscription: trialing | active | past_due | canceled | expired
event result: applied | duplicate | stale | rejected
```

Enforce unique organization/idempotency hash, provider/customer hash, provider/subscription hash, and
provider/event hash. Store payload SHA-256 and normalized bounded fields only.

- [ ] **Step 4: Implement `omr_apply_billing_event_v1`**

The service-role-only `SECURITY DEFINER` function validates exact JSON keys, binds customer hash to an
organization, resolves the server price key, locks the organization and subscription, inserts the event
once, rejects distinct events with `occurred_at <= last_event_at` as stale, and atomically applies:

```text
trialing or active -> catalog plan
past_due, canceled, or expired -> free
```

The function never trusts organization ID or target plan from the webhook. Same-timestamp distinct
events are stale/conflict and cannot change the plan.

- [ ] **Step 5: Add PostgreSQL concurrency and boundary evidence**

Live assertions use two `dblink` sessions for duplicate concurrency and active/cancel ordering. They
prove one ledger row, deterministic final plan, stale replay, unknown customer/price no-op,
anon/authenticated denial, service-role success, and absence of raw identifiers or payloads.

- [ ] **Step 6: Update canonical manifests and readiness version**

After operator grant and operational job-status tables, the four billing tables make the expected final
canonical count 44. Set readiness version to `202608080006`, add `billingBoundaryReady`, and update every
exact-version consumer found by:

```sh
rg -l '202608060029' src scripts supabase docs .github
```

- [ ] **Step 7: Run GREEN and live SQL**

```sh
npx vitest run src/lib/billingConnectionBoundaryMigrationContract.test.ts src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts
npm run test:supabase:live
```

- [ ] **Step 8: Commit**

```sh
git add supabase/migrations/202608080006_billing_connection_boundary.sql src/lib/billingConnectionBoundaryMigrationContract.test.ts supabase/production-server-boundary.sql supabase/production-server-boundary-rollback.sql supabase/live-test-assertions.sql supabase/live-test-rollback-assertions.sql scripts/backup-restore-core.mjs src/lib/backupRestoreCore.test.ts src/lib/productionServerBoundaryContract.test.ts src/lib/supabaseReadinessProbe.ts scripts/verify-initial-operations.mjs scripts/initial-operations-core.mjs scripts/backup-production.mjs .github/workflows/production-readiness.yml docs/production-readiness.md
git commit -m "feat(billing): add atomic durable provider boundary"
```

### Task 4: Implement the Supabase billing store

**Files:**
- Create: `src/lib/billingStore.server.ts`
- Create: `src/lib/billingStore.server.test.ts`

- [ ] **Step 1: Write failing store tests**

```ts
expect(hashProviderReference("cus_live_123")).toMatch(/^[a-f0-9]{64}$/);
expect(await store.createCheckoutIntent(input)).toMatchObject({ status: "created" });
expect(await store.createCheckoutIntent(input)).toMatchObject({ status: "duplicate" });
expect(client.rpc).toHaveBeenCalledWith("omr_apply_billing_event_v1", {
  p_event: expect.objectContaining({ customer_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
  p_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
});
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/billingStore.server.test.ts
```

- [ ] **Step 3: Implement stable server-only methods**

Expose create/finalize checkout intent, bind customer, and apply verified event. Hash provider customer,
subscription, checkout, event, idempotency, and raw-body references before database calls. Map database
responses to `applied`, `duplicate`, `stale`, `rejected`, or `dependency_unavailable`; never expose raw
database errors.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/billingStore.server.test.ts src/lib/billingProviderContract.server.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/billingStore.server.ts src/lib/billingStore.server.test.ts
git commit -m "feat(billing): implement durable supabase store"
```

### Task 5: Add a production-empty provider registry and bounded handlers

**Files:**
- Create: `src/lib/paymentProviderRegistry.server.ts`
- Create: `src/lib/paymentProviderRegistry.server.test.ts`
- Create: `src/lib/billingHttpHandlers.server.ts`
- Create: `src/lib/billingHttpHandlers.server.test.ts`

- [ ] **Step 1: Write failing registry and HTTP tests**

```ts
expect(resolvePaymentProviderAdapter("toss", productionEnv)).toBeNull();
expect(await handleCheckout(request, dependencies)).toMatchObject({ status: 503, body: { code: "dependency_unavailable" } });
expect(await handleWebhook("unknown", request, dependencies)).toMatchObject({ status: 404, body: { code: "not_found" } });
expect(await handleWebhook("toss", oversizedRequest, fakeDependencies)).toMatchObject({ status: 413, body: { code: "invalid_input" } });
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/paymentProviderRegistry.server.test.ts src/lib/billingHttpHandlers.server.test.ts
```

- [ ] **Step 3: Implement checkout handler safety**

Require same origin, JSON content type, body ≤4 KiB, signed generation-validated teacher session,
organization membership, and role `owner`. Resolve plan/cycle through the catalog. With no adapter,
return 503 before a checkout intent or plan mutation.

- [ ] **Step 4: Implement webhook handler safety**

Do not apply same-origin checks to external webhooks. Stream at most 256 KiB, resolve known provider,
require an adapter, and pass raw bytes to signature verification before JSON parsing. Unknown provider is
404; known but unconfigured is 503; bad signature is 401; malformed normalized event is 400.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/paymentProviderRegistry.server.test.ts src/lib/billingHttpHandlers.server.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add src/lib/paymentProviderRegistry.server.ts src/lib/paymentProviderRegistry.server.test.ts src/lib/billingHttpHandlers.server.ts src/lib/billingHttpHandlers.server.test.ts
git commit -m "feat(billing): add disabled bounded handlers"
```

### Task 6: Expose fail-closed billing routes

**Files:**
- Create: `src/app/api/billing/checkout/route.ts`
- Create: `src/app/api/billing/checkout/route.test.ts`
- Create: `src/app/api/billing/webhooks/[provider]/route.ts`
- Create: `src/app/api/billing/webhooks/[provider]/route.test.ts`
- Modify: `src/app/teacher/billing/page.tsx`
- Modify: `src/app/teacher/billing/page.test.ts`

- [ ] **Step 1: Write failing route tests**

```ts
expect(await checkoutPost(validRequest)).toMatchObject({ status: 503 });
expect(await checkoutPost(validRequest).then(response => response.json())).toEqual({ code: "dependency_unavailable" });
expect(await webhookPost({ provider: "unknown" }, request)).toMatchObject({ status: 404 });
expect(LIVE_CHECKOUT_IMPLEMENTED).toBe(false);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/app/api/billing/checkout/route.test.ts 'src/app/api/billing/webhooks/[provider]/route.test.ts' src/app/teacher/billing/page.test.ts
```

- [ ] **Step 3: Wire routes to production dependencies**

Routes set `Cache-Control: no-store`, use stable JSON codes, never follow provider redirects, and never
instantiate the fake adapter. The billing page presents a read-only `결제 연결 준비 중` state and does
not offer local simulation that appears to change canonical entitlement.

- [ ] **Step 4: Run GREEN and regression tests**

```sh
npx vitest run src/app/api/billing/checkout/route.test.ts 'src/app/api/billing/webhooks/[provider]/route.test.ts' src/app/teacher/billing/page.test.ts src/lib/billingStatusSurface.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/app/api/billing/checkout/route.ts src/app/api/billing/checkout/route.test.ts 'src/app/api/billing/webhooks/[provider]/route.ts' 'src/app/api/billing/webhooks/[provider]/route.test.ts' src/app/teacher/billing/page.tsx src/app/teacher/billing/page.test.ts
git commit -m "feat(billing): expose disabled provider routes"
```
