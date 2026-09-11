import { describe, expect, it } from "vitest";
import { parseRemediationDashboard, parseStudentRemediation, sortRemediationCases, validRemediationCommand, type RemediationCase } from "./remediation";

export const caseFixture: RemediationCase = { sourceAttemptId: "source", examId: "exam", examTitle: "수학", studentName: "학생", className: "A반",
    assigneeName: "교사", dueAt: "2026-09-12T14:59:00.000Z", revision: 1, state: "assigned", targetCount: 2, correctedCount: 0,
    submittedCount: 0, evidenceKey: "a".repeat(32), note: "", canManage: true };
const dashboard = { cases: [caseFixture], candidates: [], hasMore: false, canAssign: true, planEnabled: true };

describe("remediation contracts", () => {
    it("validates exact command shapes, bounded batches, dates and concurrency keys", () => {
        expect(validRemediationCommand({ op: "load" })).toBe(true);
        expect(validRemediationCommand({ op: "load", page: 1 })).toBe(true);
        expect(validRemediationCommand({ op: "load", page: -1 })).toBe(false);
        expect(validRemediationCommand({ op: "load", role: "owner" })).toBe(false);
        const assign = { op: "assign", sourceAttemptIds: ["source"], dueAt: caseFixture.dueAt };
        expect(validRemediationCommand(assign)).toBe(true);
        for (const sourceAttemptIds of [[], ["source", "source"], Array.from({ length: 21 }, (_, i) => String(i)), [null], [" x"]]) {
            expect(validRemediationCommand({ ...assign, sourceAttemptIds })).toBe(false);
        }
        expect(validRemediationCommand({ ...assign, dueAt: "not a date" })).toBe(false);
        expect(validRemediationCommand({ ...assign, organizationId: "other" })).toBe(false);
        const confirm = { op: "confirm", sourceAttemptId: "source", expectedRevision: 1, evidenceKey: caseFixture.evidenceKey, note: "풀이 설명 확인" };
        expect(validRemediationCommand(confirm)).toBe(true);
        expect(validRemediationCommand({ ...confirm, note: "완료" })).toBe(false);
        expect(validRemediationCommand({ ...confirm, evidenceKey: "stale" })).toBe(false);
        expect(validRemediationCommand({ ...confirm, expectedRevision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
        expect(validRemediationCommand({ ...confirm, op: "resume", note: "" })).toBe(true);
    });
    it("prioritizes exceptions without mutating the input", () => {
        const items = [caseFixture, { ...caseFixture, state: "confirmed" as const }, { ...caseFixture, state: "recheck" as const }, { ...caseFixture, state: "overdue" as const }];
        expect(sortRemediationCases(items).map(c => c.state)).toEqual(["recheck", "overdue", "assigned", "confirmed"]);
        expect(items[0]).toBe(caseFixture);
    });
    it("rejects inconsistent counts, states and unbounded responses", () => {
        for (const patch of [{ state: "unknown" }, { targetCount: 0 }, { correctedCount: 1 }, { sourceAttemptId: "" }, { dueAt: 123 }, { note: "x".repeat(501) }]) {
            expect(parseRemediationDashboard({ ...dashboard, cases: [{ ...caseFixture, ...patch }] })).toBeNull();
        }
        expect(parseRemediationDashboard({ ...dashboard, cases: Array(51).fill(caseFixture) })).toBeNull();
        expect(parseRemediationDashboard(dashboard)).toEqual(dashboard);
    });
    it("strips private fields from student and teacher DTOs", () => {
        const input = { ...caseFixture, correctAnswer: 4, serviceRoleKey: "secret", note: "교사 내부 메모" };
        const student = parseStudentRemediation([input]);
        expect(student?.[0].sourceAttemptId).toBe("source");
        expect(student?.[0]).not.toHaveProperty("note");
        expect(student?.[0]).not.toHaveProperty("evidenceKey");
        expect(JSON.stringify(student)).not.toContain("secret");
        expect(parseStudentRemediation([null])).toBeNull();
        expect(parseRemediationDashboard({ ...dashboard, cases: [input] })?.cases[0]).not.toHaveProperty("correctAnswer");
    });
});
