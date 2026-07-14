import { describe, expect, it } from "vitest";
import { verifyStudentLogin, type StudentRosterSnapshot } from "./studentRosterVerification";

const BASE: StudentRosterSnapshot = {
    organizationId: "org_a",
    groups: [{ id: "grp1", name: "1반", region: "서울" }],
    students: [{ id: "sp_1", name: "김철수", group: "1반", region: "서울" }],
    startCodes: {},
    requireRosterMatch: true,
};

const fixedCode = () => "ABC234";

describe("verifyStudentLogin (server roster + start-code binding)", () => {
    it("rejects a blank name", () => {
        expect(verifyStudentLogin({ name: "   " }, BASE)).toEqual({ ok: false, reason: "invalid_input" });
    });

    it("rejects a student who is not on the roster when a match is required", () => {
        const result = verifyStudentLogin({ name: "이영희", selectedGroupId: "grp1" }, BASE);
        expect(result).toEqual({ ok: false, reason: "roster_mismatch" });
    });

    it("issues a roster-verified identity with the real profile id and org (first-time start code)", () => {
        const result = verifyStudentLogin({ name: "김철수", selectedGroupId: "grp1" }, BASE, fixedCode);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity).toMatchObject({
            kind: "student",
            studentId: "sp_1",
            organizationId: "org_a",
            studentProfileId: "sp_1",
            groupId: "grp1",
            groupName: "1반",
            regionName: "서울",
            identityType: "temporary",
        });
        expect(result.issuedCode).toBe("ABC234");
    });

    it("requires the start code once one exists and rejects a wrong code", () => {
        const snapshot = { ...BASE, startCodes: { sp_1: "ABC234" } };
        expect(verifyStudentLogin({ name: "김철수", selectedGroupId: "grp1" }, snapshot)).toEqual({
            ok: false, reason: "code_required",
        });
        expect(verifyStudentLogin({ name: "김철수", selectedGroupId: "grp1", startCode: "ZZZ999" }, snapshot)).toEqual({
            ok: false, reason: "code_mismatch",
        });
        const ok = verifyStudentLogin({ name: "김철수", selectedGroupId: "grp1", startCode: "abc234" }, snapshot);
        expect(ok.ok).toBe(true);
    });

    it("refuses to guess between same-name roster profiles without a lookup", () => {
        const snapshot: StudentRosterSnapshot = {
            ...BASE,
            students: [
                { id: "sp_1", name: "김철수", group: "1반" },
                { id: "sp_2", name: "김철수", group: "1반" },
            ],
        };
        expect(verifyStudentLogin({ name: "김철수", selectedGroupId: "grp1" }, snapshot)).toEqual({
            ok: false, reason: "ambiguous_student",
        });
        const disambiguated = verifyStudentLogin(
            { name: "김철수", selectedGroupId: "grp1", studentLookup: "sp_2" }, snapshot, fixedCode,
        );
        expect(disambiguated.ok).toBe(true);
        if (disambiguated.ok) expect(disambiguated.identity.studentId).toBe("sp_2");
    });

    it("allows unprovisioned quick-entry (no profile id) when a roster match is not required", () => {
        const snapshot: StudentRosterSnapshot = { ...BASE, requireRosterMatch: false, students: [] };
        const result = verifyStudentLogin({ name: "새학생", selectedGroupId: "grp1" }, snapshot, fixedCode);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity.organizationId).toBe("org_a");
        expect(result.identity.studentProfileId).toBeUndefined();  // FK stays null
    });
});
