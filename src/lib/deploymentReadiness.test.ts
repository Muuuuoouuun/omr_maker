import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDeploymentReadiness } from "./deploymentReadiness";
import { TEACHER_PASSWORD_HASH_MIN_ITERATIONS } from "./teacherAuth";

function teacherPasswordHash(password: string, saltHex = "00112233445566778899aabbccddeeff"): string {
    const iterations = TEACHER_PASSWORD_HASH_MIN_ITERATIONS;
    const hashHex = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, 32, "sha256").toString("hex");
    return `pbkdf2-sha256:${iterations}:${saltHex}:${hashHex}`;
}

const STRONG_TEACHER_SESSION_SECRET = "teacher-session-secret-at-least-32-bytes";
const STRONG_STUDENT_SESSION_SECRET = "student-session-secret-at-least-32-bytes";
const STRONG_STUDENT_ATTEMPT_SECRET = "student-attempt-secret-at-least-32-bytes";

const readyDatabaseProbe = {
    ready: true,
    version: "202608080006",
    browserSchemaPrivilegesDenied: true,
    anonTablePrivilegesDenied: true,
    authenticatedCanonicalPrivilegesDenied: true,
    browserSequencePrivilegesDenied: true,
    browserFunctionPrivilegesDenied: true,
    alphaPoliciesAbsent: true,
    canonicalTablesForceRls: true,
    canonicalPoliciesAbsent: true,
    organizationBackfillReady: true,
    serviceRolePrivilegesReady: true,
    scopedRpcPrivilegesReady: true,
    hostedStorageBoundaryReady: true,
    serverGatewayCapabilitiesReady: true,
    queryPathIndexesReady: true,
    legacyBroadRpcsRemoved: true,
    directUploadIntentLifecycleReady: true,
    teacherUploadCleanupQueueReady: true,
    teacherAssetFinalizePreauthorizationReady: true,
    examReservationLeaseReady: true,
    teacherAssetCleanupBacklogHealthy: true,
    studentAttemptSessionsReady: true,
    durableRateLimitsReady: true,
    examRevisionReady: true,
    teacherExamCasReady: true,
    teacherNotificationSummaryReady: true,
    teacherNotificationStateReady: true,
    feedbackRevisionReady: true,
    feedbackCasReady: true,
    workspaceBootstrapPlanSafe: true,
    sessionCleanupOptimizationReady: true,
    feedbackReplayHardeningReady: true,
    feedbackCoreFreeReady: true,
    examEntryInvitesReady: true,
    sessionCleanupFencingReady: true,
    attemptCheckpointNullCasReady: true,
    rosterSnapshotCasReady: true,
    attemptMutationCasReady: true,
    examDeleteSessionSafe: true,
    studentQuestionAtomicReady: true,
    teacherLiveSessionsReady: true,
    teacherAccountLifecycleReady: true,
    initialOperationsLoadControlReady: true,
    individualStudentAssignmentsReady: true,
    teacherAttemptReportingReady: true,
    operationalJobStatusReady: true,
    operatorPilotProvisioningReady: true,
    failedChecks: [],
};

describe("deployment readiness", () => {
    it("flags production teacher login when no server credentials exist", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
        });

        expect(summary).toMatchObject({
            label: "배포 확인 필요",
            credentialCount: 0,
        });
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_credentials",
            tone: "error",
            detail: expect.stringContaining("TEACHER_ACCOUNTS"),
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_session_secret",
            tone: "error",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_session_secret",
            tone: "error",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "rate_limit_hash_secret",
            tone: "error",
            detail: expect.stringContaining("OMR_RATE_LIMIT_HASH_SECRET"),
        }));
    });

    it("accepts the private database teacher lifecycle without bootstrap credentials", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, readyDatabaseProbe);

        expect(summary.credentialCount).toBe(0);
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_credentials",
            tone: "ready",
            detail: expect.stringContaining("DB 교사 계정 수명주기"),
        }));
        expect(JSON.stringify(summary)).not.toContain("로그인 판별은 Supabase가 아니라");
    });

    it("fails closed when production has browser sync but no server grading gateway", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "director",
            TEACHER_PASSWORD: "super-secret",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        });

        // Missing service-role key in production with public sync is an error:
        // the student server boundary (answer hiding, server grading) would
        // silently degrade to client trust.
        expect(summary.label).toBe("배포 확인 필요");
        expect(summary.credentialCount).toBe(0);
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_credentials",
            tone: "error",
            detail: expect.stringContaining("passwordHash"),
        }));
        // In production a dedicated TEACHER_SESSION_SECRET is required: the app
        // no longer falls back to signing cookies with the teacher password, so
        // a production env missing the secret is a hard error, not a warning.
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_session_secret",
            tone: "error",
            detail: expect.stringContaining("TEACHER_SESSION_SECRET"),
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_session_secret",
            tone: "error",
            detail: expect.stringContaining("STUDENT_SESSION_SECRET"),
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_attempt_secret",
            tone: "error",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "supabase_service_role",
            tone: "error",
            detail: expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY"),
        }));
        expect(JSON.stringify(summary)).not.toContain("super-secret");
    });

    it("keeps the missing service-role key as a warning outside production", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "development",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
        });

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "supabase_service_role",
            tone: "warning",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_session_secret",
            tone: "warning",
        }));
    });

    it("rejects short signing secrets in production while preserving local fixtures", () => {
        const production = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{
                id: "teacher-a",
                passwordHash: teacherPasswordHash("pass-a"),
            }]),
            TEACHER_SESSION_SECRET: "short-teacher-secret",
            STUDENT_SESSION_SECRET: "short-student-secret",
            STUDENT_ATTEMPT_SECRET: "short-attempt-secret",
        });

        for (const key of ["teacher_session_secret", "student_session_secret", "student_attempt_secret"]) {
            expect(production.checks).toContainEqual(expect.objectContaining({
                key,
                tone: "error",
                detail: expect.stringContaining("32바이트"),
            }));
        }

        const coupledStudentSecrets = buildDeploymentReadiness({
            NODE_ENV: "production",
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
        });
        expect(coupledStudentSecrets.checks).toContainEqual(expect.objectContaining({
            key: "student_session_secret",
            tone: "error",
            detail: expect.stringContaining("STUDENT_SESSION_SECRET"),
        }));
        expect(coupledStudentSecrets.checks).toContainEqual(expect.objectContaining({
            key: "student_attempt_secret",
            tone: "ready",
        }));

        const development = buildDeploymentReadiness({
            NODE_ENV: "development",
            TEACHER_SESSION_SECRET: "local-teacher",
            STUDENT_SESSION_SECRET: "local-student",
            STUDENT_ATTEMPT_SECRET: "local-attempt",
        });
        for (const key of ["teacher_session_secret", "student_session_secret", "student_attempt_secret"]) {
            expect(development.checks).toContainEqual(expect.objectContaining({ key, tone: "ready" }));
        }
    });

    it("recognizes explicit server session and service role readiness", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_SESSION_SECRET: STRONG_STUDENT_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            OMR_RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-at-least-thirty-two-bytes",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
            OMR_ASSET_GC_SCHEDULED: "1",
            CRON_SECRET: "cron-secret-that-is-at-least-thirty-two-characters",
            OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/events",
            OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
        }, readyDatabaseProbe);

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_session_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_attempt_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "canonical_browser_boundary",
            tone: "ready",
            detail: expect.stringContaining("운영 브라우저 canonical CRUD는 비활성"),
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "supabase_service_role",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_session_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            tone: "ready",
            detail: expect.stringContaining("실효 권한"),
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "remote_asset_cleanup_schedule",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "rate_limit_hash_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "operational_event_sink",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_account_delivery",
            tone: "error",
            detail: expect.stringContaining("이메일 delivery adapter"),
        }));
        expect(summary.readyCount).toBe(10);
    });

    it("fails production readiness when the central operational sink is missing or invalid", () => {
        const missing = buildDeploymentReadiness({ NODE_ENV: "production" });
        expect(missing.checks).toContainEqual(expect.objectContaining({
            key: "operational_event_sink",
            tone: "error",
            detail: expect.stringContaining("OMR_OPERATIONAL_SINK_URL"),
        }));

        const invalid = buildDeploymentReadiness({
            NODE_ENV: "production",
            OMR_OPERATIONAL_SINK_URL: "http://ops.example.test/events",
            OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
        });
        expect(invalid.checks).toContainEqual(expect.objectContaining({
            key: "operational_event_sink",
            tone: "error",
            detail: expect.stringContaining("HTTPS"),
        }));
    });

    it("rejects a short production rate-limit hash secret", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            OMR_RATE_LIMIT_HASH_SECRET: "too-short",
        });

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "rate_limit_hash_secret",
            tone: "error",
            detail: expect.stringContaining("32바이트"),
        }));
    });

    it("recognizes only a complete teacher account delivery webhook configuration", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/omr/accounts",
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "delivery_secret_0123456789_abcdef_0123456789",
        });
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_account_delivery",
            tone: "ready",
        }));
    });

    it("fails production readiness when remote asset cleanup is not explicitly scheduled", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_SESSION_SECRET: STRONG_STUDENT_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        }, readyDatabaseProbe);

        expect(summary.label).toBe("배포 확인 필요");
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "remote_asset_cleanup_schedule",
            tone: "error",
            detail: expect.stringContaining("OMR_ASSET_GC_SCHEDULED"),
        }));
    });

    it("reports actionable v6 boundary failures without exposing database payloads", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_SESSION_SECRET: STRONG_STUDENT_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        }, {
            ...readyDatabaseProbe,
            ready: false,
            browserFunctionPrivilegesDenied: false,
            organizationBackfillReady: false,
            failedChecks: [
                "browserFunctionPrivilegesDenied",
                "organizationBackfillReady",
            ],
            error: "student 김학생 raw-private-id",
        });

        const rls = summary.checks.find(check => check.key === "production_rls");
        expect(rls).toMatchObject({
            tone: "error",
        });
        expect(rls?.detail).toContain("브라우저 함수 권한 차단");
        expect(rls?.detail).toContain("조직 무결성 preflight");
        expect(JSON.stringify(summary)).not.toContain("김학생");
        expect(JSON.stringify(summary)).not.toContain("raw-private-id");
    });

    it("names missing cross-device teacher notification state readiness", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_SESSION_SECRET: STRONG_STUDENT_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        }, {
            ...readyDatabaseProbe,
            ready: false,
            teacherNotificationStateReady: false,
            failedChecks: ["teacherNotificationStateReady"],
        });

        expect(summary.checks.find(check => check.key === "production_rls")?.detail)
            .toContain("교사 알림 다중 기기 상태 gateway");
    });

    it("does not report public Supabase keys as production browser synchronization", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
        });

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "canonical_browser_boundary",
            label: "운영 브라우저 데이터 경계",
            tone: "ready",
            detail: expect.stringContaining("publishable key"),
        }));
        expect(JSON.stringify(summary)).not.toContain("Supabase 클라이언트 동기화");
        expect(JSON.stringify(summary)).not.toContain("공개 alpha RLS");
    });

    it("does not accept a production RLS flag without a live DB probe", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        });

        expect(summary.label).toBe("배포 확인 필요");
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            tone: "error",
            detail: expect.stringContaining("실제 DB"),
        }));
    });

    it("does not trust a caller-provided ready bit when v6 evidence is incomplete", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            STUDENT_SESSION_SECRET: STRONG_STUDENT_SESSION_SECRET,
            STUDENT_ATTEMPT_SECRET: STRONG_STUDENT_ATTEMPT_SECRET,
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        }, {
            ready: true,
            version: "202608080006",
        });

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            tone: "error",
        }));
    });

    it("keeps the browser boundary ready while reporting missing production server controls separately", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", password: "pass-a" }]),
            TEACHER_SESSION_SECRET: STRONG_TEACHER_SESSION_SECRET,
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
            // OMR_PRODUCTION_RLS_APPLIED intentionally unset
        });

        expect(summary.label).toBe("배포 확인 필요");
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "canonical_browser_boundary",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "supabase_service_role",
            tone: "error",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            tone: "warning",
        }));
    });
});
