import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as studentSessions from "./studentServerSession";

const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202608080009_student_session_generation.sql",
);

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function migration(): string {
    return existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
}

const productionEnv = {
    NODE_ENV: "production",
    STUDENT_SESSION_SECRET: "student-session-secret-at-least-32-bytes",
};

const registeredV2 = {
    kind: "student" as const,
    accountId: `student_credential_${"a".repeat(32)}`,
    organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
    studentId: "student-1",
    name: "김학생",
    identityType: "registered" as const,
    credentialGeneration: 3,
};

describe("student session generation revocation", () => {
    it("signs an exact version-2 registered session with a bounded generation", () => {
        const cookie = studentSessions.createSignedStudentSessionCookie(
            registeredV2,
            productionEnv,
            1_000,
        );
        const decoded = studentSessions.parseSignedStudentSessionCookie(
            cookie,
            productionEnv,
            2_000,
        );

        expect(decoded).toMatchObject({
            version: 2,
            accountId: `student_credential_${"a".repeat(32)}`,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "student-1",
            credentialGeneration: 3,
        });
    });

    it("validates every registered request against the exact database generation", async () => {
        const cookie = studentSessions.createSignedStudentSessionCookie(
            registeredV2,
            productionEnv,
            1_000,
        );
        const validateStudentServerSession = (
            studentSessions as unknown as {
                validateStudentServerSession: (
                    rawCookie: string | null,
                    client: {
                        rpc(name: string, params: Record<string, unknown>): Promise<{
                            data: unknown;
                            error: { message?: string } | null;
                        }>;
                    },
                    env?: Record<string, string | undefined>,
                    now?: number,
                ) => Promise<unknown>;
            }
        ).validateStudentServerSession;
        const current = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
        const stale = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
        const unavailable = { rpc: vi.fn().mockRejectedValue(new Error("timeout")) };

        await expect(validateStudentServerSession(cookie, current, productionEnv, 2_000))
            .resolves.toMatchObject({ status: "active", identity: { credentialGeneration: 3 } });
        expect(current.rpc).toHaveBeenCalledWith("omr_validate_student_session_v1", {
            p_account_id: `student_credential_${"a".repeat(32)}`,
            p_organization_id: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            p_student_id: "student-1",
            p_credential_generation: 3,
        });
        await expect(validateStudentServerSession(cookie, stale, productionEnv, 2_000))
            .resolves.toEqual({ status: "unauthenticated" });
        await expect(validateStudentServerSession(cookie, unavailable, productionEnv, 2_000))
            .resolves.toEqual({ status: "service_unavailable" });
    });

    it("bounds a hung validation gateway and rejects malformed success envelopes", async () => {
        const cookie = studentSessions.createSignedStudentSessionCookie(
            registeredV2,
            productionEnv,
            1_000,
        );
        const validateStudentServerSession = (
            studentSessions as unknown as {
                validateStudentServerSession: (
                    rawCookie: string | null,
                    client: { rpc: ReturnType<typeof vi.fn> },
                    env?: Record<string, string | undefined>,
                    now?: number,
                ) => Promise<unknown>;
            }
        ).validateStudentServerSession;

        vi.useFakeTimers();
        try {
            const pending = validateStudentServerSession(
                cookie,
                { rpc: vi.fn(() => new Promise(() => undefined)) },
                productionEnv,
                2_000,
            );
            await vi.advanceTimersByTimeAsync(studentSessions.STUDENT_SESSION_VALIDATION_TIMEOUT_MS);
            await expect(pending).resolves.toEqual({ status: "service_unavailable" });
        } finally {
            vi.useRealTimers();
        }

        for (const data of ["true", 1, {}, [true], null]) {
            await expect(validateStudentServerSession(
                cookie,
                { rpc: vi.fn().mockResolvedValue({ data, error: null }) },
                productionEnv,
                2_000,
            )).resolves.toEqual({ status: "unauthenticated" });
        }
    });

    it("rejects malformed generations and registered version-1 cookies", async () => {
        const legacyPayload = Buffer.from(JSON.stringify({
            audience: "omr-student",
            schemaVersion: 1,
            kind: "student",
            studentId: "student-1",
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            name: "김학생",
            studentName: "김학생",
            identityType: "registered",
            issuedAt: 1_000,
            expiresAt: 43_201_000,
        })).toString("base64url");
        const legacySignature = createHmac("sha256", productionEnv.STUDENT_SESSION_SECRET)
            .update(legacyPayload, "utf8")
            .digest("base64url");
        const legacy = `${legacyPayload}.${legacySignature}`;

        const legacyGuestPayload = Buffer.from(JSON.stringify({
            audience: "omr-student",
            schemaVersion: 1,
            kind: "guest",
            guestId: "guest-cutover",
            studentId: "guest:guest-cutover",
            name: "기존 게스트",
            studentName: "기존 게스트",
            identityType: "guest",
            issuedAt: 1_000,
            expiresAt: 43_201_000,
        })).toString("base64url");
        const legacyGuestSignature = createHmac("sha256", productionEnv.STUDENT_SESSION_SECRET)
            .update(legacyGuestPayload, "utf8")
            .digest("base64url");

        expect(studentSessions.parseSignedStudentSessionCookie(legacy, productionEnv, 2_000)).toBeNull();
        expect(studentSessions.parseSignedStudentSessionCookie(
            `${legacyGuestPayload}.${legacyGuestSignature}`,
            productionEnv,
            2_000,
        )).toMatchObject({
            version: 2,
            schemaVersion: 2,
            kind: "guest",
            guestId: "guest-cutover",
        });
        for (const credentialGeneration of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "3"]) {
            const malformed = studentSessions.createSignedStudentSessionCookie({
                ...registeredV2,
                credentialGeneration: credentialGeneration as number,
            }, productionEnv, 1_000);
            expect(malformed).toBeNull();
        }
        for (const accountId of ["", "student-1", "x".repeat(257)]) {
            expect(studentSessions.createSignedStudentSessionCookie({
                ...registeredV2,
                accountId,
            }, productionEnv, 1_000)).toBeNull();
        }
    });

    it("keeps guest sessions local to the signed guest boundary", async () => {
        const guest = studentSessions.createSignedStudentSessionCookie({
            kind: "guest",
            guestId: "guest-1",
            name: "게스트",
            identityType: "guest",
        }, productionEnv, 1_000);
        const validateStudentServerSession = (
            studentSessions as unknown as {
                validateStudentServerSession: (
                    rawCookie: string | null,
                    client: { rpc: ReturnType<typeof vi.fn> },
                    env?: Record<string, string | undefined>,
                    now?: number,
                ) => Promise<unknown>;
            }
        ).validateStudentServerSession;
        const client = { rpc: vi.fn() };

        await expect(validateStudentServerSession(guest, client, productionEnv, 2_000))
            .resolves.toMatchObject({ status: "active", identity: { kind: "guest", guestId: "guest-1" } });
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("installs durable monotonic generation, atomic rotation, and exact validation", () => {
        const sql = migration();

        expect(sql).toContain("add column credential_generation integer not null default 1");
        expect(sql).toContain("omr_student_profiles");
        expect(sql).toContain("omr_student_start_credentials");
        expect(sql).toContain("create function public.omr_validate_student_session_v1(");
        expect(sql).toContain("p_account_id text");
        expect(sql).toContain("p_organization_id text");
        expect(sql).toContain("p_student_id text");
        expect(sql).toContain("p_credential_generation integer");
        expect(sql).toContain("create function public.omr_rotate_student_start_credential_v1(");
        expect(sql).toContain("for update");
        expect(sql).toMatch(/credential_generation\s*=\s*[^;]+credential_generation\s*\+\s*1/i);
        expect(sql).toContain("omr_revoke_student_session_on_status_v2");
        expect(sql).toContain("delete from public.omr_student_start_credentials");
        expect(sql).toContain("grant execute on function public.omr_validate_student_session_v1");
        expect(sql).toContain("grant execute on function public.omr_rotate_student_start_credential_v1");
        expect(sql).toContain("login-eligible invited or active student credential incarnation");
        expect(sql).not.toMatch(/grant execute[^;]+\bto\s+(anon|authenticated)\b/i);

        const boundary = source("supabase/production-server-boundary.sql");
        expect(boundary).toContain("student-session-generation-routines:202608080009");
        expect(boundary).toContain("student-session-generation-triggers:202608080009");
        expect(boundary).toContain("student-session-generation-constraints:202608080009");
        expect(boundary).toContain("student-session-generation-normalized-indexes:202608080009");
        expect(source("supabase/live-test-boundary-assertions.sql")).toContain(
            "student session readiness accepted credential index drift",
        );
    });

    it("routes registered canonical actions through one async authorized resolver", () => {
        const actionPaths = [
            "src/app/actions/studentAttemptSession.ts",
            "src/app/actions/studentAttempt.ts",
            "src/app/actions/studentAttempts.ts",
            "src/app/actions/feedback.ts",
            "src/app/actions/remoteAssets.ts",
            "src/app/actions/studentExam.ts",
            "src/app/actions/studentSession.ts",
        ];

        for (const path of actionPaths) {
            const action = source(path);
            expect(action, path).toContain("resolveAuthorizedStudentSessionCookie");
            expect(action, path).not.toContain("parseSignedStudentSessionCookie");
        }
        const studentAttempt = source("src/app/actions/studentAttempt.ts");
        const openExport = studentAttempt.slice(
            studentAttempt.indexOf("export async function openStudentExam"),
            studentAttempt.indexOf("export async function submitStudentAttempt"),
        );
        const submitExport = studentAttempt.slice(
            studentAttempt.indexOf("export async function submitStudentAttempt"),
        );
        expect(openExport).toContain("resolveAuthorizedStudentSessionCookie");
        expect(submitExport).toContain("resolveAuthorizedStudentSessionCookie");
        expect(submitExport).toContain("claims.organizationId !== session.organizationId");
        expect(source("src/app/actions/studentAuth.ts")).toContain(
            'rpc("omr_rotate_student_start_credential_v1"',
        );
        expect(source("src/app/actions/studentAuth.ts")).not.toContain(
            '.from("omr_student_start_credentials").upsert',
        );
    });
});
