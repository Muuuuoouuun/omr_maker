import { describe, expect, it } from "vitest";
import {
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
    credentialOrganizationId?: string;
    credentialError?: string;
    profileError?: string;
    profileStatus?: string;
    returnedProfileOrganizationId?: string;
    returnedProfileId?: string;
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
                        const organizationFilter = filters.find(([column]) => column === "organization_id")?.[1];
                        const profileFilter = filters.find(([column]) => column === "id")?.[1];
                        if (organizationFilter !== (options.organizationId || "org-1") || profileFilter !== "student-1") {
                            return { data: null, error: null };
                        }
                        return {
                            data: {
                                id: options.returnedProfileId || "student-1",
                                organization_id: options.returnedProfileOrganizationId || options.organizationId || "org-1",
                                display_name: "김학생",
                                status: options.profileStatus || "active",
                                metadata: {
                                    studentAccessCode: { version: 1, hash: "legacy-hmac-only" },
                                },
                            },
                            error: null,
                        };
                    }
                    if (table === "omr_student_start_credentials") {
                        if (options.credentialError) {
                            return { data: null, error: { message: options.credentialError } };
                        }
                        const organizationFilter = filters.find(([column]) => column === "organization_id")?.[1];
                        if (options.credentialOrganizationId && organizationFilter !== options.credentialOrganizationId) {
                            return { data: null, error: null };
                        }
                        return { data: { start_code_hash: options.codeHash }, error: null };
                    }
                    return { data: null, error: null };
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
            { organizationId: "", studentProfileId: "student-1", code: "ABC234" },
            {
                organizationId: "org-1",
                studentProfileId: "s".repeat(STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH + 1),
                code: "ABC234",
            },
            {
                organizationId: "org-1",
                studentProfileId: "student-1",
                code: "A".repeat(STUDENT_START_CODE_MAX_LENGTH + 1),
            },
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

    it("returns a server-sourced identity only after exact credential and profile verification", async () => {
        const { client, calls } = mockClient({ codeHash });
        await expect(verifyStudentCredentials(client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "abc234",
        })).resolves.toEqual({
            status: "verified",
            identity: {
                organizationId: "org-1",
                studentId: "student-1",
                studentName: "김학생",
                identityType: "registered",
            },
        });
        expect(calls[0].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["student_profile_id", "student-1"],
        ]));
        expect(calls[1].filters).toEqual([
            ["organization_id", "org-1"],
            ["id", "student-1"],
        ]);
    });

    it("requires an explicit organization and rejects the same profile id outside that organization", async () => {
        const { client, calls } = mockClient({
            codeHash,
            organizationId: "org-b",
            credentialOrganizationId: "org-a",
        });

        await expect(verifyStudentCredentials(client, {
            organizationId: "org-b",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "credential_not_configured" });
        expect(calls[0]).toEqual({
            table: "omr_student_start_credentials",
            filters: [
                ["organization_id", "org-b"],
                ["student_profile_id", "student-1"],
            ],
        });
    });

    it("rejects legacy profile metadata when no PBKDF2 credential row exists", async () => {
        const { client, calls } = mockClient({ codeHash: null });
        await expect(verifyStudentCredentials(client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "credential_not_configured" });
        expect(calls.map(call => call.table)).toEqual(["omr_student_start_credentials"]);
    });

    it("fails closed when an exact scoped query returns a different profile scope", async () => {
        for (const options of [
            { returnedProfileOrganizationId: "org-other" },
            { returnedProfileId: "student-other" },
        ]) {
            await expect(verifyStudentCredentials(mockClient({ codeHash, ...options }).client, {
                organizationId: "org-1",
                studentProfileId: "student-1",
                code: "ABC234",
            })).resolves.toEqual({ status: "invalid_credentials" });
        }
    });

    it("rejects missing credentials, wrong codes, and inactive profiles", async () => {
        await expect(verifyStudentCredentials(mockClient({ codeHash: null }).client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "credential_not_configured" });
        await expect(verifyStudentCredentials(mockClient({ codeHash }).client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "WRONG1",
        })).resolves.toEqual({ status: "invalid_credentials" });
        await expect(verifyStudentCredentials(mockClient({ codeHash, profileStatus: "inactive" }).client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "invalid_credentials" });
    });

    it("reports server lookup failures without issuing an identity", async () => {
        await expect(verifyStudentCredentials(mockClient({ codeHash, profileError: "db down" }).client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "service_unavailable", error: "db down" });
        await expect(verifyStudentCredentials(mockClient({ credentialError: "credential db down" }).client, {
            organizationId: "org-1",
            studentProfileId: "student-1",
            code: "ABC234",
        })).resolves.toEqual({ status: "service_unavailable", error: "credential db down" });
    });
});
