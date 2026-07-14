import { describe, expect, it } from "vitest";
import {
    hashStudentAccessCode,
    isValidStudentAccessCode,
    metadataWithStudentAccessCode,
    normalizeStudentAccessCode,
    readStudentAccessCodeRecord,
    verifyStudentAccessCode,
} from "./studentAccessCode";

const params = {
    studentId: "student-1",
    organizationId: "teacher_workspace",
    secret: "server-only-pepper",
};

describe("student access code", () => {
    it("normalizes the six-character non-ambiguous alphabet", () => {
        expect(normalizeStudentAccessCode(" abcd 23 ")).toBe("ABCD23");
        expect(isValidStudentAccessCode("ABCD23")).toBe(true);
        expect(isValidStudentAccessCode("ABCI23")).toBe(false);
        expect(isValidStudentAccessCode("short")).toBe(false);
    });

    it("binds hashes to the organization and student", () => {
        const hash = hashStudentAccessCode({ ...params, code: "ABCD23" });
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hashStudentAccessCode({ ...params, code: "ABCD23", studentId: "student-2" })).not.toBe(hash);
        expect(hashStudentAccessCode({ ...params, code: "ABCD23", organizationId: "other" })).not.toBe(hash);
    });

    it("stores only a versioned hash and verifies without persisting the code", () => {
        const metadata = metadataWithStudentAccessCode({ source: "roster" }, {
            ...params,
            code: "ABCD23",
            updatedAt: "2026-07-14T00:00:00.000Z",
        });

        expect(metadata).not.toBeNull();
        expect(JSON.stringify(metadata)).not.toContain("ABCD23");
        expect(readStudentAccessCodeRecord(metadata)).toMatchObject({
            version: 1,
            updatedAt: "2026-07-14T00:00:00.000Z",
        });
        expect(verifyStudentAccessCode(metadata, { ...params, code: "ABCD23" })).toBe(true);
        expect(verifyStudentAccessCode(metadata, { ...params, code: "ZZZZ99" })).toBe(false);
    });
});
