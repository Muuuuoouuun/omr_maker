import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202608080010_student_start_code_batch.sql",
);

function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function migration(): string {
    return existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
}

describe("student start-code batch migration contract", () => {
    it("creates canonical RPC-only FORCE-RLS receipts without credential material", () => {
        const sql = migration();

        expect(sql).toContain("create table public.omr_student_credential_batch_receipts");
        expect(sql).toMatch(/alter table public\.omr_student_credential_batch_receipts\s+enable row level security/i);
        expect(sql).toMatch(/alter table public\.omr_student_credential_batch_receipts\s+force row level security/i);
        expect(sql).toMatch(
            /revoke all on table public\.omr_student_credential_batch_receipts\s+from public, anon, authenticated, service_role/i,
        );
        expect(sql).toContain("idempotency_key_hash");
        expect(sql).toContain("request_fingerprint");
        const receiptDdl = sql.match(
            /create table public\.omr_student_credential_batch_receipts\s*\(([\s\S]*?)\n\);/i,
        )?.[1] || "";
        expect(receiptDdl).not.toMatch(/\b(start_code|verifier|password|email|display_name|student_id)\b/i);
    });

    it("defines one exact service-role-only 1-100 batch gateway and retires the single-code bypass", () => {
        const sql = migration();
        const signature = "public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)";

        expect(sql).toContain("create function public.omr_issue_student_start_code_batch_v1(");
        expect(sql).toContain("p_session_authority text");
        expect(sql).toContain("p_account_id text");
        expect(sql).toContain("p_session_generation bigint");
        expect(sql).toContain("p_organization_id text");
        expect(sql).toContain("p_actor_user_id text");
        expect(sql).toContain("p_items jsonb");
        expect(sql).toContain("p_idempotency_key text");
        expect(sql).toMatch(/jsonb_array_length\(p_items\)\s*=\s*0[\s\S]+invalid_request/i);
        expect(sql).toMatch(/jsonb_array_length\(p_items\)\s*>\s*100[\s\S]+capacity_exceeded/i);
        expect(sql).toMatch(/revoke all on function public\.omr_issue_student_start_code_batch_v1\([^)]+\)\s+from public, anon, authenticated/i);
        expect(sql).toMatch(/grant execute on function public\.omr_issue_student_start_code_batch_v1\([^)]+\)\s+to service_role/i);
        expect(sql).toContain(`revoke all on function ${signature}`);
        expect(sql).toMatch(/revoke all on function public\.omr_rotate_student_start_credential_v1\([^)]+\)\s+from public, anon, authenticated, service_role/i);
        expect(sql).not.toMatch(/grant execute on function public\.omr_rotate_student_start_credential_v1\([^)]+\)\s+to service_role/i);
    });

    it("validates exact canonical items and hashes a high-entropy idempotency key", () => {
        const sql = migration();

        expect(sql).toMatch(/jsonb_typeof\(p_items\)\s+is distinct from 'array'/i);
        expect(sql).toMatch(/count\(\*\) from pg_catalog\.jsonb_object_keys\(element\)\)\s*=\s*2/i);
        expect(sql).toContain("studentId");
        expect(sql).toContain("verifier");
        expect(sql).toMatch(/count\(distinct[\s\S]*student_id/i);
        expect(sql).toMatch(/\^batch_\[A-Za-z0-9_-\]\{32,122\}\$/);
        const keyHash = sql.match(
            /v_idempotency_key_hash\s*:=\s*pg_catalog\.encode\(([\s\S]*?)\n\s*\);/i,
        )?.[1] || "";
        expect(keyHash).toContain("extensions.digest(p_idempotency_key, 'sha256')");
        const fingerprint = sql.match(
            /v_request_fingerprint\s*:=\s*pg_catalog\.encode\(([\s\S]*?)\n\s*\);/i,
        )?.[1] || "";
        expect(fingerprint).toContain("extensions.digest(");
        expect(fingerprint).toMatch(/p_session_authority[\s\S]+p_account_id[\s\S]+p_session_generation[\s\S]+p_organization_id[\s\S]+p_actor_user_id[\s\S]+studentIds[\s\S]+v_student_ids/i);
        expect(fingerprint).toContain("'studentCount', v_item_count");
        expect(fingerprint).not.toMatch(/verifier|v_canonical_items/i);
        expect(sql).toContain("^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$");
    });

    it("locks identity and receipt before sorted students, then rotates every generation atomically", () => {
        const sql = migration();
        const advisory = sql.indexOf("pg_advisory_xact_lock");
        const identity = sql.indexOf("omr_lock_teacher_mutation_identity_v1");
        const receipt = sql.indexOf("omr_student_credential_batch_receipts", identity);
        const profiles = sql.indexOf("from public.omr_student_profiles", receipt);
        const epochs = sql.indexOf("public.omr_student_credential_epochs", profiles);
        const credentials = sql.indexOf("public.omr_student_start_credentials", epochs);

        expect(advisory).toBeGreaterThan(-1);
        expect(identity).toBeGreaterThan(advisory);
        expect(receipt).toBeGreaterThan(identity);
        expect(profiles).toBeGreaterThan(receipt);
        expect(epochs).toBeGreaterThan(profiles);
        expect(credentials).toBeGreaterThan(epochs);
        expect(sql).toMatch(/from public\.omr_student_profiles[\s\S]+order by[\s\S]+for update/i);
        expect(sql).toContain('collate "C"');
        expect(sql).toMatch(/credential_generation\s*=\s*[^;]+credential_generation\s*\+\s*1/i);
        expect(sql).toContain("credential generation exhausted");
        expect(sql).toContain("student_unavailable");
    });

    it("authenticates before replay and distinguishes exact replay from conflict without replaying secrets", () => {
        const sql = migration();
        const identity = sql.indexOf("omr_lock_teacher_mutation_identity_v1");
        const replay = sql.indexOf("already_applied");

        expect(identity).toBeGreaterThan(-1);
        expect(replay).toBeGreaterThan(identity);
        expect(sql).toContain("idempotency_conflict");
        expect(sql).toContain("already_applied");
        expect(sql).toContain("'status', 'issued'");
        const returnedEnvelopes = [...sql.matchAll(/return\s+pg_catalog\.jsonb_build_object\(([\s\S]*?)\);/gi)]
            .map(match => match[1]);
        expect(returnedEnvelopes.length).toBeGreaterThan(0);
        expect(returnedEnvelopes.every(envelope => !/(startCode|verifier|idempotencyKey)/i.test(envelope))).toBe(true);
    });

    it("writes a redacted audit summary and leaves failure atomic", () => {
        const sql = migration();

        expect(sql).toContain("insert into public.omr_audit_logs");
        expect(sql).toContain("student_start_code_batch_issued");
        expect(sql).toContain("studentCount");
        const auditStart = sql.indexOf("insert into public.omr_audit_logs");
        const auditEnd = sql.indexOf("update public.omr_student_credential_batch_receipts", auditStart);
        const auditWrite = sql.slice(auditStart, auditEnd);
        expect(auditWrite).not.toMatch(/\b(verifier|idempotency_key|studentId|startCode)\b/i);
        expect(sql.trimStart().startsWith("begin;")).toBe(true);
        expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    });

    it("propagates exact 010 readiness, backup, boundary, rollback, and docs contracts", () => {
        const boundary = read("supabase/production-server-boundary.sql");
        const rollback = read("supabase/production-server-boundary-rollback.sql");
        const readiness = read("src/lib/supabaseReadinessProbe.ts");
        const docs = read("docs/production-readiness.md");

        expect(boundary).toContain("studentCredentialBatchReady");
        expect(boundary).toContain("student-credential-batch:202608080010");
        expect(boundary).toContain("'version', '202608080010'");
        expect(boundary).toContain("omr_student_credential_batch_receipts");
        expect(rollback).toContain("omr_student_credential_batch_receipts");
        expect(rollback).toContain("omr_issue_student_start_code_batch_v1");
        expect(rollback).toMatch(/revoke all on function public\.omr_rotate_student_start_credential_v1\([^)]+\)\s+from public, anon, authenticated, service_role/i);
        expect(readiness).toContain('SUPABASE_READINESS_VERSION = "202608080010"');
        expect(docs).toContain("canonical 42개");
        expect(docs).toContain("202608080010");
    });
});
