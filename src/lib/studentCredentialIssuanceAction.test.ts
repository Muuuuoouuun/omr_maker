import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    role: undefined as "owner" | "admin" | "teacher" | "assistant" | "viewer" | undefined,
    adminClientCalls: 0,
    upsertCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({ get: () => ({ value: "signed-teacher" }) }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
}));

vi.mock("@/lib/teacherServerSession", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/teacherServerSession")>();
    return {
        ...actual,
        parseSignedTeacherSessionCookie: () => ({
            teacherId: "teacher-1",
            organizationId: "teacher_sharedqa",
            organizationName: "테스트 학원",
            memberRole: controls.role,
        }),
    };
});

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => ({ url: "https://example.supabase.co", serviceRoleKey: "service-role" }),
    createSupabaseAdminClient: () => {
        controls.adminClientCalls += 1;
        return {
            from: () => ({
                upsert: (row: Record<string, unknown>) => {
                    controls.upsertCalls.push(row);
                    return {
                        select: () => ({
                            maybeSingle: async () => ({
                                data: { student_profile_id: row.student_profile_id },
                                error: null,
                            }),
                        }),
                    };
                },
            }),
        };
    },
}));

import { issueStudentStartCredential } from "@/app/actions/studentAuth";

describe("student credential issuance action roles", () => {
    beforeEach(() => {
        controls.role = undefined;
        controls.adminClientCalls = 0;
        controls.upsertCalls = [];
    });

    it("rejects viewer and missing roles before resolving a service-role client", async () => {
        for (const role of ["viewer", undefined] as const) {
            controls.role = role;
            await expect(issueStudentStartCredential("student-1", "ABC234")).resolves.toMatchObject({
                success: false,
            });
        }
        expect(controls.adminClientCalls).toBe(0);
        expect(controls.upsertCalls).toHaveLength(0);
    });

    it("allows each explicit write-capable role", async () => {
        for (const role of ["owner", "admin", "teacher", "assistant"] as const) {
            controls.role = role;
            await expect(issueStudentStartCredential(`student-${role}`, "ABC234")).resolves.toEqual({
                success: true,
            });
        }
        expect(controls.adminClientCalls).toBe(4);
        expect(controls.upsertCalls).toHaveLength(4);
    });
});
