import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CANONICAL_TABLES } from "../../scripts/canonical-table-manifest.mjs";

const rootDir = process.cwd();

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function readOptional(relativePath: string): string {
    const absolutePath = path.join(rootDir, relativePath);
    return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

const canonicalTables = [
    "omr_organizations",
    "omr_plan_usage",
    "omr_plan_usage_reservations",
    "omr_user_profiles",
    "omr_organization_members",
    "omr_teacher_profiles",
    "omr_student_profiles",
    "omr_student_start_credentials",
    "omr_classes",
    "omr_roster_invites",
    "omr_class_teachers",
    "omr_class_students",
    "omr_materials",
    "omr_exams",
    "omr_exam_questions",
    "omr_exam_materials",
    "omr_assignments",
    "omr_assignment_targets",
    "omr_attempts",
    "omr_question_results",
    "omr_assignment_submissions",
    "omr_attempt_feedback",
    "omr_kakao_candidate_reviews",
    "omr_kakao_dispatch_logs",
    "omr_comments",
    "omr_audit_logs",
    "omr_remote_assets",
] as const;

const serverGatewaySignatures = [
    ["omr_submit_attempt_v1", "text, jsonb, jsonb"],
    ["omr_submit_session_attempt_v1", "jsonb, jsonb"],
    ["omr_save_exam_v1", "jsonb, jsonb"],
    ["omr_delete_exam_v1", "text, text"],
    ["omr_save_roster_v1", "text, jsonb, jsonb, jsonb, jsonb"],
    ["omr_attach_attempt_handwriting_v1", "text, text, jsonb"],
    ["omr_save_feedback_v1", "text, jsonb"],
    [
        "omr_return_feedback_v1",
        "text, text, timestamp with time zone",
    ],
    [
        "omr_mark_feedback_opened_v2",
        "text, text, text, timestamp with time zone",
    ],
    ["omr_save_remote_asset_metadata_v1", "jsonb"],
    [
        "omr_claim_guest_attempts_v1",
        "text, text, text, text, text, text, text[]",
    ],
] as const;

function createdPolicies(sql: string): Array<{ name: string; table: string }> {
    return [...sql.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+public\.([a-z0-9_]+)/gi)]
        .map(match => ({ name: match[1], table: match[2] }));
}

describe("production server-only database boundary", () => {
    const profile = readOptional("supabase/production-server-boundary.sql");
    const schema = read("supabase/schema.sql");
    const legacyProductionProfile = read("supabase/production-rls.sql");
    const livePrelude = read("supabase/live-test-prelude.sql");
    const verifier = read("scripts/verify-supabase-live.mjs");
    const liveAssertions = read("supabase/live-test-assertions.sql");
    const boundaryAssertions = read("supabase/live-test-boundary-assertions.sql");
    const rollback = read("supabase/production-server-boundary-rollback.sql");
    const supabaseReadme = read("supabase/README.md");
    const productionReadiness = read("docs/production-readiness.md");
    const operationalJobStatusMigration = readOptional(
        "supabase/migrations/202608080005_operational_job_status.sql",
    );
    const operatorProvisioningMigration = readOptional(
        "supabase/migrations/202608080006_initial_operator_provisioning.sql",
    );
    const ci = read(".github/workflows/ci.yml");
    const readinessV4 = readOptional(
        "supabase/migrations/202607280003_service_readiness_probe_v4.sql",
    );

    it("installs a v4 probe over effective runtime privileges and integrity", () => {
        const compactReadinessV4 = readinessV4.replace(/\s+/g, " ");
        const exactCanonicalValues = canonicalTables
            .map(table => `('${table}')`)
            .join(", ");

        expect(readinessV4).not.toBe("");
        expect(readinessV4).toContain("'version', '202607280003'");
        expect(readinessV4).toContain("information_schema.role_table_grants");
        expect(readinessV4).toContain("information_schema.role_column_grants");
        expect(readinessV4).toContain("information_schema.routine_privileges");
        expect(readinessV4).toContain("has_schema_privilege");
        expect(readinessV4).toContain("has_table_privilege");
        expect(readinessV4).toContain("has_any_column_privilege");
        expect(readinessV4).toContain("has_sequence_privilege");
        expect(readinessV4).toContain("has_function_privilege");
        expect(readinessV4).toContain(
            "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'",
        );
        expect(readinessV4).toContain("relforcerowsecurity");
        expect(readinessV4).toContain("pg_catalog.pg_policies");
        expect(readinessV4).not.toContain(
            "v_expected_canonical_table_count",
        );
        expect(compactReadinessV4).toContain(
            `with expected_canonical_tables(table_name) as ( values ${exactCanonicalValues} )`,
        );
        expect(readinessV4).toMatch(
            /select table_name\s+from expected_canonical_tables\s+except\s+select table_name\s+from actual_canonical_tables/i,
        );
        expect(readinessV4).toMatch(
            /select table_name\s+from actual_canonical_tables\s+except\s+select table_name\s+from expected_canonical_tables/i,
        );
        expect(readinessV4).toContain("omr_production_boundary_preflight_v1");
        for (const [routineName, identityArguments] of [
            [
                "omr_answer_attempt_question_v1",
                "text, text, text, text, text, text, text",
            ],
            [
                "omr_set_subquestion_review_v1",
                "text, text, text, text, text, text, text",
            ],
            [
                "omr_force_finish_attempts_v1",
                "text, text[], timestamp with time zone, text, text, text, jsonb",
            ],
        ]) {
            expect(compactReadinessV4).toMatch(
                new RegExp(
                    `\\(\\s*'${routineName}',\\s*'${identityArguments.replaceAll("[]", "\\[\\]")}'\\s*\\)`,
                ),
            );
        }
        expect(readinessV4).toContain("pg_catalog.oidvectortypes");
        expect(readinessV4).toMatch(
            /select routine_name, identity_arguments\s+from expected_scoped_rpcs\s+except\s+select routine_name, identity_arguments\s+from actual_scoped_rpcs/i,
        );
        expect(readinessV4).toMatch(
            /select routine_name, identity_arguments\s+from actual_scoped_rpcs\s+except\s+select routine_name, identity_arguments\s+from expected_scoped_rpcs/i,
        );
        const actualScopedRpcCte = readinessV4.match(
            /actual_scoped_rpcs\s*\(\s*routine_name,\s*identity_arguments\s*\)\s*as\s*\(([\s\S]*?)\)\s*select\s+not\s+exists/i,
        );
        expect(actualScopedRpcCte).not.toBeNull();
        expect(actualScopedRpcCte?.[1]).toMatch(
            /routine\.prokind\s*=\s*'f'/i,
        );
        expect(readinessV4).toMatch(
            /routine\.proname\s+in\s*\(\s*'omr_teacher_update_attempt_v1',\s*'omr_mark_feedback_opened'\s*\)/i,
        );
        expect(readinessV4).not.toContain(
            "'public.omr_teacher_update_attempt_v1(",
        );
        const expectedServerGatewayCte = readinessV4.match(
            /with expected_server_gateways\s*\(\s*routine_name,\s*identity_arguments\s*\)\s*as\s*\(\s*values([\s\S]*?)\),\s*actual_server_gateways/i,
        );
        expect(expectedServerGatewayCte).not.toBeNull();
        expect([
            ...(expectedServerGatewayCte?.[1] || "").matchAll(
                /\(\s*'([^']+)',\s*'([^']+)'\s*\)/g,
            ),
        ].map(match => [match[1], match[2]])).toEqual(serverGatewaySignatures);
        expect(readinessV4).toMatch(
            /select routine_name, identity_arguments\s+from expected_server_gateways\s+except\s+select routine_name, identity_arguments\s+from actual_server_gateways/i,
        );
        expect(readinessV4).toMatch(
            /select routine_name, identity_arguments\s+from actual_server_gateways\s+except\s+select routine_name, identity_arguments\s+from expected_server_gateways/i,
        );
        const actualServerGatewayCte = readinessV4.match(
            /actual_server_gateways\s*\(\s*routine_name,\s*identity_arguments\s*\)\s*as\s*\(([\s\S]*?)\)\s*select\s+not\s+exists/i,
        );
        expect(actualServerGatewayCte).not.toBeNull();
        expect(actualServerGatewayCte?.[1]).toMatch(
            /routine\.prokind\s*=\s*'f'/i,
        );
        expect(readinessV4).toContain("supabase_storage_admin");
        expect(readinessV4).toContain("OMR private assets server-only objects");
        expect(readinessV4).toContain("OMR private assets server-only buckets");
        for (const role of ["anon", "authenticated"]) {
            for (const privilege of ["USAGE", "CREATE"]) {
                expect(readinessV4).toMatch(
                    new RegExp(
                        `has_schema_privilege\\(\\s*'${role}',\\s*'public',\\s*'${privilege}'\\s*\\)`,
                        "i",
                    ),
                );
            }
        }
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            expect(readinessV4).toMatch(
                new RegExp(
                    `has_table_privilege\\(\\s*'service_role',\\s*relation\\.oid,\\s*'${privilege}'\\s*\\)`,
                    "i",
                ),
            );
        }
        for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
            expect(readinessV4).toMatch(
                new RegExp(
                    `has_sequence_privilege\\(\\s*'service_role',\\s*relation\\.oid,\\s*'${privilege}'\\s*\\)`,
                    "i",
                ),
            );
        }

        for (const key of [
            "browserSchemaPrivilegesDenied",
            "anonTablePrivilegesDenied",
            "authenticatedCanonicalPrivilegesDenied",
            "browserSequencePrivilegesDenied",
            "browserFunctionPrivilegesDenied",
            "alphaPoliciesAbsent",
            "canonicalTablesForceRls",
            "canonicalPoliciesAbsent",
            "organizationBackfillReady",
            "serviceRolePrivilegesReady",
            "scopedRpcPrivilegesReady",
            "hostedStorageBoundaryReady",
            "serverGatewayCapabilitiesReady",
            "queryPathIndexesReady",
            "legacyBroadRpcsRemoved",
        ]) {
            expect(readinessV4).toContain(`'${key}'`);
        }
        expect(readinessV4).toMatch(
            /revoke all on function public\.omr_service_readiness_v1\(\) from public, anon, authenticated/i,
        );
        expect(readinessV4).toMatch(
            /grant execute on function public\.omr_service_readiness_v1\(\) to service_role/i,
        );
        expect(liveAssertions).toContain(
            "v4 readiness probe did not confirm every effective boundary",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted browser schema usage",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted browser schema create",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted an anon table grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted an authenticated table grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a browser sequence grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a browser function grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a canonical policy",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a table without FORCE RLS",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a replacement rogue canonical table",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a PUBLIC column grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a PG17 MAINTAIN grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted an inherited browser table grant",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted missing service-role table access",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted missing scoped RPC execute",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a missing target Storage policy",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a reintroduced Storage alpha policy",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a failed organization preflight",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a missing server gateway",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted an extra server gateway overload",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a missing query-path index",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a forbidden broad RPC overload",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted an extra scoped RPC overload",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a scoped procedure impostor",
        );
        expect(liveAssertions).toContain(
            "v4 readiness accepted a server gateway procedure impostor",
        );
        expect(supabaseReadme).toContain("202608080010");
        expect(supabaseReadme).toContain("rosterSnapshotCasReady");
        expect(supabaseReadme).toContain("attemptMutationCasReady");
        expect(supabaseReadme).toContain("examDeleteSessionSafe");
        expect(supabaseReadme).toContain("teacherAccountLifecycleReady");
        expect(productionReadiness).toContain("202608080010");
        expect(productionReadiness).toContain("rosterSnapshotCasReady");
        expect(productionReadiness).toContain("attemptMutationCasReady");
        expect(productionReadiness).toContain("examDeleteSessionSafe");
        expect(productionReadiness).toContain("teacherAccountLifecycleReady");
        expect(productionReadiness).toContain("initialOperationsLoadControlReady");
    });

    it("runs the organization preflight before atomically closing every public app surface", () => {
        expect(profile).not.toBe("");
        const beginIndex = profile.search(/\bbegin\s*;/i);
        expect(beginIndex).toBeGreaterThan(-1);
        expect(profile).toMatch(/commit\s*;\s*$/i);

        const preflightIndex = profile.indexOf("select public.omr_assert_production_boundary_preflight_v1();");
        const firstRevokeIndex = profile.search(/\brevoke\b/i);
        const firstAlterIndex = profile.search(/\balter table\b/i);
        expect(preflightIndex).toBeGreaterThan(-1);
        expect(firstRevokeIndex).toBeGreaterThan(preflightIndex);
        expect(firstAlterIndex).toBeGreaterThan(preflightIndex);

        expect(profile).toMatch(
            /revoke all on all tables in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /revoke all on all sequences in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /revoke all on all functions in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(/grant all on all tables in schema public to service_role;/i);
        expect(profile).toMatch(/grant all on all sequences in schema public to service_role;/i);
        expect(profile).toMatch(/grant all on all functions in schema public to service_role;/i);

        const discoveredTables = [...CANONICAL_TABLES];
        expect(discoveredTables).toHaveLength(42);
        expect(discoveredTables).toEqual([...discoveredTables].sort());
        expect(new Set(discoveredTables).size).toBe(discoveredTables.length);
        for (const table of CANONICAL_TABLES) {
            expect(profile, `${table} must ENABLE RLS`).toMatch(
                new RegExp(`alter table(?: if exists)? public\\.${table} enable row level security;`, "i"),
            );
            expect(profile, `${table} must FORCE RLS`).toMatch(
                new RegExp(`alter table(?: if exists)? public\\.${table} force row level security;`, "i"),
            );
        }
        expect(profile).toContain("public.omr_operational_job_status");
        expect(profile).toContain("public.omr_pilot_plan_grants");
        expect(profile).toContain("public.omr_begin_operational_job_run_v1(text,text)");
        expect(profile).toContain("public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)");
        expect(profile).toContain("public.omr_read_operational_job_status_v1(text)");
        expect(profile).toContain("pg_catalog.pg_get_function_result(routine.oid) <> 'jsonb'");
        expect(operatorProvisioningMigration).toContain(
            "atomic-operator-pilot-teacher-provisioning:202608080006",
        );
        expect(profile).toContain("operatorPilotProvisioningReady");
    });

    it("keeps operational job heartbeat state RPC-only, bounded, and monotonic", () => {
        expect(operationalJobStatusMigration).not.toBe("");
        expect(operationalJobStatusMigration).toContain(
            "create table public.omr_operational_job_status",
        );
        expect(operationalJobStatusMigration).toMatch(
            /alter table public\.omr_operational_job_status enable row level security/i,
        );
        expect(operationalJobStatusMigration).toMatch(
            /alter table public\.omr_operational_job_status force row level security/i,
        );
        expect(operationalJobStatusMigration).toContain("security definer");
        expect(operationalJobStatusMigration).toContain("set search_path = ''");
        expect(operationalJobStatusMigration).toMatch(/on conflict \(job_key\) do update/i);
        expect(operationalJobStatusMigration).not.toContain("p_dead_count");
        expect(operationalJobStatusMigration).not.toContain("p_attempted_at");
        expect(operationalJobStatusMigration).toContain("latest_started_sequence");
        expect(operationalJobStatusMigration).toContain("latest_completed_sequence");
        expect(operationalJobStatusMigration).toContain("active_lease_until");
        expect(operationalJobStatusMigration).toContain("active_lease_started_at");
        expect(operationalJobStatusMigration).toContain("interval '15 minutes'");
        expect(operationalJobStatusMigration).toMatch(
            /active_lease_until = active_lease_started_at \+ interval '15 minutes'/i,
        );
        expect(operationalJobStatusMigration).toContain("v_now + interval '15 minutes'");
        expect(operationalJobStatusMigration).toContain("'admitted', false");
        expect(operationalJobStatusMigration).toContain("'busy', true");
        expect(operationalJobStatusMigration).toContain("'duplicate', v_duplicate");
        expect(operationalJobStatusMigration).toContain("operational job completion conflict");
        expect(operationalJobStatusMigration).toMatch(
            /greatest\([\s\S]{0,240}v_job_status\.last_attempt_at \+ interval '1 microsecond'/i,
        );
        expect(operationalJobStatusMigration).toContain("create sequence public.omr_operational_job_run_sequence");
        expect(operationalJobStatusMigration).toContain("maxvalue 9007199254740991");
        expect(operationalJobStatusMigration).toContain("pg_advisory_xact_lock");
        expect(operationalJobStatusMigration).toContain("pg_catalog.clock_timestamp()");
        expect(operationalJobStatusMigration).not.toContain(
            "where excluded.last_attempt_at > current_status.last_attempt_at",
        );
        expect(operationalJobStatusMigration).toMatch(
            /create index[\s\S]*omr_remote_asset_cleanup_dead_idx[\s\S]*where status = 'dead'/i,
        );
        expect(operationalJobStatusMigration).toMatch(
            /count\(\*\)[\s\S]*omr_remote_asset_cleanup_queue[\s\S]*status = 'dead'/i,
        );
        expect(operationalJobStatusMigration).toMatch(
            /omr_begin_operational_job_run_v1[\s\S]*returns jsonb/i,
        );
        expect(operationalJobStatusMigration).toMatch(
            /omr_complete_operational_job_run_v1[\s\S]*returns jsonb/i,
        );
        expect(operationalJobStatusMigration).toContain("'deadCount', v_dead_count");
        expect(operationalJobStatusMigration).toContain("'dead_backlog'");
        expect(operationalJobStatusMigration).toMatch(
            /v_job_status\.last_attempt_at \+ interval '1 microsecond'/i,
        );
        expect(operationalJobStatusMigration).toMatch(
            /when v_effective_status = 'healthy' then v_recorded_at\s+else last_success_at/i,
        );
        for (const role of ["public", "anon", "authenticated"]) {
            expect(operationalJobStatusMigration).toMatch(
                new RegExp(`from public, anon, authenticated`, "i"),
            );
            expect(liveAssertions).toContain(
                `operational job status exposed to ${role}`,
            );
        }
        expect(liveAssertions).toContain(
            "operational job status service role boundary failed",
        );
        expect(liveAssertions).toContain(
            "operational job older completion was not superseded",
        );
        expect(liveAssertions).toContain("operational job active lease admitted overlapping cleanup");
        expect(liveAssertions).toContain("operational job expired lease was not recovered");
        expect(liveAssertions).toContain("operational job rollback clock extended active lease");
        expect(liveAssertions).toContain("operational job wrong generation cleared active lease");
        expect(liveAssertions).toContain("operational job duplicate completion changed terminal state");
        expect(liveAssertions).toContain("operational job conflicting terminal replay was accepted");
        expect(liveAssertions).toContain("operational job expired lease completion was accepted");
        expect(liveAssertions).toContain("operational job mutable backlog broke idempotent completion");
        expect(liveAssertions).toContain("operational job concurrent begins did not admit exactly one cleanup");
        expect(liveAssertions).toContain(
            "operational job failure advanced last success",
        );
        expect(liveAssertions).toContain(
            "operational job status accepted malformed input",
        );
        expect(boundaryAssertions).toContain("public.omr_operational_job_status");
        expect(boundaryAssertions).toContain("public.omr_begin_operational_job_run_v1");
        expect(boundaryAssertions).toContain("public.omr_complete_operational_job_run_v1");
        for (const catalogAssertion of [
            "index_record.indrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass",
            "index_record.indisvalid",
            "index_record.indisready",
            "not index_record.indisunique",
            "index_record.indnatts = 1",
            "pg_catalog.pg_get_indexdef(index_record.indexrelid, 1, true) = 'status'",
            "pg_catalog.pg_get_expr",
        ]) expect(profile).toContain(catalogAssertion);
        for (const assertion of [
            "prosecdef",
            "pg_get_userbyid",
            "proconfig",
            "search_path=\"\"",
            "statement_timeout=5s",
            "lock_timeout=2s",
        ]) expect(profile).toContain(assertion);
        for (const leaseAssertion of [
            "attribute.attname = 'active_lease_until'",
            "attribute.attname = 'active_lease_started_at'",
            "timestamp with time zone",
            "v_job_status.active_lease_until > v_now",
            "active_lease_until = null",
            "interval ''15 minutes''",
            "''duplicate'', v_duplicate",
            "operational job completion conflict",
        ]) expect(profile).toContain(leaseAssertion);
        expect(rollback).toContain(
            "revoke all on table public.omr_operational_job_status from public, anon, authenticated, service_role",
        );
        expect(rollback).toContain("'omr_begin_operational_job_run_v1'");
        expect(rollback).toContain("'omr_complete_operational_job_run_v1'");
        expect(rollback).toContain("'omr_read_operational_job_status_v1'");
        expect(rollback.match(
            /revoke all on sequence public\.omr_operational_job_run_sequence/g,
        )).toHaveLength(1);
    });

    it("documents the canonical final-schema contract and exact table count", () => {
        const expectedCanonicalTableCount = CANONICAL_TABLES.length;
        for (const document of [
            productionReadiness,
            read("docs/operations/backup-restore-runbook.md"),
            supabaseReadme,
        ]) {
            expect(document).toContain("schema.sql baseline + sorted migrations = final schema");
            expect(document).toMatch(
                new RegExp(`canonical ${expectedCanonicalTableCount}(?:개| tables)`, "i"),
            );
        }
        expect(read("docs/initial-ops-user-journey-audit-2026-08-07.md"))
            .toContain(`${expectedCanonicalTableCount}개 canonical 테이블 FORCE RLS`);
    });

    it("integrates durable rate limits, cleanup epochs, revisioned exams, and feedback CAS into the exact boundary", () => {
        for (const table of ["omr_rate_limit_buckets", "omr_exam_mutations", "omr_feedback_mutations"]) {
            expect(profile).toContain(`revoke all on table public.${table} from public, anon, authenticated, service_role`);
        }
        for (const signature of [
            "public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)",
            "public.omr_ack_remote_asset_cleanup_v1(text,text,integer)",
            "public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)",
            "public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)",
            "public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)",
            "public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)",
            "public.omr_save_feedback_v2(text,jsonb,bigint,text)",
            "public.omr_return_feedback_v2(text,text,bigint,text)",
            "public.omr_save_feedback_v3(text,jsonb,bigint,text)",
            "public.omr_return_feedback_v3(text,text,bigint,text)",
        ]) {
            expect(profile).toContain(signature);
        }
        for (const legacySignature of [
            "public.omr_ack_remote_asset_cleanup_v1(text,text)",
            "public.omr_fail_remote_asset_cleanup_v1(text,text,text)",
            "public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)",
            "public.omr_save_feedback_v1(text,jsonb)",
            "public.omr_return_feedback_v1(text,text,timestamptz)",
        ]) {
            expect(profile).toContain(`revoke execute on function ${legacySignature} from service_role`);
        }
        expect(profile).toContain(
            "revoke all on function public.omr_normalize_exam_save_request_v10(jsonb)",
        );
        expect(profile).toContain("'version', '202608080010'");
        expect(profile).toContain("'operationalJobStatusReady'");
        expect(profile).toContain("'durableRateLimitsReady'");
        expect(profile).toContain("'teacherExamCasReady'");
        expect(profile).toContain("'examRevisionReady'");
        expect(profile).toContain("'feedbackCasReady'");
        expect(profile).toContain("'workspaceBootstrapPlanSafe'");
        expect(profile).toContain("'feedbackReplayHardeningReady'");
        expect(profile).toContain("'feedbackCoreFreeReady'");
        expect(profile).toContain("'sessionCleanupFencingReady'");
        expect(profile).toContain("'attemptCheckpointNullCasReady'");
        expect(profile).toContain("'rosterSnapshotCasReady'");
        expect(profile).toContain(
            "revoke all on table public.omr_initial_ops_metrics from public, anon, authenticated, service_role",
        );
        expect(profile).toContain("'initialOperationsLoadControlReady'");
        expect(profile).toContain("'omr_initial_ops_reserve_upload_v1'");
    });

    it("removes every known alpha and browser-auth policy by explicit name", () => {
        const browserPolicies = [
            ...createdPolicies(schema),
            ...createdPolicies(legacyProductionProfile),
        ];
        expect(browserPolicies.length).toBeGreaterThan(60);

        for (const policy of browserPolicies) {
            expect(profile, `missing explicit drop for ${policy.name}`).toContain(
                `drop policy if exists "${policy.name}" on public.${policy.table};`,
            );
        }

        expect(profile).not.toMatch(/\bcreate\s+policy\b[\s\S]{0,160}\bon\s+public\./i);
    });

    it("applies migrations, the server-only profile, and assertions in release-gate order", () => {
        const migrationIndex = verifier.indexOf("for (const migration of migrations)");
        const profileIndex = verifier.indexOf('psqlFile("supabase/production-server-boundary.sql")');
        const assertionsIndex = verifier.indexOf('psqlFile("supabase/live-test-assertions.sql")');

        expect(migrationIndex).toBeGreaterThan(-1);
        expect(profileIndex).toBeGreaterThan(migrationIndex);
        expect(assertionsIndex).toBeGreaterThan(profileIndex);
        expect(verifier).not.toContain('psqlFile("supabase/production-rls.sql")');
        expect(ci).toContain("supabase-live-contract:");
        expect(ci).toContain("node scripts/verify-supabase-live.mjs");
    });

    it("runs transient credential DDL as the migration owner before restoring service role", () => {
        const credentialDdl = liveAssertions.indexOf(
            "alter table public.omr_student_start_credentials alter column start_code_hash drop not null",
        );
        expect(credentialDdl).toBeGreaterThan(-1);
        expect(liveAssertions.lastIndexOf("reset role;", credentialDdl))
            .toBeGreaterThan(liveAssertions.lastIndexOf("set role service_role;", credentialDdl));
        expect(liveAssertions.indexOf("set role service_role;", credentialDdl))
            .toBeGreaterThan(credentialDdl);
    });

    it("proves exhaustive browser denial while retaining service-role execution and documents the gate", () => {
        const liveAssertionsWithoutTransactionalDrift = liveAssertions.replace(
            /-- BEGIN v4 transient readiness drift probes[\s\S]*?-- END v4 transient readiness drift probes/i,
            "",
        );
        expect(liveAssertionsWithoutTransactionalDrift).not.toMatch(
            /grant\s+(?:select|insert|update|delete|all)[\s\S]{0,100}\bto\s+(?:anon|authenticated)\b/i,
        );
        expect(liveAssertions).toContain("browser roles unexpectedly retain an OMR table privilege");
        expect(liveAssertions).toContain("browser roles unexpectedly retain an OMR sequence privilege");
        expect(liveAssertions).toContain("browser roles unexpectedly retain a public function privilege");
        expect(liveAssertions).toContain("service_role lost a public function execute privilege");
        expect(liveAssertions).toContain("production server boundary left an alpha or browser policy");
        expect(liveAssertions).toContain("production server boundary must ENABLE and FORCE RLS");
        expect(liveAssertions).toContain("authenticated SELECT unexpectedly reached canonical tables");
        expect(liveAssertions).toContain("anon DELETE unexpectedly reached canonical tables");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("production-server-boundary.sql");
            expect(document).toContain("omr_assert_production_boundary_preflight_v1");
            expect(document).toContain("npm run test:supabase:live");
            expect(document).toMatch(/schema\.sql[\s\S]*migrations[\s\S]*production-server-boundary\.sql[\s\S]*live-test-assertions\.sql/i);
        }
        expect(productionReadiness).toContain("CI");
        expect(productionReadiness).toContain("커밋 SHA");
        expect(productionReadiness).toContain("정책 해시");
    });

    it("treats the legacy assignment-submission update as an expected denial without mutation", () => {
        expect(liveAssertions).toMatch(
            /set role authenticated;[\s\S]*?begin\s+begin\s+update public\.omr_assignment_submissions[\s\S]*?raise exception 'authenticated assignment submission UPDATE unexpectedly succeeded';\s+exception when insufficient_privilege then null;\s+end;/i,
        );
        expect(liveAssertions).toContain(
            "authenticated assignment submission denial mutated canonical gradebook row",
        );
    });

    it("uses the hosted Storage owner to install restrictive target-bucket policies without managed ACL mutations", () => {
        expect(livePrelude).toContain("create role supabase_storage_admin");
        expect(livePrelude).toContain("grant supabase_storage_admin to postgres with set true");
        expect(livePrelude).toContain("create table if not exists storage.objects");
        expect(livePrelude).toContain("alter table storage.objects owner to supabase_storage_admin");
        expect(livePrelude).toContain("alter table storage.buckets owner to supabase_storage_admin");
        expect(livePrelude).toContain('create policy "OMR private assets alpha access"');
        expect(livePrelude).toContain('create policy "Third-party browser object access"');
        expect(livePrelude).toContain('create policy "Third-party browser bucket access"');

        expect(profile).toMatch(
            /pg_has_role\(\s*session_user,\s*'supabase_storage_admin',\s*'SET'\s*\)/i,
        );
        expect(profile).toContain("set local role supabase_storage_admin");
        const storageOwnerIndex = profile.indexOf("set local role supabase_storage_admin");
        const resetRoleIndex = profile.indexOf("reset role;", storageOwnerIndex);
        const publicRevokeIndex = profile.indexOf(
            "revoke all on schema public from public, anon, authenticated;",
        );
        expect(resetRoleIndex).toBeGreaterThan(storageOwnerIndex);
        expect(publicRevokeIndex).toBeGreaterThan(resetRoleIndex);
        expect(profile).toContain(
            'drop policy if exists "OMR private assets alpha access" on storage.objects',
        );
        expect(profile).toMatch(
            /create policy "OMR private assets server-only objects"\s+on storage\.objects\s+as restrictive\s+for all\s+to anon, authenticated\s+using \(bucket_id <> 'omr-private-assets'\)\s+with check \(bucket_id <> 'omr-private-assets'\);/i,
        );
        expect(profile).toMatch(
            /create policy "OMR private assets server-only buckets"\s+on storage\.buckets\s+as restrictive\s+for all\s+to anon, authenticated\s+using \(id <> 'omr-private-assets'\)\s+with check \(id <> 'omr-private-assets'\);/i,
        );
        expect(profile).toContain("reset role;");
        expect(profile).not.toMatch(
            /\b(?:revoke|grant)\b[^;]*\bon\s+(?:table\s+)?storage\.(?:objects|buckets)\b/i,
        );
        expect(profile).not.toMatch(
            /\balter\s+table\s+storage\.(?:objects|buckets)\s+owner\s+to\b/i,
        );
        expect(profile).not.toMatch(/\bpolicyname\s+ilike\b/i);
        expect(profile).not.toContain("for app_policy in");

        expect(liveAssertions).toContain("Storage relation owner drifted from supabase_storage_admin");
        expect(liveAssertions).toContain("OMR restrictive Storage policy contract mismatch");
        expect(liveAssertions).toContain("unrelated third-party Storage policy was changed");
        expect(liveAssertions).toContain("anon target Storage SELECT unexpectedly succeeded");
        expect(liveAssertions).toContain("authenticated target Storage DELETE unexpectedly succeeded");
        expect(liveAssertions).toContain("other-bucket Storage policy no longer permits browser access");
        expect(liveAssertions).toContain("service_role Storage CRUD probe failed");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("supabase_storage_admin");
            expect(document).toContain("storage.objects");
            expect(document).toMatch(/AS RESTRICTIVE|제한 정책/i);
            expect(document).toContain("https://supabase.com/docs/guides/platform/permissions");
            expect(document).toContain("https://supabase.com/docs/guides/storage/security/access-control");
        }
    });

    it("pins migrations and default privileges to postgres and proves future functions stay server-only", () => {
        expect(verifier).toContain('const migrationOwner = "postgres"');
        expect(verifier).toContain('"psql", "-U", migrationOwner');

        expect(profile).toContain("current_user is distinct from 'postgres'");
        expect(profile).toContain("production boundary must run as migration owner postgres");
        expect(profile).toMatch(
            /alter default privileges for role postgres\s+revoke execute on functions from public;/i,
        );
        expect(profile).toMatch(
            /alter default privileges for role postgres in schema public\s+revoke all on functions from anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /alter default privileges for role postgres in schema public\s+grant all on functions to service_role;/i,
        );

        expect(liveAssertions).toContain("pg_default_acl retained PUBLIC function execute");
        expect(liveAssertions).toContain("pg_default_acl lost service_role public function execute");
        expect(liveAssertions).toContain("omr_default_acl_probe_v1");
        expect(liveAssertions).toContain("browser role executed a default-ACL probe function");
        expect(liveAssertions).toContain("service_role could not execute the default-ACL probe function");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("postgres");
            expect(document).toMatch(/single migration owner|단일 migration owner/i);
        }
    });
});
