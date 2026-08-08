# Initial Operations for 100 Users Release Design

**Date:** 2026-08-08  
**Status:** Written specification approved by the user
**Release target:** Browser-based initial operation for at most 100 active users  
**Quality target:** Mean score at least 9.3/10, every dimension at least 8.7/10, and no hard gate open

## 1. Purpose

This release turns the existing OMR Maker codebase into a small, safely operated service rather
than expanding it into a broad product. It preserves the existing Next.js and Supabase architecture,
closes the production boundary, makes the first teacher and student journeys operationally complete,
and produces evidence that the exact hosted build is safe for real use.

The first release is intentionally operator-assisted. Teachers are provisioned by an operator,
students receive bounded start codes or exam links, and support or incident recovery is performed
through documented operator procedures. This is appropriate for the initial population and avoids
adding an unfinished self-service identity or billing system to the critical path.

## 2. Decisions and scope

### 2.1 Selected approach

Use a **release-first, provisioned-only architecture**:

1. Deploy one immutable application build identified by its Git SHA.
2. Keep all canonical and personally identifying data behind server-only Supabase gateways.
3. Provision teachers and pilot entitlements through an audited operator path.
4. Let teachers batch-provision up to 100 student start codes and export them once as CSV.
5. Complete only the teacher-create/distribute/monitor/review and student-enter/solve/submit/review
   journeys.
6. Keep live payment unavailable while implementing a complete provider-neutral persistence and API
   boundary that a future adapter can connect to without changing entitlement semantics.
7. Promote only the exact preview build that passed browser, database, load, observability, and
   recovery gates.

### 2.2 Alternatives rejected

**Self-service-first** was rejected because signup, email confirmation, password recovery, billing,
and support escalation would all become release-critical at once. The existing delivery provider is
not production-proven.

**Infrastructure-first replatforming** was rejected because Redis, Kafka, Kubernetes, microservices,
or a second data store do not improve the initial 100-user outcome enough to justify their new
failure modes. PostgreSQL is the durable coordination layer for this release.

### 2.3 Included

- Browser web operation on supported desktop and mobile viewport sizes.
- Operator provisioning of organizations, teachers, and time-bounded pilot plan grants.
- Teacher roster management and atomic batch start-code issuance for up to 100 students.
- Exam creation, publication, invite distribution, active-invite status, and safe reissue.
- Student start-code or invite entry, assignment status, solving, autosave, exact submission,
  results, questions, and plain-text feedback.
- Teacher live progress, results, review, feedback, bounded statistics, and CSV exports already
  necessary for the core workflow.
- Server-only production boundary, readiness, logging, rate limiting, backup/restore, storage
  cleanup, capacity verification, and release evidence.
- Provider-neutral billing storage, webhook normalization, ordering, idempotency, and a fake adapter.

### 2.4 Excluded

- Real checkout, charges, refunds, invoices, payment-provider credentials, and provider-specific UI.
- Public teacher self-signup until delivery and abuse-handling evidence exists.
- Kakao, web push, email campaigns, or other notification delivery providers.
- Advanced analytics, AI recommendations, multi-teacher collaboration, SSO, custom domains,
  native packaging, PWA installation, Electron, and Capacitor.
- A new distributed cache, queue, event bus, container platform, or service decomposition.

Excluded features must not appear enabled. Their entry points are either hidden or visibly disabled
with an honest explanation.

## 3. System architecture

### 3.1 Release identity and runtime

The repository, CI runner, preview deployment, production deployment, readiness payload, and release
evidence all use one Git SHA. Node.js 22.13 or newer is the minimum runtime everywhere because that is
the package contract. CI cannot use Node.js 20 while the package declares Node.js 22.13.

Production is promoted from a verified immutable preview rather than rebuilt from an ambiguous
branch tip. Health responses expose only liveness, build SHA, and server time. Authenticated readiness
proves database boundary, required configuration, central event delivery, and critical job status.

### 3.2 Canonical data plane

Supabase/PostgreSQL remains the only canonical data plane. Browser code never receives a service-role
credential and never directly reads or writes canonical `omr_*` tables. Next.js Server Actions and
route handlers call focused server gateways. Each gateway:

- validates caller identity, organization, ownership, and resource state;
- applies a deterministic size or row bound;
- uses idempotency keys or expected revisions for mutations;
- returns a stable public result code instead of a database error;
- emits a redacted operational event with correlation and build identifiers.

All canonical application tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
`anon` and `authenticated` have no effective direct table, sequence, or function access to canonical
data. Only exact service-role RPC signatures required by server gateways remain executable. The
production boundary is applied by the migration owner after a preflight and is verified against an
exact table and RPC allowlist.

Private PDF and markup assets use the existing private Storage bucket. Browser uploads use short-lived
signed intents; finalize verifies owner, path, declared metadata, Storage metadata, size, MIME, and PDF
magic. Replaced, expired, or orphaned objects enter a durable lease-based cleanup queue before deletion.

### 3.3 Identity and sessions

The initial release operates in `provisioned_only` teacher identity mode:

- signup and reset actions that cannot deliver a message are not presented as functioning features;
- an operator atomically creates or reconciles an organization, teacher identity, password verifier,
  and pilot grant;
- the operation is idempotent, records an actor and reason, and never logs a raw password;
- teacher and student sessions have versioned generations so revocation invalidates prior cookies;
- session TTL, clock skew, cookie flags, and production secret strength are bounded and readiness-tested.

Teacher passwords and student start codes are stored only as slow or keyed verifiers appropriate to
their threat model. Plaintext credentials are returned only at the one-time issuance boundary and are
never recoverable from application storage or operational events.

### 3.4 Core workflow

The supported teacher journey is:

1. Operator provisions a teacher and pilot entitlement.
2. Teacher signs in and sees a truthful loading, empty, data, degraded-cache, or error state.
3. Teacher creates or imports a roster and selects at most 100 students.
4. Teacher issues start codes atomically and downloads a one-time CSV.
5. Teacher creates a draft exam, publishes it, and issues a group or targeted invite.
6. Teacher can later see whether an invite is active, its target, issue time, and expiry. The raw URL
   is copied only when still available in the current secure client context. Reissuing explicitly
   invalidates the prior invite and warns that an old QR or link will stop working.
7. Teacher monitors live progress and reviews exactly one canonical submission per attempt.
8. Teacher publishes plain-text feedback and exports bounded core results.

The supported student journey is:

1. Student enters a start code or opens an opaque invite link.
2. Student sees assignments labelled `scheduled`, `open`, or `closed`, including opening and closing
   times when present.
3. Student opens an allowed exam and creates or resumes a server-owned attempt draft.
4. Autosave uses revision-aware reconciliation. A second device cannot silently overwrite a newer
   revision.
5. Submission is idempotent and atomic. Concurrent requests create one canonical attempt closure and
   one result set.
6. Student sees the result, questions, and teacher plain-text feedback according to the exam release
   policy.

Guest or local-only recovery, if retained outside production, is explicitly labelled device-only and
does not masquerade as canonical cross-device persistence.

## 4. Bounded components

Each unit has one responsibility and a narrow contract.

### 4.1 Initial operations policy

Defines the 100-active-user limit, page sizes, maximum lists, request timeouts, upload budgets, rate
limits, and operator batch ceilings. Exceeding a ceiling returns `capacity_exceeded`; it never silently
truncates a canonical view.

### 4.2 Operator provisioning gateway

Accepts a normalized organization request, teacher email, initial credential material, pilot grant
expiry, actor, reason, and idempotency key. In one database transaction it reconciles the organization,
creates or updates the teacher identity, increments the intended session generation when required,
applies the grant, and appends an audit event. It returns generated secrets once and otherwise returns
only identifiers safe for the operator.

### 4.3 Student code batch gateway

Accepts one organization-scoped set of unique student IDs of length 1–100. It validates ownership and
active-student capacity, issues every code or none, stores only verifiers, advances affected session
generations when rotating, and records a non-secret audit summary. The client immediately converts the
one-time result into a UTF-8 BOM CSV suitable for Korean spreadsheet software and clears secret state
when the dialog closes or navigation occurs.

### 4.4 Invite lifecycle gateway

Stores a hash of the opaque invite token plus exam, organization, target type, target identifier,
issued time, expiry, revocation time, and generation. The server can report metadata but cannot recover
the raw link. Client copy UI therefore distinguishes `copyable_here`, `active_but_raw_unavailable`,
`expired`, and `revoked`. Reissue is a transactional rotate operation.

### 4.5 Load-state contract

Canonical screens use one explicit state model:

- `loading`
- `loaded_empty`
- `loaded_data`
- `degraded_with_cache`
- `error_without_cache`

A failed backend read never becomes an empty organization, roster, assignment list, or result list.
Retry is explicit and stale data is visibly labelled.

### 4.6 Attempt and submission gateway

Owns draft open, heartbeat, revisioned save, resume, final submit, force-finish, and receipt lookup.
Database constraints and transaction locking make canonical closure exactly once. Client outboxes may
retry with the same idempotency key but cannot manufacture a second result.

### 4.7 Operational event sink

Accepts a stable event name, safe context allowlist, correlation ID, build SHA, severity, and timestamp.
Unknown context fields are dropped. Credentials, cookies, tokens, names, emails, answers, raw request
bodies, PDFs, and database errors are never emitted. Transport retries only bounded transient failures
with the same event ID. A failing sink degrades readiness and alerts; it does not corrupt the user
transaction.

### 4.8 Billing connection boundary

The release contains provider-neutral canonical records:

- `omr_billing_checkout_intents`
- `omr_billing_customers`
- `omr_billing_subscriptions`
- `omr_billing_webhook_events` with unique `(provider, event_id)`

An atomic `omr_apply_billing_event_v1` operation records an event, enforces ordering, reconciles the
subscription, and changes organization entitlement once. Stored webhook data is normalized and
hashed; long-lived raw provider payloads or unnecessary PII are not retained.

A same-origin checkout endpoint and a bounded raw-body webhook endpoint depend on a server-only
adapter interface and price catalog. With no real adapter configured, checkout returns a stable 503
disabled response, webhook routes reject unknown providers, and the canonical plan cannot change.
Tests use a fake adapter to prove duplicates, concurrent delivery, out-of-order events, cancellation,
and replay behavior. Implementing Stripe or another real provider is outside this release.

## 5. Error and security model

Public operations return one of these stable codes:

- `invalid_input`
- `unauthenticated`
- `forbidden`
- `not_found`
- `conflict`
- `expired`
- `capacity_exceeded`
- `dependency_unavailable`

HTTP and Server Action details may map these codes to appropriate status values, but callers do not
branch on database messages. User-facing copy explains the next safe action and never exposes secrets.

Production failures fail closed when identity, tenant authorization, durable rate limiting, canonical
storage, or entitlement state cannot be proven. Non-critical observability transport failure is
reported as degraded readiness rather than rolling back an already committed user mutation.

Rate-limit keys are keyed hashes of normalized identifiers and scopes. The database atomically counts
shared budgets across server instances. Expired counters are cleaned in bounded batches. Login, start
code, exam PIN, invite, upload admission, AI, readiness, and operator provisioning have separate named
policies.

## 6. Operations and deployment

### 6.1 Pre-production sequence

1. Align Node.js 22.13+ in package metadata, CI, local verification, and hosting settings.
2. Build an immutable preview for one Git SHA.
3. Provision an isolated staging Supabase project using the exact schema, sorted migrations, and
   production server boundary as one migration owner.
4. Configure production-shaped secrets, central event sink, alert receiver, and cleanup scheduler.
5. Provision disposable teacher/student fixtures through the same operator path used for launch.
6. Run static checks, unit tests, live PostgreSQL contracts, browser suites, flaky-repeat gates,
   accessibility checks, the 100-user workload, and the restore drill.
7. Produce a signed release-evidence artifact tied to the preview SHA and target project.

### 6.2 Production promotion

1. Enter maintenance mode and stop scheduled cleanup claims.
2. Create a recoverable database and private-object backup.
3. Run boundary preflight; any non-zero orphan, missing tenant, cross-tenant, or credential defect
   aborts the release.
4. Apply sorted migrations and the production boundary using the same owner.
5. Verify live database contracts and negative `anon`/`authenticated` access probes.
6. Promote the exact verified preview without rebuilding.
7. Verify public health, authenticated readiness, build SHA, operator login, one teacher journey, and
   one student journey with disposable data.
8. Resume writes and cleanup jobs only after all checks pass.

If a gate fails, keep writes paused, retain the evidence, and roll back the application build first.
Never reopen canonical browser CRUD as a rollback shortcut.

### 6.3 Service objectives and alerts

Initial objectives are:

- monthly availability: at least 99.5%;
- canonical submission success: at least 99.9%;
- canonical read p95: below 750 ms in the staging workload;
- submit RPC p95: below 1.5 s, excluding client upload;
- end-to-end submit p99: below 9 s;
- sampled database query: at most 500 ms;
- staging qualification 5xx: zero.

Alerts cover three consecutive liveness failures, readiness not `ready`, readiness degraded,
submission 5xx above 1%, latency budget breach, dead cleanup jobs, cleanup heartbeat absent for more
than 30 hours, unusual rate-limit spikes, and backup age beyond the 60-minute recovery-point target.

### 6.4 Backup and restore

The recovery-point objective is 60 minutes and the recovery-time objective is 120 minutes. A valid
backup includes canonical database data, schema identity, private-object manifests and bodies, object
SHA-256 values, and the secret/configuration inventory needed to reconstruct service behavior.

Restore evidence is created only in an isolated non-production project. It compares the exact canonical
table allowlist and row counts, verifies every restored object body hash, runs live database contracts,
and completes disposable teacher/student browser smoke tests. A `.COMPLETE` marker is written only
after all comparisons and the RPO/RTO checks pass.

## 7. Verification and scoring

### 7.1 Ten scoring dimensions

Each dimension is scored from binary, dated evidence. The arithmetic release gate is mean ≥9.3 and
minimum ≥8.7, but any hard gate below is a release failure regardless of the mean.

| # | Dimension | Required proof |
|---|---|---|
| 1 | Student core journey | Fresh-context entry, state-labelled assignment, autosave/resume, exact submit, result/question/feedback browser proof |
| 2 | Teacher core journey | Login, truthful load states, roster, create/publish/distribute, live, review/feedback/export browser proof |
| 3 | Provisioning and entitlement | Atomic operator provision, 1–100 batch codes, one-time CSV, revocation, audited pilot grant contracts |
| 4 | Data integrity and isolation | PostgreSQL 17 live contracts, FORCE RLS allowlist, negative direct access, cross-tenant denial, concurrency tests |
| 5 | Code and supply chain | Lint, typecheck, unit suite, production build, route budgets, supported Node, zero high/critical production audit findings |
| 6 | Browser determinism | Full Chromium suite 10 consecutive runs with one worker and no retries; known order group 20 consecutive runs; no core quarantine |
| 7 | UX, accessibility, responsiveness | Keyboard, focus, labels, reduced motion, mobile/desktop core screens, and explicit error/empty/degraded states |
| 8 | Hosted deployment | Exact SHA, health/readiness, security headers, compression, negative access probes, and disposable hosted journeys |
| 9 | Capacity and observability | 100-user workload budgets, sink delivery, alert test, GC heartbeat, bounded queues/lists, and no PII events |
| 10 | Recovery and release | Backup freshness, isolated restore within RPO/RTO, verified object bodies, promotion and rollback evidence |

### 7.2 Hard release failures

- Any core E2E failure, retry-only pass, or demonstrated order dependence.
- Health or readiness returns 404, reports a different SHA, is degraded, or is not ready.
- The production boundary or tenant isolation is unverified.
- The 100-user staging workload has no dated evidence.
- Data loss, duplicate canonical submission, cross-user exposure, or cross-tenant exposure.
- Plaintext production passwords or start codes stored after issuance.
- Credentials, tokens, student PII, answers, or raw provider payloads in logs.
- No working central sink, alert path, or cleanup heartbeat.
- Restore failure or unproven 60-minute RPO / 120-minute RTO.
- High or critical production dependency vulnerability.
- Unexplained test skip, missing credential treated as pass, or wrong-SHA evidence.

### 7.3 Required local and live commands

At minimum, evidence records the output of:

```sh
npm ci
npm audit --package-lock-only --omit=dev --audit-level=high
node scripts/verify-desktop-dependency-audit.mjs
npm run lint
npx tsc --noEmit
npm test
npm run test:supabase:live
npm run build
```

It also records the full Chromium repetition gate, WebKit core journey, production-mode E2E,
`test:ops:initial`, hosted readiness workflow, 100-user workload, sink/alert exercise, and isolated
backup/restore drill. Missing external credentials or infrastructure yields `unverified` and a failed
gate, never a skipped success.

### 7.4 Evidence freshness

- Dependency, source, unit, and browser evidence expires after 24 hours or any relevant source change.
- Hosted evidence expires whenever the application, database, environment, or infrastructure changes.
- Restore evidence expires after 30 days or any schema, backup, or storage-layout change.

## 8. Current baseline and required closure

The audited source already has strong server gateways, durable rate limiting, idempotent submission,
private Storage cleanup, health/readiness routes, an operational sink, backup/restore scripts, and a
large passing unit suite. Those strengths are retained and verified instead of replaced.

The release is currently **NO-GO** because:

1. The repository states that the production business-data policy is alpha/open until the server
   boundary is manually applied and proven.
2. The public deployment returns 404 for source-defined `/api/healthz` and `/api/readyz`, proving the
   hosted build does not match the audited source.
3. CI uses Node.js 20 while the package requires Node.js 22.13 or newer.
4. Full Chromium has two stale assertions and one order-sensitive reduced-motion failure, so browser
   determinism is not yet proven.
5. There is no retained, dated 100-user load, sink/alert, or isolated restore artifact.
6. Batch student provisioning, persistent invite metadata UX, explicit assignment states, truthful
   load-state handling, student session revocation, and audited pilot granting are incomplete.
7. Billing has a disabled provider interface but not the complete durable provider-neutral boundary.

Implementation is complete only when each gap is closed in source and the corresponding exact-SHA
evidence passes. A local green unit suite alone cannot change the release decision.

## 9. Implementation decomposition

The design is executed as independently testable slices, each using test-driven changes and its own
review checkpoint:

1. Release identity, runtime, CI, and evidence schema.
2. Production boundary and canonical schema drift elimination.
3. Operator provisioning, session generations, and pilot entitlement.
4. Atomic student-code batch issuance and one-time CSV UX.
5. Invite lifecycle metadata and assignment-state UX.
6. Truthful canonical load states across core screens.
7. Operational events, health/readiness, alerts, and cleanup heartbeat.
8. Provider-neutral billing persistence and disabled endpoints.
9. Browser determinism and accessibility closure.
10. Staging load, backup/restore, immutable promotion, and final score audit.

Slices that share migrations or central contracts are implemented sequentially. Read-only audits and
independent verification may run in parallel. The final hosted and recovery gates remain explicitly
external: code can prepare them, but they pass only with evidence from the actual target environment.
