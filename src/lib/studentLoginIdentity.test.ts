import { describe, expect, it } from "vitest";
import { resolveServerStudentLogin, studentRegionFromProfile } from "./studentLoginIdentity";

const profiles = [
    { id: "s1", organization_id: "w1", display_name: "김학생", external_id: "101", email: "student@example.com", status: "active", metadata: { region: "서울" } },
    { id: "s2", organization_id: "w1", display_name: "김학생", external_id: "102", email: "other@example.com", status: "active", metadata: {} },
    { id: "s3", organization_id: "w1", display_name: "휴면학생", external_id: "103", status: "inactive", metadata: {} },
];
const enrollments = [
    { class_id: "g1", organization_id: "w1", student_profile_id: "s1", enrollment_status: "active" },
    { class_id: "g2", organization_id: "w1", student_profile_id: "s2", enrollment_status: "active" },
    { class_id: "g1", organization_id: "w1", student_profile_id: "s3", enrollment_status: "active" },
];

describe("server student login identity", () => {
    it("requires exact workspace, class, name, and id/email lookup", () => {
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w1", groupId: "g1", name: "김학생", studentLookup: "101" }))
            .toMatchObject({ id: "s1", email: "student@example.com" });
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w1", groupId: "g1", name: "김학생", studentLookup: "STUDENT@EXAMPLE.COM" }))
            .toMatchObject({ id: "s1" });
    });

    it("rejects cross-class, cross-workspace, wrong-name, and inactive matches", () => {
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w1", groupId: "g2", name: "김학생", studentLookup: "101" })).toBeNull();
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w2", groupId: "g1", name: "김학생", studentLookup: "101" })).toBeNull();
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w1", groupId: "g1", name: "다른이름", studentLookup: "101" })).toBeNull();
        expect(resolveServerStudentLogin({ profiles, enrollments, organizationId: "w1", groupId: "g1", name: "휴면학생", studentLookup: "103" })).toBeNull();
    });

    it("prefers the profile region and falls back to class campus", () => {
        expect(studentRegionFromProfile({ region: "서울" }, "부산")).toBe("서울");
        expect(studentRegionFromProfile({}, "부산")).toBe("부산");
        expect(studentRegionFromProfile({}, "")).toBeUndefined();
    });
});
