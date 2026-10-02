# Secure Submission Outbox Design

## Goal

Make secure durable exam submission survive offline failures and app restarts without putting answer payloads, tickets, names, PDFs, handwriting, or lease credentials in localStorage, logs, or the DOM.

## Design

- Persist one immutable submission snapshot per durable attempt session in a dedicated IndexedDB database before the first final-checkpoint request.
- Bind records to a SHA-256 fingerprint of the current signed-session owner. The raw owner id is not persisted in the outbox.
- Store only final answers, sub-question answers, minimal integrity telemetry, the durable session CAS coordinates, and its lease token.
- Reject records over 512 KiB, more than five live records, or more than 2 MiB total. Never evict a live record to make room. Records expire after 24 hours; cleanup reports every discarded expired or malformed record.
- Serialize replay across tabs. Automatic replay runs only for the active owner on boot, online recovery, visibility recovery, and session change. It never performs lease takeover.
- Replay final-checkpoints the immutable snapshot, persists the returned revision as a non-payload cursor, then calls the existing durable submit action. A submitted response (including the server's already-submitted canonical receipt) deletes the record.
- Revision, lease, expiry, authentication, ownership, and validation failures become blocked/manual states. Retryable network/service failures remain queued.
- The solve overlay shows queued or blocked state and provides a manual retry. No lease token is dispatched in events or rendered.

## Server idempotency

The final-checkpoint RPC accepts an exact replay of the immediately preceding final checkpoint when the session fencing token is unchanged. It also permits an expired lease token only for a final checkpoint when its epoch and token still match; a takeover changes those values and therefore remains fail-closed. Submitted sessions are returned without mutation so the existing submit service can return the canonical receipt.

## Residual security boundary

IndexedDB removes answer payloads and capabilities from localStorage and ordinary storage-event surfaces. It is not a defense against same-origin script compromise or a fully compromised device; those actors can already act as the signed-in browser session.
