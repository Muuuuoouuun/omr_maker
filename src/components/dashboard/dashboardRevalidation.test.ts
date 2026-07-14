import { describe, expect, it } from "vitest";
import {
    DASHBOARD_REVALIDATE_MIN_INTERVAL_MS,
    createDashboardRevalidationGate,
    isStudentDashboardStorageKey,
    isTeacherDashboardStorageKey,
} from "./dashboardRevalidation";

describe("dashboard storage key matchers", () => {
    it("teacher dashboard reacts to exam, attempt, and roster keys", () => {
        expect(isTeacherDashboardStorageKey("omr_attempts")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_exam_abc-123")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_deleted_exam_ids")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_students")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_groups")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_invites")).toBe(true);
        expect(isTeacherDashboardStorageKey("omr_roster_tombstones")).toBe(true);
        // localStorage.clear() reports a null key — always relevant.
        expect(isTeacherDashboardStorageKey(null)).toBe(true);
    });

    it("teacher dashboard ignores unrelated keys", () => {
        expect(isTeacherDashboardStorageKey("omr_student_session_backup")).toBe(false);
        expect(isTeacherDashboardStorageKey("omr_draft_exam1_s1")).toBe(false);
        expect(isTeacherDashboardStorageKey("theme")).toBe(false);
        expect(isTeacherDashboardStorageKey("")).toBe(false);
    });

    it("student dashboard reacts to exam, attempt, draft, session-backup, and merge keys", () => {
        expect(isStudentDashboardStorageKey("omr_attempts")).toBe(true);
        expect(isStudentDashboardStorageKey("omr_exam_abc-123")).toBe(true);
        expect(isStudentDashboardStorageKey("omr_draft_exam1_s1")).toBe(true);
        expect(isStudentDashboardStorageKey("omr_student_session_backup")).toBe(true);
        expect(isStudentDashboardStorageKey("omr_pending_guest_merge")).toBe(true);
        expect(isStudentDashboardStorageKey(null)).toBe(true);
    });

    it("student dashboard ignores roster and unrelated keys", () => {
        expect(isStudentDashboardStorageKey("omr_students")).toBe(false);
        expect(isStudentDashboardStorageKey("omr_invites")).toBe(false);
        expect(isStudentDashboardStorageKey("theme")).toBe(false);
    });
});

describe("createDashboardRevalidationGate", () => {
    function gateAt(startMs: number) {
        let current = startMs;
        const gate = createDashboardRevalidationGate({ now: () => current });
        return { gate, advance: (ms: number) => { current += ms; } };
    }

    it("starts hot: a trigger right after mount is deferred, not refreshed", () => {
        const { gate } = gateAt(1_000);
        const decision = gate.decide();
        expect(decision).toEqual({ kind: "schedule", delayMs: DASHBOARD_REVALIDATE_MIN_INTERVAL_MS });
    });

    it("refreshes immediately once the window has elapsed", () => {
        const { gate, advance } = gateAt(1_000);
        advance(DASHBOARD_REVALIDATE_MIN_INTERVAL_MS);
        expect(gate.decide()).toEqual({ kind: "refresh" });
    });

    it("coalesces a burst into one trailing refresh, then reopens the window", () => {
        const { gate, advance } = gateAt(0);
        advance(4_000);
        // First trigger inside the closed window → trailing slot for the remainder.
        expect(gate.decide()).toEqual({ kind: "schedule", delayMs: DASHBOARD_REVALIDATE_MIN_INTERVAL_MS - 4_000 });
        // Burst while the slot is pending → coalesced.
        expect(gate.decide()).toEqual({ kind: "ignore" });
        advance(1_000);
        expect(gate.decide()).toEqual({ kind: "ignore" });

        // The trailing refresh fires at the window boundary.
        advance(DASHBOARD_REVALIDATE_MIN_INTERVAL_MS - 5_000);
        gate.confirmScheduledRefresh();

        // Immediately after, the window is closed again.
        expect(gate.decide()).toEqual({ kind: "schedule", delayMs: DASHBOARD_REVALIDATE_MIN_INTERVAL_MS });
    });

    it("cancelScheduled releases a pending slot without recording a refresh", () => {
        const { gate, advance } = gateAt(0);
        advance(2_000);
        expect(gate.decide().kind).toBe("schedule");
        gate.cancelScheduled();
        // Slot released: the next trigger inside the window schedules again
        // (it is not swallowed as "ignore").
        advance(1_000);
        expect(gate.decide()).toEqual({ kind: "schedule", delayMs: DASHBOARD_REVALIDATE_MIN_INTERVAL_MS - 3_000 });
        // And once the original window elapses, refreshes flow immediately again.
        gate.cancelScheduled();
        advance(DASHBOARD_REVALIDATE_MIN_INTERVAL_MS);
        expect(gate.decide()).toEqual({ kind: "refresh" });
    });

    it("respects a custom minimum interval", () => {
        let current = 0;
        const gate = createDashboardRevalidationGate({ minIntervalMs: 500, now: () => current });
        current += 499;
        expect(gate.decide().kind).toBe("schedule");
        gate.cancelScheduled();
        current += 1;
        expect(gate.decide()).toEqual({ kind: "refresh" });
    });
});
