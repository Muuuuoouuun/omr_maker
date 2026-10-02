# Secure Submission Outbox Implementation Plan

1. Add failing unit tests for immutable queueing, owner scoping, size/count/total limits, TTL cleanup, replay outcomes, and concurrent replay serialization.
2. Implement a dedicated IndexedDB outbox and injectable in-memory-compatible store contract.
3. Add the idempotent final-checkpoint migration and regression contract tests.
4. Route secure solve submission through persist-before-send replay and add queued/blocked overlay states plus manual retry.
5. Add automatic replay to `SyncFlusher` for boot, online, visibility, and session changes.
6. Run focused tests, lint, typecheck, build, broader tests, and browser smoke verification where the environment permits.
