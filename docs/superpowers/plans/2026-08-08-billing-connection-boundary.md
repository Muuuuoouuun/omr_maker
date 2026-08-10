# Disabled Billing Connection Seam Scope Guard

> **For agentic workers:** This document is a release scope guard. It does not authorize payment,
> persistence, route, or provider implementation.

**Goal:** Keep real payment and durable billing work outside the initial-operations release while
preserving a disabled provider-neutral integration seam for a separately designed future release.

**Architecture:** This release retains only the disabled server-only provider-neutral adapter,
catalog, and authority seam. The seam is compiler-poisoned against browser imports, has no production
call site, and cannot become live through configuration.

**Tech Stack:** TypeScript server-only contracts and Vitest contract tests only.

---

## Authoritative release scope

The user superseded the earlier durable billing plan. For this release:

- live checkout and every real payment provider remain unimplemented and disabled;
- no billing table, migration, RPC, durable store, customer binding, subscription ledger, or webhook
  event ledger is added;
- no checkout handler, webhook handler, provider registry, or billing API route is added;
- no browser or production server module imports or calls the seam;
- no browser intent can change canonical plan or entitlement state;
- test-only fakes may validate the contracts but are forbidden from production call sites.

Any earlier task text in repository history that asks for durable billing persistence or HTTP exposure
is historical and must not be executed as part of this release.

## Retained seam

The bounded seam consists of:

- `src/lib/paymentProvider.ts` for public provider labels and disabled readiness display;
- `src/lib/billingCheckoutGate.ts` for the hard-off live-checkout gate;
- `src/lib/billingProviderContract.server.ts` for server-only adapter, closed catalog, normalized event,
  and authority-store interfaces;
- `src/lib/billingProviderContract.fake.server.ts` for deterministic test-only adapters and stores;
- `src/lib/billingProviderBoundary.test.ts` and focused unit tests for scope enforcement.

These are contracts, not a partial payment backend. `BillingAuthorityStore` describes a future
authority boundary but has no durable implementation in this release. `SERVER_PRICE_CATALOG` is
validation metadata inside the isolated server-only contract and is not exposed to the browser.

## Release contract

The release remains conformant only while all of the following hold:

1. `LIVE_CHECKOUT_IMPLEMENTED` is `false`, and configuration cannot enable a checkout CTA.
2. Browser-importable provider code contains no adapter, webhook, authority, organization, plan, or
   cryptographic server contract.
3. The server-only seam and test fake have no production call site.
4. No billing API directory or durable billing migration exists.
5. The authoritative release design and master plan continue to state this seam-only scope.

Verify the contract with:

```sh
npx vitest run src/lib/billingProviderBoundary.test.ts \
  src/lib/billingProviderContract.server.test.ts \
  src/lib/paymentProvider.test.ts \
  src/lib/settingsBillingSimplificationSurface.test.ts
```

## Deferred future work

A future payment release must start with a new approved design and threat model before it may add any
provider secret, checkout or webhook route, durable customer/subscription/event storage, entitlement
mutation, refund behavior, reconciliation job, or operational runbook. That future release must use
its own migrations, readiness version, hosted security evidence, provider sandbox evidence, recovery
drill, and rollback plan. None of those items is an unfinished task for initial operations.
