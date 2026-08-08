# Operator teacher provisioning

This command is a POSIX-only, operator-controlled bootstrap boundary for macOS and Linux. It does
not support Windows and fails closed when owner IDs, `O_NOFOLLOW`, regular-file identity, hard-link
counts, or directory durability cannot be verified.

## Prepare the request

Create an owner-only directory (`0700`) whose entire path has no group/world-writable ancestor, then
create an absolute, owner-owned regular JSON file with mode `0600`. The request has exactly these
fields and must contain no password or encoded verifier:

```json
{
  "organizationName": "서울 파일럿",
  "email": "teacher@example.com",
  "displayName": "김교사",
  "plan": "pro",
  "expiresAt": "2026-09-08T00:00:00.000Z",
  "actor": "operator:launch",
  "reason": "initial_pilot",
  "idempotencyKey": "prov_REPLACE_WITH_AT_LEAST_32_RANDOM_URLSAFE_CHARS",
  "credentialStatePath": "/absolute/owner-only/credentials/pilot.state.json"
}
```

The `credentialStatePath` parent must also be owner-owned `0700`, canonical, and free of writable or
symbolic-link path components. Both the request and credential paths are bounded and race-checked.
Paths containing terminal controls, line separators, or newlines are rejected before filesystem access.

`SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) must be the exact HTTPS origin root, for example
`https://project.supabase.co/`: user info, a non-root path, query, fragment, and HTTP are rejected.
The service-role transport refuses cross-origin requests and all redirects, enforces one ten-second
deadline through response-body completion, and rejects declared or streamed bodies over 64 KiB.
The RPC response must be one exact allowlisted JSON object; extra or multiple envelopes fail closed.

Run:

```sh
npm run ops:teacher:provision -- --request=/absolute/owner-only/request.json
```

Before the database call, the command atomically persists a `0600` pending journal containing the
new initial password, its exact PBKDF2 verifier, the idempotency key, and an integrity-bound request
fingerprint. If the database response is uncertain, rerun the identical request: the same password,
verifier, and key are reused. Do not edit, copy, link, or rename pending state.

The `integrity` values in pending state and the receipt are unkeyed, domain-separated corruption
checks. They detect accidental edits; they are not authenticity proofs against another process
running as the same operating-system UID. A trusted, exclusive operator UID is therefore part of
this command's threat model. Request/idempotency bindings remain only inside owner-only `0600`
credential files and are never printed or returned by the provisioning RPC.

After a confirmed first apply or exact database replay, the command atomically creates
`<credentialStatePath>.receipt`, verifies directory durability, and removes the pending journal. It
prints only the receipt path, opaque organization/account/grant IDs, and expiry. Errors contain only
an allowlisted code; database messages and credential material are never printed.

The receipt is owner-owned `0600` and contains the one-time initial password. Hand it to the intended
teacher through an approved secure channel, confirm successful login, and then securely archive it
under the organization's credential-retention policy or delete it. Never paste it into tickets,
chat, shell history, CI logs, or application configuration.

## Stale lock recovery

Lock creation uses a fully written and fsynced owner-only temporary file, an exclusive hard-link
publication, and directory fsyncs before and after removing the temporary name. A later run repairs
an interrupted two-link publication and removes a structurally valid lock only after its recorded
PID is no longer alive. A live or PID-reused lock is refused, and malformed/ambiguous lock state is
never deleted automatically.

For malformed state, stop every provisioning process first. The operator must verify that the exact
`<credentialStatePath>.lock` or matching `.<lock-name>.<32 hex>.tmp` path is inside the already
validated owner-only `0700` directory, is a regular non-symlink file owned by the operator, has mode
`0600` and link count one, and has not changed device/inode since inspection. Only then may that exact
inode be unlinked and the directory synced before retry. If any prerequisite, PID ownership, or inode
identity is uncertain, preserve the file and escalate; never use a wildcard deletion.

## Phase B login bridge (implemented in migration 202608080007)

Migration `202608080007_provisioned_teacher_login.sql` and the server gateway now bind login and every
protected account request to one exact active owner membership, one matching active teacher profile,
the signed `pilot_org_<24 hex>` tenant, and the current effective grant. Expiry, supersession, account
generation, membership/profile drift, and forged `omr_organizations.plan` are exercised on PostgreSQL
17 and fail closed without workspace repair. Explicit nonproduction `self_service` uses the separate
signed `legacy_account` authority; provisioned `account` sessions never bootstrap.
Until trusted proxy provenance is attested, login also uses a shared 500-attempt/10-minute durable
PBKDF2 safety ceiling (100 launch users times five identifier attempts) in addition to the five-attempt
per-identifier bucket. It counts all attempts and success does not clear it. This avoids trusting raw
forwarding headers, but operators must monitor the shared ceiling for coordinated denial-of-service.

Phase C remains a release blocker: request validation/effective-plan reads and existing domain mutation
RPCs are separate transactions. Migration `202608080008` must add the account/organization/effective-
plan checks inside paid mutation and asset RPC transactions before the pilot can claim race-free paid
authorization. The current bridge provides fresh request-time denial, not transaction-atomic
authorization.
