# Canonical Cache and Assignment Lifecycle Reconciliation Design

## Context

The current `codex/initial-ops-100` branch is the reviewed release candidate, but two operational truthfulness gaps remain:

1. Teacher screens trust a global “last verified” timestamp alongside mutable, unscoped localStorage rows. After account or organization changes, a remote outage can present another organization's old rows as verified degraded data.
2. Student assignment cards do not keep an authoritative server clock alive while the page remains open. An `in_progress` assignment can also be presented as a fresh start, and a newly assigned copy of the same exam can hide review history from an older completed assignment.

The diverged core branch contains useful cache, timestamp, and lifecycle ideas, but cannot be merged wholesale. Its generic load resolver is weaker than the release candidate, its dashboard WIP loses rich question data on fresh loads, and degraded child components still expose mutations.

## Goals

- Preserve the release candidate's exact-envelope, caller-clock, fail-closed `resolveCanonicalLoad` contract.
- Store only tenant-scoped, bounded, redacted canonical projections.
- Keep full rich exam and attempt data in memory for successful fresh loads.
- Bind every asynchronous teacher dashboard result to organization, account/session generation, and request generation.
- Make degraded teacher surfaces read-only through child capability boundaries, not just parent banners.
- Reject incomplete remote collections instead of silently dropping malformed rows.
- Keep student assignment lifecycle monotonic and authoritative while the page is open.
- Correctly display exact-scope `in_progress` work and older completed history after same-exam reassignment.
- Preserve payments as an integration seam only; no payment implementation is included.

## Non-goals

- No production deployment, preview promotion, or hosted mutation is performed by this work.
- No raw invite URL, credential, answer body, question body, handwriting payload, feedback body, or secret is cached.
- No whole-branch merge or blind cherry-pick from `codex/initial-ops-core-distribution` is allowed.
- A cache write failure never downgrades an otherwise successful fresh response.

## Architecture

### 1. Strict generic load resolver remains authoritative

`src/lib/canonicalLoadState.ts` remains the shared state machine. It continues to require exact top-level and nested keys, a canonical UTC `now`, no future `staleAt`, and a boolean emptiness predicate. The core branch's alternate resolver API is not imported.

### 2. Tenant-scoped cache envelope

`src/lib/canonicalSurfaceCache.ts` owns an exact JSON envelope:

```ts
type CanonicalSurfaceCacheEnvelope<T> = {
  schemaVersion: 1;
  surface: "teacher_dashboard" | "teacher_roster";
  organizationId: string;
  accountId: string;
  sessionGeneration: number;
  staleAt: string;
  data: T;
};
```

The storage key is domain-separated by surface, organization, account, and session generation. Reads require exact identity equality. Writes snapshot stable own data descriptors, reject accessors/proxies/cycles/sparse arrays/non-finite numbers, reparse and revalidate the serialized bytes, and enforce surface-specific byte limits.

Dashboard cache data is a compact summary projection capped at 2,000 attempts and 2 MiB. It omits repeated exam titles from attempts and derives them from cached exam summaries. Roster cache data is capped at 100 active/invited students, bounded groups/invites metadata without raw invite bearers, and 1 MiB. Tests construct maximum-count, maximum-field projections and require an exact round trip within the configured limit.

Legacy global verification markers are never treated as canonical evidence. They are removed during migration, logout, account change, and organization change. Cache removal is scoped and idempotent.

### 3. Exact remote collection contracts

Successful exam, attempt, and roster reads return:

```ts
type CanonicalCollectionMeta = {
  organizationId: string;
  loadedAt: string;
  rawCount: number;
  parsedCount: number;
};
```

Only successful server reads receive `loadedAt`. Gateway parsers reject the entire collection when `rawCount !== parsedCount`, any row organization differs from the authorized organization, a page is partial/has-more, or any required field is malformed. Stable public errors are returned; raw provider errors are sent only through the allowlisted server error reporter.

Roster loading is split into a side-effect-free read and an explicit persistence step. Local roster keys are written only after the caller's request fence and identity checks pass.

### 4. Fresh and degraded dashboard data paths

Fresh success retains the original rich `Exam[]` and `Attempt[]` in memory. The redacted cache projection is created only for optional persistence. Cache serialization failure does not alter the fresh state.

Degraded rendering materializes only redacted summary data and sets a shared capability:

```ts
type TeacherDataCapability = "fresh_mutable" | "degraded_read_only" | "unavailable";
```

`OverviewTab` and downstream controls receive this capability. In degraded mode they cannot archive, delete, edit, repair, export performance data, or trigger rich detail loads. Identity and non-analytic summaries remain visible with a persistent timestamped warning and retry action.

### 5. Request identity fence

Core and detailed loads capture:

```ts
type TeacherLoadIdentity = {
  organizationId: string;
  accountId: string;
  sessionGeneration: number;
  requestGeneration: number;
};
```

Every await checks the complete identity before publishing state or writing storage. Session storage changes are part of dashboard revalidation keys. Starting a new identity load immediately clears the old visible state to loading. Detailed attempt caches and in-flight requests are invalidated even when two organizations have identical or empty summary signals.

### 6. Assignment lifecycle authority

The assignment list action returns the same authoritative `serverNow` used by the gateway to classify rows. The client passes it unchanged to the dashboard and `AssignmentBlock`.

`AssignmentBlock` maintains a monotonic authoritative clock. A boundary timer advances scheduled → open → closed at `startsAt`/`endsAt`; browser clock rollback and older refresh timestamps cannot reverse lifecycle. The next server action remains the final authorization boundary.

Classification binds attempts to exact assignment scope. A matching `in_progress` attempt yields “continue” only for that assignment. Completed history from an older assignment remains review-only after the same exam is reassigned, while the new assignment's solve action remains independently governed.

## Error handling

- Malformed or mixed-tenant remote data produces `error_without_cache` unless an exact scoped cache exists.
- Cache parse, quota, or serialization failures are stable and silent for fresh success; they never invent degraded evidence.
- Degraded state never exposes mutation callbacks.
- Provider exception text never reaches action results, UI, logs uploaded as release evidence, or cache bytes.
- Organization/account/session changes invalidate visible and cached state before any new asynchronous result can publish.

## Test strategy

All behavior is implemented by red-green TDD.

Unit and contract tests cover:

- exact envelope, tenant/account/session scope, legacy marker purge, accessor/proxy/cycle/sparse/oversize rejection;
- 2,000-attempt and 100-student maximum round trips;
- secret-bearing field absence by serialized-byte scan;
- successful-only `loadedAt`, exact organization, raw/parsed equality, and all-or-none row parsing;
- organization switch with identical summaries and in-flight detailed requests;
- fresh rich question preservation versus redacted degraded materialization;
- child mutation/export/detail callbacks absent in degraded mode;
- exact-scope `in_progress`, same-exam reassignment history, scheduled/open/closed timer, and clock rollback.

Browser tests cover teacher organization-switch outage behavior, degraded read-only controls, retry recovery, and student lifecycle transitions. Chromium and WebKit run with one worker and zero retries. Final qualification also includes the full Vitest, type, lint, build/budget, PostgreSQL 17, production-safe browser, and diff gates.

## Release boundary

This reconciliation can make the local candidate structurally ready, but it cannot create a production GO score. The protected `initial-operations-staging` environment, 56 protected inputs, registered workflows, hosted 100-user load, alert heartbeat, restore rehearsal, and device evidence remain external prerequisites. Missing prerequisites must continue to produce `UNVERIFIED`/NO-GO, never a local substitute.
