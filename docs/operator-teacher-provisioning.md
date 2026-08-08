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

Run:

```sh
npm run ops:teacher:provision -- --request=/absolute/owner-only/request.json
```

Before the database call, the command atomically persists a `0600` pending journal containing the
new initial password, its exact PBKDF2 verifier, the idempotency key, and an integrity-bound request
fingerprint. If the database response is uncertain, rerun the identical request: the same password,
verifier, and key are reused. Do not edit, copy, link, or rename pending state.

After a confirmed first apply or exact database replay, the command atomically creates
`<credentialStatePath>.receipt`, verifies directory durability, and removes the pending journal. It
prints only the receipt path, opaque organization/account/grant IDs, and expiry. Errors contain only
an allowlisted code; database messages and credential material are never printed.

The receipt is owner-owned `0600` and contains the one-time initial password. Hand it to the intended
teacher through an approved secure channel, confirm successful login, and then securely archive it
under the organization's credential-retention policy or delete it. Never paste it into tickets,
chat, shell history, CI logs, or application configuration.

## Required Phase B before pilot release

This phase only provides the atomic RPC gateway and crash-safe operator credential handoff. It does
not complete the provisioned login journey. A pilot release remains blocked until a later migration
and server integration bind account login to the provisioned organization and owner membership,
permit the canonical `pilot_org_<24 hex>` workspace identifier, and resolve every paid-feature check
through `omr_read_effective_workspace_plan_v1`. That integration must include live PostgreSQL apply,
replay, login, expiry, session, and paid-feature tests; this command alone is not evidence that the
journey is connected.
