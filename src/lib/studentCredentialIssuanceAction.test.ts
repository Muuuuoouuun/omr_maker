import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    role: undefined as "owner" | "admin" | "teacher" | "assistant" | "viewer" | undefined,
    adminClientCalls: 0,
    rpcCalls: [] as Array<Record<string, unknown>>,
    sameOrigin: true,
    adminAvailable: true,
    rpcStatus: "issued" as "issued" | "already_applied" | "unauthorized" | "throw",
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({ get: () => ({ value: "signed-teacher" }) }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => controls.sameOrigin,
}));

vi.mock("@/lib/teacherServerSession", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/teacherServerSession")>();
    return {
        ...actual,
        resolveAuthorizedTeacherSessionCookie: async () => ({
            schemaVersion: 1,
            role: "teacher",
            token: `tkn_test_${"a".repeat(32)}`,
            teacherId: "teacher_legacyaccount001",
            organizationId: "teacher_sharedqa",
            organizationName: "테스트 학원",
            memberRole: controls.role,
            sessionAuthority: "legacy_account",
            accountSessionGeneration: 2,
            issuedAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
        }),
    };
});

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => controls.adminAvailable
        ? ({ url: "https://example.supabase.co", serviceRoleKey: "service-role" })
        : null,
    createSupabaseAdminClient: () => {
        controls.adminClientCalls += 1;
        return {
            rpc: async (name: string, params: Record<string, unknown>) => {
                controls.rpcCalls.push({ name, ...params });
                if (controls.rpcStatus === "throw") throw new Error("secret database timeout");
                if (controls.rpcStatus === "unauthorized") {
                    return { data: { status: "unauthorized" }, error: null };
                }
                return {
                    data: {
                        status: controls.rpcStatus,
                        count: 1,
                        studentIds: [(params.p_items as Array<{ studentId: string }>)[0]?.studentId],
                    },
                    error: null,
                };
            },
        };
    },
}));

import {
    issueStudentCredentialBatch,
    issueStudentStartCredential,
} from "@/app/actions/studentAuth";

describe("student credential issuance action roles", () => {
    beforeEach(() => {
        controls.role = undefined;
        controls.adminClientCalls = 0;
        controls.rpcCalls = [];
        controls.sameOrigin = true;
        controls.adminAvailable = true;
        controls.rpcStatus = "issued";
    });

    it("rejects viewer and missing roles before resolving a service-role client", async () => {
        for (const role of ["viewer", undefined] as const) {
            controls.role = role;
            await expect(issueStudentStartCredential("student-1", `batch_${"V".repeat(32)}`)).resolves.toMatchObject({
                success: false,
            });
        }
        expect(controls.adminClientCalls).toBe(0);
        expect(controls.rpcCalls).toHaveLength(0);
    });

    it("allows each explicit write-capable role", async () => {
        for (const role of ["owner", "admin", "teacher", "assistant"] as const) {
            controls.role = role;
            const requestKey = `batch_${role.padEnd(32, "A")}`;
            await expect(issueStudentStartCredential(`student-${role}`, requestKey)).resolves.toMatchObject({
                success: true,
                startCode: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/),
            });
        }
        expect(controls.adminClientCalls).toBe(4);
        expect(controls.rpcCalls).toHaveLength(4);
        expect(controls.rpcCalls.every(call => call.name === "omr_issue_student_start_code_batch_v1")).toBe(true);
        expect(controls.rpcCalls.every(call => Array.isArray(call.p_items) && (call.p_items as unknown[]).length === 1)).toBe(true);
    });

    it("rejects cross-origin and 0/101 batches before resolving an admin client", async () => {
        controls.role = "owner";
        await expect(issueStudentCredentialBatch(["student-1"], undefined)).resolves.toEqual({
            status: "rejected",
            error: "invalid_input",
        });
        controls.sameOrigin = false;
        await expect(issueStudentCredentialBatch(["student-1"], `batch_${"O".repeat(32)}`)).resolves.toEqual({
            status: "rejected",
            error: "forbidden",
        });
        controls.sameOrigin = true;
        await expect(issueStudentCredentialBatch([], `batch_${"P".repeat(32)}`)).resolves.toEqual({
            status: "rejected",
            error: "invalid_input",
        });
        await expect(issueStudentCredentialBatch(
            Array.from({ length: 101 }, (_, index) => `student-${index}`),
            `batch_${"Q".repeat(32)}`,
        ))
            .resolves.toEqual({ status: "rejected", error: "capacity_exceeded" });
        expect(controls.adminClientCalls).toBe(0);
        expect(controls.rpcCalls).toHaveLength(0);
    });

    it("returns stable issued, replay-without-secret, and outcome-unknown batch results", async () => {
        controls.role = "owner";
        const issued = await issueStudentCredentialBatch(["student-1"], `batch_${"A".repeat(32)}`);
        expect(issued).toMatchObject({
            status: "issued",
            credentials: [{ studentId: "student-1", startCode: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/) }],
        });

        controls.rpcStatus = "already_applied";
        await expect(issueStudentCredentialBatch(["student-1"], `batch_${"B".repeat(32)}`)).resolves.toEqual({
            status: "already_applied",
            error: "replayed_without_credentials",
            idempotencyKey: `batch_${"B".repeat(32)}`,
        });
        controls.rpcStatus = "throw";
        const unknown = await issueStudentCredentialBatch(["student-1"], `batch_${"C".repeat(32)}`);
        expect(unknown).toEqual({
            status: "outcome_unknown",
            error: "outcome_unknown",
            idempotencyKey: `batch_${"C".repeat(32)}`,
        });
        expect(JSON.stringify(unknown)).not.toContain("secret database timeout");
    });

    it("keeps the caller-owned key through the one-student response-loss recovery contract", async () => {
        controls.role = "owner";
        const requestKey = `batch_${"R".repeat(32)}`;
        controls.rpcStatus = "throw";
        await expect(issueStudentStartCredential("student-1", requestKey)).resolves.toEqual({
            success: false,
            status: "outcome_unknown",
            error: "발급 결과를 확인할 수 없습니다. 동일 요청으로 상태를 다시 확인해주세요.",
        });
        expect(controls.rpcCalls.at(-1)?.p_idempotency_key).toBe(requestKey);

        controls.rpcStatus = "already_applied";
        await expect(issueStudentStartCredential("student-1", requestKey)).resolves.toEqual({
            success: false,
            status: "replayed_without_credentials",
            error: "발급은 완료됐지만 보안상 시작 코드를 다시 표시할 수 없습니다. 새 코드를 발급해주세요.",
        });
        expect(controls.rpcCalls.at(-1)?.p_idempotency_key).toBe(requestKey);
    });

    it("fails unavailable without database configuration and never returns locally generated credentials", async () => {
        controls.role = "owner";
        controls.adminAvailable = false;
        const result = await issueStudentCredentialBatch(["student-1"], `batch_${"Z".repeat(32)}`);
        expect(result).toEqual({ status: "unavailable", error: "dependency_unavailable" });
        expect(JSON.stringify(result)).not.toMatch(/startCode|pbkdf2/i);
        expect(controls.rpcCalls).toHaveLength(0);
    });
});
