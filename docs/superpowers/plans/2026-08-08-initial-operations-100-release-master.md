# Initial Operations for 100 Users Release Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify one immutable browser deployment for at most 100 active users with a mean evidence score of at least 9.3/10, no dimension below 8.7/10, no live payments, and no open hard release gate.

**Architecture:** Preserve the existing Next.js server boundary and Supabase canonical data plane. Execute five bounded plans in dependency order, with release identity first, canonical identity and roster second, core distribution UX third, the disabled provider-neutral billing seam fourth, and exact-SHA qualification last. Every mutation slice uses PostgreSQL transactions, stable public errors, redacted events, and TDD.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase/PostgreSQL 17, Vitest, Playwright, GitHub Actions, Vercel-compatible immutable deployment.

---

## Authoritative design

The approved specification is
`docs/superpowers/specs/2026-08-08-initial-operations-100-release-design.md`.
The older `docs/superpowers/plans/2026-08-06-initial-operations-100.md` remains historical context;
where it differs, this master plan and the approved specification win.

## Execution plans

1. `docs/superpowers/plans/2026-08-08-release-runtime-operations.md`
   - Node/runtime alignment, exact-SHA verification, canonical table manifest, provisioned-only
     readiness, redacted correlation/severity, job heartbeat and alert exercise.
2. `docs/superpowers/plans/2026-08-08-provisioned-identity-roster.md`
   - Atomic operator provisioning, pilot grant audit, student session generation, 1–100 atomic start
     code issuance, and one-time CSV.
3. `docs/superpowers/plans/2026-08-08-core-distribution-load-states.md`
   - Invite metadata, honest raw-link capability, assignment lifecycle, and truthful canonical load
     states.
4. `docs/superpowers/plans/2026-08-08-billing-connection-boundary.md`
   - Provider-neutral billing persistence, price catalog, atomic webhook apply, disabled HTTP routes,
     and fake adapter tests. No real payment provider is connected.
5. `docs/superpowers/plans/2026-08-08-release-qualification.md`
   - Deterministic browser repair, quality manifest, staging load, alert drill, isolated restore,
     immutable promotion, hosted verification, and final score audit.

## Dependency graph

```text
runtime/SHA ─────────────┬───────────────┐
                        │               │
operator provisioning ──┼─> session generation ─> credential batch
                        │
                        ├─> invite lifecycle ─> assignment/load-state UI
                        │
                        └─> billing boundary (still disabled)

all source slices ─> browser determinism ─> staging load/restore ─> immutable promotion ─> hosted score
```

## Controller rules

- [ ] Run only one implementation subagent at a time because all agents share the same worktree.
- [ ] Give each implementer the complete task text and require `superpowers:test-driven-development`.
- [ ] Require the implementer to run RED, implement the minimum complete behavior, run GREEN, run
      adjacent regression tests, self-review, and commit only its scoped files.
- [ ] After each implementation commit, dispatch a fresh spec-compliance reviewer.
- [ ] Resolve every spec finding and obtain a second spec approval before code-quality review.
- [ ] Dispatch a fresh code-quality reviewer and resolve every important issue before the next task.
- [ ] Preserve live checkout as disabled. Any test or implementation that changes an organization plan
      from browser intent without a verified server event fails the plan.
- [ ] Treat absent external credentials as `unverified` and a failed release gate, never as a pass.
- [ ] Keep real student data prohibited until exact production boundary and hosted evidence pass.

## Commit sequence

Use these commit prefixes so evidence can map source slices to SHA history:

```text
fix(ci): align initial operations runtime
feat(ops): bind release evidence to immutable build
feat(identity): add provisioned-only teacher operations
feat(students): revoke sessions on credential rotation
feat(roster): issue student codes atomically
feat(invites): expose safe invite lifecycle metadata
feat(assignments): show canonical assignment lifecycle
fix(ui): distinguish empty cached and failed loads
feat(billing): add disabled durable provider seam
fix(e2e): remove core browser nondeterminism
feat(release): seal initial operations evidence
```

## Local completion gate

- [ ] Run `npm ci` in the implementation worktree.
- [ ] Run `npm audit --package-lock-only --omit=dev --audit-level=high` and require zero high/critical
      production findings.
- [ ] Run `node scripts/verify-desktop-dependency-audit.mjs`.
- [ ] Run `npm run lint`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:supabase:live` against PostgreSQL 17.
- [ ] Run `npm run build` and require every route budget to pass.
- [ ] Run the exact browser repetition commands in the qualification plan with retries disabled.

Expected local result: every command exits 0, Chromium passes ten consecutive full runs, and the
reduced-motion order group passes twenty consecutive repetitions.

## External completion gate

- [ ] Produce an immutable preview tied to the final 40-character SHA.
- [ ] Apply schema, sorted migrations, and the production boundary to isolated staging as one owner.
- [ ] Complete the exact 80-student + 10-poller + 10-uploader workload within every latency and error
      budget.
- [ ] Exercise sink receipt, alert receipt, acknowledgement, and resolution with one unique event ID.
- [ ] Create a production-shaped backup and restore it into a separate staging project within RPO 60
      minutes and RTO 120 minutes, including all object-body SHA comparisons.
- [ ] Promote the qualified preview without rebuilding.
- [ ] Verify hosted health/readiness exact SHA, negative browser data-plane probes, and disposable
      teacher/student core journeys.
- [ ] Generate a machine-readable score manifest with mean ≥9.3, minimum ≥8.7, and zero hard gates.

Expected external result: a sealed evidence directory for the exact production SHA. Until it exists,
the release remains NO-GO even when all source and local tests are green.
