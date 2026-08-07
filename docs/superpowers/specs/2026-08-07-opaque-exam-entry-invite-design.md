# Opaque Exam Entry Invite Design

## Goal

Make a group-restricted exam share link work on a new browser without exposing or trusting a stable workspace identifier. The link carries only an opaque 32-byte token. Every directory, login, and exam-read boundary resolves the token on the server and fails closed for expiry, revocation, exam mismatch, group mismatch, or organization mismatch.

## Chosen architecture

Use a stateful invite registry in Postgres. Only `sha256(token)` is stored. A teacher-only rotation RPC verifies active organization membership and exam ownership, revokes the prior active token for that exam, and inserts one bounded-lifetime replacement. A service-role-only resolution RPC atomically checks the token hash, exam, organization, expiry, revocation state, current exam access mode, and current allowed groups.

The browser receives `/solve/<exam>#invite=<opaque-token>`, so the bearer never reaches the initial HTTP request, access log, or referrer. On first mount the solve client validates it, stores an exam-bound handoff in tab-scoped `sessionStorage`, and immediately scrubs the fragment with `history.replaceState`. The login URL carries no bearer. Directory, login, and exam-open actions independently re-resolve the tab handoff; successful login binds the resolved organization and selected allowed group into the signed HttpOnly student session. The browser never receives the resolved organization id.

## Data and security contract

- Token: 32 cryptographically random bytes, base64url encoded; maximum accepted length 64 characters.
- Stored identifier: lowercase 64-character SHA-256 hex only.
- Scope: exactly one organization and exam, plus the current group ids captured from the canonical exam.
- Lifetime: server-selected default 30 days, hard maximum 90 days, minimum 15 minutes.
- Rotation/cap: issuing a new token revokes all prior active tokens for the same organization and exam; at most one active token remains.
- Database access: table has FORCE RLS and no browser grants. Only purpose-scoped service-role RPCs may rotate or resolve.
- Logging: token and token hash are never included in errors, operational events, analytics, or response payloads.
- Resolution: returns organization id only inside the server gateway. Public action results contain status and bounded group display data, never organization id or token hash.
- Fail closed: invalid shape, unknown hash, expiry, revocation, archived exam, non-group exam, empty targets, exam mismatch, cross-organization group rows, and inactive groups all reject.

## User flow

1. Teacher saves a canonical group exam.
2. The teacher server action rotates the exam invite and returns the raw token once.
3. The client builds a public share URL with `invite`; it does not append `workspace`, `organizationId`, or raw group ids.
4. A new browser opens the URL. The solve page uses the invite for a safe server preview.
5. If login is required, the login URL preserves the non-secret solve query while the bounded handoff stays in the same tab only.
6. The student login page loads only the invited exam's active target groups.
7. Login re-resolves the invite and verifies the roster identity and start code inside the resolved organization/group.
8. The signed student cookie receives the server-resolved organization and group. The handoff is bound to that student account, and redirect returns to the scrubbed solve URL with its non-secret query intact.
9. Exam open revalidates the signed identity against the canonical exam. An expired or revoked invite cannot establish a new session; existing signed sessions remain governed by their normal expiry and exam access checks.

## Compatibility

Local development without the production database may retain the existing local-only fallback. Production must not accept a raw `workspace` query as authority. The generic roster invite surface stops emitting raw workspace ids and directs teachers to issue exam-scoped links from the distribution flow.

## Verification

- Unit tests cover token shape/hash, bounded TTL, sanitized gateway results, fragment scrubbing, tab/exam/account binding, expiry deletion, query preservation, and no raw organization leakage.
- Gateway/action tests cover teacher ownership, rotation, expiry/revocation, exam mismatch, group restriction, and signed-cookie binding.
- Contract tests cover FORCE RLS, grants, function search paths, readiness version/key, rollback, and production profile.
- PostgreSQL 17 live assertions execute rotation/resolution and prove tampered, expired, revoked, cross-exam, cross-organization, and inactive-group rejection.
