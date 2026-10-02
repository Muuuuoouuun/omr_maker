# Student Handwriting Upload Recovery Design

## Goal

After an official student answer submission is confirmed, preserve a failed premium-handwriting upload on the same device and give the owning student an explicit, bounded retry flow. The result page must show progress, success, and failure without exposing handwriting, signed tickets, names, answers, or other private data in Web Storage.

## Durable client boundary

- Persist the handwriting JSON only in IndexedDB under one deterministic key per attempt.
- Reject payloads above the existing 10 MiB server limit before creating recovery state.
- Store a versioned localStorage manifest containing only bounded identifiers (`attemptId`, `sessionId`, `ownerKey`), the IndexedDB reference, timestamps, retry count, next retry time, and a sanitized failure category.
- The handwriting upload action accepts only the submitted `sessionId`, exact `attemptId`, and drawings; its unused client `ticket` input is removed. Never store an attachment ticket, signed URL, raw handwriting, student name, answers, or server error text in the manifest.
- Bind recovery to a non-secret owner fingerprint derived from the current student session identity and organization scope. A missing or mismatched owner hides the card and cannot invoke upload.
- Keep at most one manifest and one IndexedDB source per attempt. Expire both after seven days. Success, expiry, invalid source, and `invalid_asset` delete local recovery data. Authentication/session and service failures remain blocked/retryable until success or TTL expiry.
- Create recovery state only after the server has returned an immutable successful submission receipt.

## Retry state machine

The review page restores a valid pending manifest for its exact attempt. The card has `pending`, `waiting`, `uploading`, `succeeded`, and `failed` presentations announced through an ARIA live region. The retry control is at least 44 px high and fills the card width on narrow mobile layouts.

One explicit click starts at most three attempts. Retryable service/transport failures use bounded delays of 0, 750, and 2,000 ms. `invalid_ticket` stops the current click but retains the owner-bound source for retry after session recovery; `invalid_asset` is terminal. A module-level in-flight map coalesces duplicate clicks for the same attempt, while the component disables its button. After success, local recovery data is deleted and the review attempt is reloaded so the archived-handwriting state is authoritative.

## Server and privacy boundaries

The existing `uploadStudentAttemptHandwriting` action remains the only client entry point. It revalidates same-origin, signed student identity, organization, owner student ID, submitted session, attempt ID, plan, asset metadata, and service-role-only RPC access. Existing prepare/attach/discard functions and the private bucket cleanup queue remain unchanged; retries replay that server idempotency boundary rather than adding a public storage path.

## Verification

- Pure unit tests: schema validation, owner mismatch, TTL, maximum bytes, sanitized failure categories, bounded backoff, terminal failure, and in-flight coalescing.
- Integration/surface tests: recovery state is created only after confirmed submission, draft cleanup waits for upload success, and the review card exposes explicit progress/success/failure copy.
- Existing server gateway tests continue to prove immutable reservation reuse and failed-reservation cleanup.
- Rendered QA covers phone and tablet widths, button target size, readable wrapping, keyboard focus, and no relevant console errors.
