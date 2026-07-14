import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDeploymentReadiness } from "./deploymentReadiness";

function teacherPasswordHash(password: string, saltHex = "00112233445566778899aabbccddeeff"): string {
    const iterations = 1_000;
    const hashHex = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, 32, "sha256").toString("hex");
    return `pbkdf2-sha256:${iterations}:${saltHex}:${hashHex}`;
}

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
        expect(summary.credentialCount).toBe(1);
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_credentials",
            tone: "warning",
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

    it("recognizes explicit server session and service role readiness", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: "session-secret",
            STUDENT_SESSION_SECRET: "student-session-secret",
            STUDENT_ATTEMPT_SECRET: "student-attempt-secret",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_PRODUCTION_RLS_APPLIED: "true",
        }, {
            ready: true,
            version: "202607140018",
            attemptRpc: true,
            sessionAttemptRpc: true,
            teacherExamRpc: true,
            teacherExamDeleteRpc: true,
            teacherAttemptRpc: true,
            teacherRosterRpc: true,
            handwritingRpc: true,
            feedbackSaveRpc: true,
            feedbackReturnRpc: true,
            feedbackOpenRpc: true,
            remoteAssetMetadataRpc: true,
            queryPathIndexes: true,
            legacyFeedbackRpcRemoved: true,
            examsForceRls: true,
            attemptsForceRls: true,
            questionResultsForceRls: true,
            studentCredentialsForceRls: true,
            remoteAssetsForceRls: true,
            rosterInvitesForceRls: true,
            attemptFeedbackForceRls: true,
        });

        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "teacher_session_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "student_attempt_secret",
            tone: "ready",
        }));
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "supabase_public_sync",
            tone: "ready",
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
        }));
        expect(summary.readyCount).toBe(7);
    });

    it("does not accept a production RLS flag without a live DB probe", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", passwordHash: teacherPasswordHash("pass-a") }]),
            TEACHER_SESSION_SECRET: "session-secret",
            STUDENT_ATTEMPT_SECRET: "student-attempt-secret",
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

    it("escalates to an error when production sync is on but production RLS is not confirmed", () => {
        const summary = buildDeploymentReadiness({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", email: "a@example.com", password: "pass-a" }]),
            TEACHER_SESSION_SECRET: "session-secret",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
            // OMR_PRODUCTION_RLS_APPLIED intentionally unset
        });

        expect(summary.label).toBe("배포 확인 필요");
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            tone: "error",
            detail: expect.stringContaining("공개 alpha RLS"),
        }));
    });
});
