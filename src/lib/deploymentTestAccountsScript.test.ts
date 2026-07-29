import { describe, expect, it } from "vitest";
import {
    buildDeploymentFixture,
    redactFixtureSummary,
    vercelReadableEnvArgs,
    verifyStudentStartCodeHash,
    verifyTeacherPasswordHash,
} from "../../scripts/deployment-test-accounts-core.mjs";

describe("deployment test account fixture", () => {
    it("keeps provisioned Vercel values readable for authenticated verification", () => {
        expect(vercelReadableEnvArgs("TEACHER_ACCOUNTS", "production")).toEqual([
            "env",
            "add",
            "TEACHER_ACCOUNTS",
            "production",
            "--force",
            "--no-sensitive",
        ]);
    });

    it("builds shared accounts without plaintext teacher passwords", () => {
        const fixture = buildDeploymentFixture({
            studentSessionSecret: "student-secret",
            now: "2026-07-22T00:00:00.000Z",
        });

        expect(fixture.organization.id).toBe("teacher_sharedqa");
        expect(fixture.teacherAccounts.map(account => account.plan)).toEqual(["academy", "free", "pro", "academy"]);
        expect(fixture.teacherAccounts.map(account => account.memberRole)).toEqual(["admin", "teacher", "teacher", "teacher"]);
        expect(JSON.stringify(fixture.teacherAccounts)).not.toContain("admin1234");
        expect(JSON.stringify(fixture.teacherAccounts)).not.toContain("teacher1234");
        expect(verifyTeacherPasswordHash("admin1234", fixture.teacherAccounts[0].passwordHash)).toBe(true);
        expect(fixture.students).toHaveLength(3);
        expect(fixture.enrollments).toHaveLength(3);
        expect(fixture.studentCredentials).toHaveLength(3);
        expect(verifyStudentStartCodeHash("ABC234", fixture.studentCredentials[0].start_code_hash)).toBe(true);
    });

    it("keeps student authentication truth only in the PBKDF2 credential rows", () => {
        const first = buildDeploymentFixture({ studentSessionSecret: "secret-a", now: "2026-07-22T00:00:00.000Z" });
        const second = buildDeploymentFixture({ studentSessionSecret: "secret-b", now: "2026-07-22T00:00:00.000Z" });

        expect(first.students[0].metadata).toEqual({
            source: "deployment_test_fixture",
            group: "테스트반",
            region: "서울",
        });
        expect(second.students[0].metadata).toEqual(first.students[0].metadata);
        expect(first.studentCredentials[0].start_code_hash)
            .not.toBe(second.studentCredentials[0].start_code_hash);
    });

    it("redacts secrets and hashes from dry-run output", () => {
        const fixture = buildDeploymentFixture({ studentSessionSecret: "student-secret" });
        const summary = JSON.stringify(redactFixtureSummary(fixture));

        expect(summary).toContain("teacher_sharedqa");
        expect(summary).toContain("teacher1");
        expect(summary).not.toContain("admin1234");
        expect(summary).not.toContain("teacher1234");
        expect(summary).not.toContain("pbkdf2-sha256");
        expect(summary).not.toContain("student-secret");
    });
});
