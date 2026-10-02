import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RELEASE_ATOMIC_CHECKS } from "../../scripts/release-quality-core.mjs";

const verifier = readFileSync(
    path.join(process.cwd(), "scripts/verify-supabase-live.mjs"),
    "utf8",
);
const workflow = readFileSync(
    path.join(process.cwd(), ".github/workflows/initial-operations-qualification.yml"),
    "utf8",
);
const hostedCredentialSpec = readFileSync(
    path.join(process.cwd(), "e2e/student-credential-batch.spec.ts"),
    "utf8",
);
const liveAssertions = readFileSync(
    path.join(process.cwd(), "supabase/live-test-assertions.sql"),
    "utf8",
);
const rosterCasAssertions = readFileSync(
    path.join(process.cwd(), "supabase/roster-snapshot-cas-assertions.sql"),
    "utf8",
);
const canonicalEvidenceAssertions = readFileSync(
    path.join(process.cwd(), "supabase/canonical-question-result-evidence-assertions.sql"),
    "utf8",
);
const releaseProofAssertionsPath = path.join(
    process.cwd(),
    "supabase/initial-operations-release-proof-assertions.sql",
);
type AtomicCheck = { id: string };
const postgresProofIds = [
    ...(RELEASE_ATOMIC_CHECKS.provisioning_entitlement as readonly AtomicCheck[]).map(({ id }) => id),
    ...(RELEASE_ATOMIC_CHECKS.data_integrity_isolation as readonly AtomicCheck[]).map(({ id }) => id),
].filter((id) => id !== "provisioning_entitlement_one_time_csv");
const markerPrefix = "OMR_INITIAL_OPS_RELEASE_PROOF_V1 ";
const secretWitnessId = "provisioning_entitlement_one_time_secret_nonpersistence";
const rollbackPhases = ["boundary_asserted", "rollback_asserted", "reapplied", "final_asserted"];

function assertionBlock(sql: string, proofId: string): string {
    const start = sql.indexOf(`-- release-proof-assertion:${proofId}`);
    const next = sql.indexOf("-- release-proof-assertion:", start + 1);
    expect(start, `missing assertion ${proofId}`).toBeGreaterThanOrEqual(0);
    return sql.slice(start, next < 0 ? sql.length : next);
}

describe("Supabase live verifier local PostgreSQL fallback", () => {
    it("rehearses boundary rollback and then restores the production boundary", () => {
        expect(verifier).toContain('psqlFile("supabase/production-server-boundary.sql")');
        expect(verifier).toContain('psqlFile("supabase/teacher-force-finish-compact-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/teacher-session-revocation-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/live-test-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/production-server-boundary-rollback.sql",');
        expect(verifier).toContain('psqlFile("supabase/live-test-rollback-assertions.sql")');
        expect(verifier.match(/psqlFile\("supabase\/production-server-boundary\.sql"\)/g)).toHaveLength(3);
        expect(verifier.match(/psqlFile\("supabase\/live-test-boundary-assertions\.sql"\)/g)).toHaveLength(2);
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-concurrency-lock.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-overload-fixtures.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-overload-boundary-assertions.sql")');
    });

    it("can exercise the exact 100001 to 100002 Kakao legacy upgrade boundary", () => {
        expect(verifier).toContain("OMR_KAKAO_ENTITLEMENT_UPGRADE_FIXTURE");
        expect(verifier).toContain('migration === "202608100002_kakao_reminder_entitlement_boundary.sql"');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-upgrade-fixtures.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-upgrade-assertions.sql")');
    });

    it("compares the generated canonical manifest to live public base and partitioned tables", () => {
        expect(verifier).toContain('import { CANONICAL_TABLES } from "./canonical-table-manifest.mjs"');
        expect(verifier).toContain("assertLiveCanonicalTables");
        expect(verifier).toContain("relation.relkind in ('r', 'p')");
        expect(verifier).toContain("relation.relkind in ('f', 'v', 'm')");
        expect(verifier).toContain("live database contains unsupported public OMR relation kinds");
        expect(verifier).toContain("live canonical tables do not match the generated manifest");
    });

    it("proves dynamic view DDL cannot bypass the unsupported live relation guard", () => {
        expect(verifier).toContain("assertUnsupportedLiveRelationProbe");
        expect(verifier).toContain("do $probe$");
        expect(verifier).toContain("create view public.omr_live_manifest_view_probe");
        expect(verifier).toContain("create materialized view public.omr_live_manifest_materialized_probe");
        expect(verifier).toContain("drop materialized view if exists public.omr_live_manifest_materialized_probe");
        expect(verifier).toContain("drop view if exists public.omr_live_manifest_view_probe");
    });

    it("uses an isolated loopback-only PostgreSQL 17 cluster and always cleans it up", () => {
        expect(verifier).toContain("OMR_SUPABASE_LIVE_BACKEND");
        expect(verifier).toContain("OMR_POSTGRES_BIN");
        expect(verifier).toContain("isPostgres17Directory");
        expect(verifier).toContain(
            "directories.find(directory => hasRequiredPostgresBinaries(directory) && isPostgres17Directory(directory))",
        );
        expect(verifier).toContain("dockerInfoTimeoutMs");
        expect(verifier).toContain('run("docker", ["info"], {');
        expect(verifier).toContain("timeout: dockerInfoTimeoutMs");
        expect(verifier).toContain('mkdtempSync(resolve(tmpdir(), "omr-postgres-verify-"))');
        expect(verifier).toContain('getFreePort("127.0.0.1")');
        expect(verifier).toContain('"initdb"');
        expect(verifier).toContain('"pg_ctl"');
        expect(verifier).toContain('"createdb"');
        expect(verifier).toContain('"psql"');
        expect(verifier).toContain('"-h", "127.0.0.1"');
        expect(verifier).toContain('"-v", "ON_ERROR_STOP=1"');
        expect(verifier).toMatch(
            /const temporaryDirectory = mkdtempSync\([^\n]+\);\s*try\s*\{[\s\S]*getFreePort\("127\.0\.0\.1"\)/,
        );
        expect(verifier).toMatch(
            /finally\s*\{[\s\S]*"pg_ctl"[\s\S]*"stop"[\s\S]*rmSync\(temporaryDirectory/,
        );
    });

    it("runs the final independent release proof phase last and captures all four phase reports", () => {
        expect(existsSync(releaseProofAssertionsPath)).toBe(true);
        expect(verifier).toContain('import { deriveLivePgReleaseProofs } from "./live-pg-release-proof-core.mjs"');
        expect(verifier).toContain('psqlFile("supabase/initial-operations-release-proof-assertions.sql"');
        expect(verifier.lastIndexOf('psqlFile("supabase/initial-operations-release-proof-assertions.sql"'))
            .toBeGreaterThan(verifier.indexOf('psqlFile("supabase/teacher-notification-state-assertions.sql"'));
        expect(verifier.match(/psqlFile\("supabase\/initial-operations-release-proof-assertions\.sql"/g))
            .toHaveLength(4);
        expect(verifier).toContain("capture: true");
        expect(verifier).toContain("function releaseProofReport(result)");
        expect(verifier).toContain("return { stdout: result.stdout, stderr: result.stderr };");
        expect(verifier.match(/releaseProofReport\(psqlFile\(/g)).toHaveLength(4);
        expect(verifier).toContain("OMR_LIVE_PG_PROOF_SUMMARY_PATH");
        expect(verifier).toContain("mode: 0o600");
    });

    it("places every independent SQL assertion before its sole stdout marker", () => {
        expect(existsSync(releaseProofAssertionsPath)).toBe(true);
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        expect(sql).toContain("set local lock_timeout = '2s'");
        expect(sql).toContain("set local statement_timeout = '30s'");
        expect(sql).not.toMatch(/set\s+(?:local\s+)?role\s+postgres/i);
        expect(sql).not.toContain(`${markerPrefix}{"schemaVersion":1,"ordinal":5,"proofId":"provisioning_entitlement_one_time_csv"}`);
        for (const [index, proofId] of postgresProofIds.entries()) {
            const assertionTag = `-- release-proof-assertion:${proofId}`;
            const marker = `${markerPrefix}{"schemaVersion":1,"ordinal":${index + 1},"proofId":"${proofId}"}`;
            expect(sql.match(new RegExp(assertionTag, "g"))).toHaveLength(1);
            expect(sql.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
            const assertionIndex = sql.indexOf(assertionTag);
            const markerIndex = sql.indexOf(marker);
            expect(assertionIndex).toBeLessThan(markerIndex);
            expect(sql.slice(assertionIndex, markerIndex)).toMatch(/do \$release_proof_[a-z0-9_]+\$/);
            expect(sql.slice(assertionIndex, markerIndex)).toContain("raise exception");
        }
        expect(sql).toContain(`-- release-proof-witness:${secretWitnessId}`);
        expect(sql).toContain(`"witnessId":"${secretWitnessId}"`);
        const witnessStart = sql.indexOf(`-- release-proof-witness:${secretWitnessId}`);
        const witnessMarker = sql.indexOf(`"witnessId":"${secretWitnessId}"`, witnessStart);
        const witnessBlock = sql.slice(witnessStart, witnessMarker);
        for (const pattern of [
            /omr_issue_student_start_code_batch_v1/, /omr_student_start_credentials/,
            /omr_student_credential_batch_receipts/, /omr_audit_logs/,
            /verifier|start[_ ]?code/i, /insufficient_privilege/,
        ]) expect(witnessBlock).toMatch(pattern);
    });

    it("makes every nullable release-proof predicate fail closed", () => {
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        const unsafeJsonScalarComparisons = sql.split("\n").filter((line) =>
            (line.includes("->>") || line.includes(" -> "))
            && /(?:<>|!~|(?<![:<>=])=(?!=)|\b(?:not\s+)?in\s*\()/i.test(line)
            && !line.trimStart().startsWith("--"),
        );
        expect(unsafeJsonScalarComparisons).toEqual([]);
        expect(sql).not.toMatch(/\bnot\s+public\.omr_[a-z0-9_]+\s*\(/i);
        for (const functionName of [
            "omr_validate_student_session_v1",
            "omr_validate_teacher_session_v1",
            "omr_canonical_attempt_child_evidence_matches_v1",
        ]) {
            const calls = sql.match(new RegExp(`public\\.${functionName}\\(`, "g")) ?? [];
            const truthTests = sql.match(new RegExp(
                `public\\.${functionName}\\([\\s\\S]{0,500}?\\)\\s+is (?:not )?true`, "g",
            )) ?? [];
            expect(truthTests, functionName).toHaveLength(calls.length);
        }

        const recovery = assertionBlock(sql, "provisioning_entitlement_account_recovery");
        expect(recovery).not.toContain("v_replacement ->> 'sessionGeneration'");
        expect(recovery).toMatch(
            /select\s+account\.session_generation\s+into\s+strict\s+v_session_generation[\s\S]*from\s+public\.omr_teacher_accounts\s+account/i,
        );
        expect(recovery).toContain("v_session_generation is distinct from 2");

        const rotation = assertionBlock(sql, "provisioning_entitlement_credential_rotation");
        expect(rotation).toContain("v_rotated_count integer := 0");
        expect(rotation).toContain("v_rotated_count := v_rotated_count + 1");
        expect(rotation).toContain("v_rotated_count is distinct from 2");
        expect(rotation).toContain("is not true");
        expect(rotation).toContain("is true");

        const rollback = assertionBlock(sql, "data_integrity_isolation_rollback_contract");
        expect(rollback).toContain("v_required_readiness_keys constant text[] := array[");
        expect(rollback).toContain("v_readiness ?& v_required_readiness_keys");
        expect(rollback).toContain("jsonb_typeof(capability.value) is distinct from 'boolean'");
        expect(rollback).toMatch(
            /count\(\*\)[\s\S]*?is distinct from pg_catalog\.cardinality\(v_required_readiness_keys\)/,
        );
        expect(rollback).toContain("jsonb_typeof(v_readiness -> 'version') is distinct from 'string'");
    });

    it("requires exact strict RETURNING rows for all nine storage mutations", () => {
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        const storage = assertionBlock(sql, "data_integrity_isolation_storage_isolation");
        expect(storage.match(
            /returning\s+(?:name|id(?:,\s*name)?)\s+into\s+strict\s+v_[a-z_]+(?:,\s*v_[a-z_]+)?/gi,
        )).toHaveLength(9);
        expect(storage).toMatch(
            /update\s+storage\.buckets[\s\S]*?returning\s+id,\s*name\s+into\s+strict\s+v_bucket_id,\s*v_bucket_name/i,
        );
        expect(storage).toMatch(
            /delete\s+from\s+storage\.buckets[\s\S]*?returning\s+id\s+into\s+strict\s+v_deleted_bucket_id/i,
        );
        expect(storage).toContain("v_bucket_id is distinct from 'release-proof-service-bucket'");
        expect(storage).toContain("v_bucket_name is distinct from 'release-proof-service-bucket-updated'");
        expect(storage).toContain("v_deleted_bucket_id is distinct from 'release-proof-service-bucket'");
    });

    it("compares the roster enrollment multiset to two exact sorted tuples", () => {
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        const roster = assertionBlock(sql, "data_integrity_isolation_roster_cas");
        const expected = JSON.stringify([
            ["release-proof-class", "release-proof-student-a", "active"],
            ["release-proof-class", "release-proof-student-b", "active"],
        ]);
        expect(roster).toContain(`v_expected_enrollments constant jsonb := '${expected}'::jsonb`);
        expect(roster).toMatch(
            /select\s+pg_catalog\.jsonb_agg\(\s*pg_catalog\.jsonb_build_array\(\s*item\s*->>\s*'class_id',\s*item\s*->>\s*'student_profile_id',\s*item\s*->>\s*'enrollment_status'\s*\)\s*order by\s+item\s*->>\s*'class_id',\s*item\s*->>\s*'student_profile_id',\s*item\s*->>\s*'enrollment_status'\s*\)\s*into\s+strict\s+v_actual_enrollments/i,
        );
        expect(roster).toContain("v_actual_enrollments is distinct from v_expected_enrollments");

        const duplicateA = [
            ["release-proof-class", "release-proof-student-a", "active"],
            ["release-proof-class", "release-proof-student-a", "active"],
        ];
        expect(JSON.stringify(duplicateA)).not.toBe(expected);
    });

    it("bounds the post-commit concurrent quota phase and cleans every dblink session", () => {
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        const quota = assertionBlock(sql, "data_integrity_isolation_quota_atomicity");
        const quotaStart = sql.indexOf("-- release-proof-assertion:data_integrity_isolation_quota_atomicity");
        const precedingCommit = sql.lastIndexOf("commit;", quotaStart);
        const postCommitPreamble = sql.slice(precedingCommit + "commit;".length, quotaStart);
        expect(postCommitPreamble).toMatch(/\bbegin;[\s\S]*set local lock_timeout = '2s';[\s\S]*set local statement_timeout = '30s';/i);
        expect(quota.match(/connect_timeout=5/g)).toHaveLength(3);
        expect(quota.match(/set statement_timeout = '20s'/g)?.length).toBeGreaterThanOrEqual(2);
        expect(quota.match(/set lock_timeout = '2s'/g)?.length).toBeGreaterThanOrEqual(2);
        expect(quota).toMatch(/exception\s+when\s+others\s+then[\s\S]*dblink_get_connections\(\)[\s\S]*dblink_disconnect[\s\S]*raise;/i);
        expect(quota).toMatch(/select\s+used\s+into\s+strict\s+v_used[\s\S]*from\s+public\.omr_plan_usage/i);
        expect(quota).toContain("v_used is distinct from 5000");
        expect(verifier).toContain("const liveSqlTimeoutMs = 120_000;");
        expect(verifier.match(/timeout: liveSqlTimeoutMs/g)?.length).toBeGreaterThanOrEqual(4);
    });

    it("requires current production RPCs and adversarial outcomes in every high-risk proof", () => {
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        const required = {
            provisioning_entitlement_provision_audit: [
                /omr_audit_logs/, /forced?[^\n]*fail|force[^\n]*rollback/i,
                /roll back|rollback/i, /count\s*\(\s*\*\s*\)/i,
            ],
            provisioning_entitlement_pilot_grant: [
                /omr_pilot_plan_grants/, /active/i, /expired|expiry/i,
                /superseded/i, /plan[^\n]*free|free[^\n]*plan/i,
            ],
            provisioning_entitlement_student_batch: [
                /omr_issue_student_start_code_batch_v1/g,
                /empty|zero|0[-_ ]?student/i, /101/, /duplicate/i, /foreign/i,
                /inactive|withdrawn/i, /mixed[-_ ]?invalid/i, /100[-_ ]?student/i,
                /already_applied/, /idempotency_conflict/,
                /audit[^\n]*(fail|rollback)|force[^\n]*audit/i,
                /generation exhausted/i, /all[-_ ]?or[-_ ]?none|partial/i,
            ],
            provisioning_entitlement_invite_lifecycle: [
                /omr_rotate_exam_entry_invite_v1/g, /omr_resolve_exam_entry_invite_v1/g,
                /omr_revoke_exam_entry_invite_v1/, /wrong[^\n]*token/i,
                /wrong[^\n]*exam/i, /old[^\n]*(token|bearer)[^\n]*(invalid|reject)/i,
            ],
            provisioning_entitlement_account_recovery: [
                /omr_provision_pilot_teacher_v1/g, /session_generation/i, /omr_pilot_plan_grants/,
                /omr_audit_logs/, /replayed/, /forced?[^\n]*audit|audit[^\n]*rollback/i,
            ],
            provisioning_entitlement_assignment_binding: [
                /omr_assign_students_v2/, /omr_list_student_assignments_v2/,
                /omr_resolve_student_assignment_v2/, /omr_open_attempt_session_v3/,
                /wrong[^\n]*(revision|generation)|stale[^\n]*(revision|generation)/i, /non[-_ ]?target/i,
            ],
            data_integrity_isolation_submission_replay: [
                /omr_open_attempt_session_v3/, /omr_commit_attempt_session_submit_v2/g,
                /result_status/, /submitted_attempt_id/,
            ],
            data_integrity_isolation_quota_atomicity: [
                /extensions\.dblink/, /omr_reserve_plan_usage_v2/, /4999|near[-_ ]?limit/i,
                /concurren|race/i,
            ],
            data_integrity_isolation_receipt_replay: [
                /omr_open_attempt_session_v3/, /omr_commit_attempt_session_submit_v2/g,
                /response[-_ ]?loss|receipt/i, /payload/,
            ],
            data_integrity_isolation_session_generation: [
                /omr_open_attempt_session_v3/, /assignment_revision/,
                /stale|wrong/i, /denied|reject/i,
            ],
            data_integrity_isolation_roster_cas: [
                /omr_save_roster_v3/, /omr_load_roster_v2/, /extensions\.dblink/,
                /revision/i,
            ],
            data_integrity_isolation_question_atomicity: [
                /omr_question_results/, /omr_canonical_attempt_child_evidence_matches_v1/,
                /omr_force_finish_attempt_sessions_compact_v2/,
                /delete[\s\S]*omr_question_results/i, /roll back|rollback/i,
            ],
            data_integrity_isolation_storage_isolation: [
                /set local role anon/i, /set local role authenticated/i, /set local role service_role/i,
                /select[\s\S]*storage\.(objects|buckets)/i,
                /insert[\s\S]*storage\.(objects|buckets)/i,
                /update[\s\S]*storage\.(objects|buckets)/i,
                /delete[\s\S]*storage\.(objects|buckets)/i,
                /third-party-browser-assets/,
            ],
        } as const;
        for (const [proofId, patterns] of Object.entries(required)) {
            const block = assertionBlock(sql, proofId);
            for (const pattern of patterns) {
                expect(block, `${proofId} lacks ${pattern}`).toMatch(pattern);
                if (pattern.global) pattern.lastIndex = 0;
            }
        }
        expect(assertionBlock(sql, "provisioning_entitlement_account_recovery")
            .match(/omr_provision_pilot_teacher_v1/g)?.length).toBeGreaterThanOrEqual(3);
        for (const proofId of [
            "data_integrity_isolation_submission_replay",
            "data_integrity_isolation_receipt_replay",
        ]) expect(assertionBlock(sql, proofId).match(/omr_commit_attempt_session_submit_v2/g)?.length)
            .toBeGreaterThanOrEqual(2);
    });

    it("orders the reused adversarial runtime transcripts before their release markers", () => {
        const finalProofCall = verifier.lastIndexOf(
            'psqlFile("supabase/initial-operations-release-proof-assertions.sql"',
        );
        for (const sourceCall of [
            'psqlFile("supabase/live-test-assertions.sql")',
            'psqlFile("supabase/roster-snapshot-cas-assertions.sql")',
            'psqlFile("supabase/canonical-question-result-evidence-assertions.sql")',
        ]) expect(verifier.indexOf(sourceCall)).toBeLessThan(finalProofCall);

        for (const token of [
            "$task6_batch_behavior$", "empty Task 6 batch", "101-student Task 6 batch",
            "duplicate or malformed Task 6 batch", "foreign or inactive Task 6 student",
            "mixed-invalid Task 6 batch", "100-student Task 6 issue", "already_applied",
            "idempotency_conflict", "$task6_audit_rollback$", "$task6_generation_exhaustion$",
            "operator provisioning audit failure was not atomic", "expired pilot grant did not resolve to effective free",
            "provisioned teacher superseded grant or forged organization.plan",
        ]) expect(liveAssertions).toContain(token);
        for (const token of [
            "omr_save_roster_v3", "omr_load_roster_v2", "extensions.dblink",
            "atomic roster load returned rows from a different revision",
        ]) expect(rosterCasAssertions).toContain(token);
        for (const token of [
            "omr_canonical_attempt_child_evidence_matches_v1",
            "delete from public.omr_question_results",
            "canonical mismatch did not roll back the entire mutation",
            "omr_force_finish_attempt_sessions_compact_v2",
        ]) expect(canonicalEvidenceAssertions).toContain(token);
    });

    it("binds rollback proof evidence to the exact boundary rollback and reapply transcript", () => {
        const expectedCalls = [
            'psqlFile("supabase/production-server-boundary.sql")',
            'psqlFile("supabase/live-test-boundary-assertions.sql")',
            'psqlFile("supabase/production-server-boundary-rollback.sql",',
            'psqlFile("supabase/live-test-rollback-assertions.sql")',
            'psqlFile("supabase/production-server-boundary.sql")',
            'psqlFile("supabase/live-test-boundary-assertions.sql")',
        ];
        let cursor = 0;
        for (const call of expectedCalls) {
            cursor = verifier.indexOf(call, cursor);
            expect(cursor, `missing ordered rollback call ${call}`).toBeGreaterThanOrEqual(0);
            cursor += call.length;
        }
        for (const phase of rollbackPhases) {
            expect(verifier).toContain(`release_proof_phase=${phase}`);
        }
        expect(verifier).toContain("deriveLivePgReleaseProofs({ reports:");
        const sql = readFileSync(releaseProofAssertionsPath, "utf8");
        expect(sql).not.toContain("release proof forced rollback");
        for (const [index, phase] of rollbackPhases.entries()) {
            expect(sql).toContain(`"ordinal":${index + 1},"phase":"${phase}"`);
        }
    });

    it("makes the workflow consume the verifier summary instead of injecting proof constants", () => {
        expect(workflow).toContain("OMR_LIVE_PG_PROOF_SUMMARY_PATH");
        expect(workflow).toContain("parseLivePgReleaseProofSummary");
        expect(workflow).not.toContain("QUALIFICATION_LIVE_PG_PROOFS");
        expect(workflow).not.toMatch(/proofs:\s*\[\s*["']provisioning_entitlement_/);
        expect(workflow).toContain("hostedProofs");
        expect(workflow).toContain("deriveHostedBrowserReleaseProofs");
    });

    it("binds the UI half of one-time CSV to the exact hosted browser journey", () => {
        const ownerTitle = "hosted provision, CSV login, rotation, and old credential rejection";
        const ownerStart = hostedCredentialSpec.indexOf(`test("${ownerTitle}"`);
        expect(ownerStart).toBeGreaterThanOrEqual(0);
        const owner = hostedCredentialSpec.slice(ownerStart, ownerStart + 4_000);
        expect(owner).toContain(
            '{ type: "release-proof", description: "provisioning_entitlement_one_time_csv" }',
        );
        expect(owner).toContain("issueAndReadCsv(page, 2, cleanupPaths, true)");
        expect(hostedCredentialSpec).toContain('expect(bytes[0]).toBe(0xef)');
        expect(hostedCredentialSpec).toContain('expect(csv.startsWith("\\uFEFFstudent_id,name,group,start_code\\r\\n")).toBe(true)');
        expect(hostedCredentialSpec).toContain("download retry unexpectedly reissued credentials");
        expect(hostedCredentialSpec).toContain("credential leakage detected on a browser surface");
    });
});
