import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS, normalizeBackendTimeoutMs } from "./initialOperationsPolicy";

describe("initial operations policy", () => {
    it("defines the immutable at-most-100-user launch contract", () => {
        expect(Object.isFrozen(INITIAL_OPERATIONS_LIMITS)).toBe(true);
        expect(INITIAL_OPERATIONS_LIMITS.activeStudents).toBe(100);
        expect(INITIAL_OPERATIONS_LIMITS.teacherAttempts).toBeGreaterThanOrEqual(1_000);
    });

    it("provides finite defensive ceilings for every first-release list", () => {
        expect(INITIAL_OPERATIONS_LIMITS).toMatchObject({
            teacherExams: expect.any(Number),
            studentAttempts: expect.any(Number),
            classes: expect.any(Number),
            students: expect.any(Number),
            enrollments: expect.any(Number),
            invites: expect.any(Number),
            listPageSize: expect.any(Number),
        });

        for (const key of [
            "teacherExams",
            "teacherAttempts",
            "studentAttempts",
            "classes",
            "students",
            "enrollments",
            "invites",
            "listPageSize",
        ] as const) {
            expect(Number.isSafeInteger(INITIAL_OPERATIONS_LIMITS[key]), key).toBe(true);
            expect(INITIAL_OPERATIONS_LIMITS[key], key).toBeGreaterThan(0);
        }
    });

    it("defines the backend timeout default and supported range", () => {
        expect(INITIAL_OPERATIONS_LIMITS.defaultBackendTimeoutMs).toBe(9_000);
        expect(INITIAL_OPERATIONS_LIMITS.minimumBackendTimeoutMs).toBe(3_000);
        expect(INITIAL_OPERATIONS_LIMITS.maximumBackendTimeoutMs).toBe(20_000);
    });

    it("owns the background dashboard revalidation interval", () => {
        expect(INITIAL_OPERATIONS_LIMITS.backgroundRevalidationMs).toBe(30_000);
    });

    it("normalizes configured backend deadlines into the supported range", () => {
        expect(normalizeBackendTimeoutMs("1")).toBe(3_000);
        expect(normalizeBackendTimeoutMs("9000")).toBe(9_000);
        expect(normalizeBackendTimeoutMs("999999")).toBe(20_000);
    });

    it("uses the safe default for missing, malformed, and non-finite values", () => {
        expect(normalizeBackendTimeoutMs()).toBe(9_000);
        expect(normalizeBackendTimeoutMs("")).toBe(9_000);
        expect(normalizeBackendTimeoutMs("not-a-number")).toBe(9_000);
        expect(normalizeBackendTimeoutMs("Infinity")).toBe(9_000);
    });
});
