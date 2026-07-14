import { describe, expect, it } from "vitest";
import {
    STUDENT_GROUP_ID_MAX_LENGTH,
    STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH,
    STUDENT_START_CODE_MAX_LENGTH,
    hashStudentStartCode,
    verifyStudentCredentials,
    verifyStudentStartCode,
    type StudentCredentialClient,
} from "./studentCredentialVerifier";

function mockClient(options: {
    codeHash?: string | null;
    organizationId?: string;
    enrollment?: boolean;
    profileError?: string;
    profileMatchColumn?: "id" | "external_id" | "email";
} = {}) {
    const calls: Array<{ table: string; filters: Array<[string, string]> }> = [];
    const client: StudentCredentialClient = {
        from(table) {
            const filters: Array<[string, string]> = [];
            calls.push({ table, filters });
            const query = {
                eq(column: string, value: string) {
                    filters.push([column, value]);
                    return query;
                },
                async maybeSingle() {
                    if (table === "omr_student_profiles") {
                        if (options.profileError) return { data: null, error: { message: options.profileError } };
                        const profileFilter = filters.find(([column]) => ["id", "external_id", "email"].includes(column));
                        if (options.profileMatchColumn && profileFilter?.[0] !== options.profileMatchColumn) {
                            return { data: null, error: null };
                        }
                        return {
                            data: {
                                id: "student-1",
                                organization_id: options.organizationId || "org-1",
                                display_name: "김학생",
                                status: "active",
                            },
                            error: null,
                        };
                    }
                    if (table === "omr_student_start_credentials") {
                        return { data: { start_code_hash: options.codeHash }, error: null };
                    }
                    return { data: options.enrollment === false ? null : { class_id: "class-a" }, error: null };
                },
            };
            return { select: () => query };
        },
    };
    return { client, calls };
}

describe("student credential verifier", () => {
    const codeHash = hashStudentStartCode("ABC234", 10_000, Buffer.alloc(16, 7));

    it("hashes normalized start codes and rejects a wrong code", () => {
        expect(verifyStudentStartCode("abc 234", codeHash)).toBe(true);
        expect(verifyStudentStartCode("ABC235", codeHash)).toBe(false);
    });

    it("rejects oversized login inputs before database lookup or PBKDF2 work", async () => {
        for (const input of [
            { studentId: "s".repeat(STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH + 1), startCode: "ABC234" },
            { studentId: "student-1", startCode: "A".repeat(STUDENT_START_CODE_MAX_LENGTH + 1) },
            { studentId: "student-1", startCode: "ABC234", groupId: "g".repeat(STUDENT_GROUP_ID_MAX_LENGTH + 1) },
        ]) {
            const { client, calls } = mockClient({ codeHash });
            await expect(verifyStudentCredentials(client, input)).resolves.toEqual({ status: "invalid_credentials" });
            expect(calls).toHaveLength(0);
        }
        expect(verifyStudentStartCode("A".repeat(STUDENT_START_CODE_MAX_LENGTH + 1), codeHash)).toBe(false);
        expect(() => hashStudentStartCode("A".repeat(STUDENT_START_CODE_MAX_LENGTH + 1))).toThrow(
            "Student start code is too long",
        );
    });

    it("rejects hostile stored hash cost parameters", () => {
        const hostileHash = `pbkdf2-sha256:1000001:${"a".repeat(32)}:${"b".repeat(64)}`;
        expect(verifyStudentStartCode("ABC234", hostileHash)).toBe(false);
    });

    it("returns a server-sourced identity only after profile and enrollment verification", async () => {
        const { client, calls } = mockClient({ codeHash });
        await expect(verifyStudentCredentials(client, {
            studentId: "student-1",
            startCode: "abc234",
            groupId: "class-a",
        })).resolves.toEqual({
            status: "verified",
            identity: {
                organizationId: "org-1",
                studentId: "student-1",
                studentName: "김학생",
                identityType: "registered",
                groupId: "class-a",
            },
        });
        expect(calls[2].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["student_profile_id", "student-1"],
            ["class_id", "class-a"],
            ["enrollment_status", "active"],
        ]));
    });

    it("accepts a server profile email as the login identifier", async () => {
        const { client, calls } = mockClient({ codeHash, profileMatchColumn: "email" });
        const result = await verifyStudentCredentials(client, {
            studentId: "student@example.com",
            startCode: "ABC234",
        });
        expect(result).toMatchObject({
            status: "verified",
            identity: { studentId: "student-1", studentName: "김학생" },
        });
        expect(calls.slice(0, 3).map(call => call.filters[0])).toEqual([
            ["id", "student@example.com"],
            ["external_id", "student@example.com"],
            ["email", "student@example.com"],
        ]);
    });

    it("rejects missing credentials, wrong codes, and unverified class claims", async () => {
        await expect(verifyStudentCredentials(mockClient({ codeHash: null }).client, {
            studentId: "student-1",
            startCode: "ABC234",
        })).resolves.toEqual({ status: "credential_not_configured" });
        await expect(verifyStudentCredentials(mockClient({ codeHash }).client, {
            studentId: "student-1",
            startCode: "WRONG1",
        })).resolves.toEqual({ status: "invalid_credentials" });
        await expect(verifyStudentCredentials(mockClient({ codeHash, enrollment: false }).client, {
            studentId: "student-1",
            startCode: "ABC234",
            groupId: "class-a",
        })).resolves.toEqual({ status: "invalid_credentials" });
    });

    it("reports server lookup failures without issuing an identity", async () => {
        await expect(verifyStudentCredentials(mockClient({ profileError: "db down" }).client, {
            studentId: "student-1",
            startCode: "ABC234",
        })).resolves.toEqual({ status: "service_unavailable", error: "db down" });
    });
});
