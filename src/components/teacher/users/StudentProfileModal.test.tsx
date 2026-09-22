// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RosterStudent } from "@/lib/rosterStorage";
import type { StudentProfileInsight } from "@/lib/studentProfileAnalytics";
import { StudentProfileModal } from "./parts";

afterEach(cleanup);
const student: RosterStudent = {
    id: "student-1", name: "김학생", email: "student@example.com", group: "A반", avatar: "#111827",
    avgScore: 50, examsTaken: 2, lastActive: "오늘", trend: "flat", status: "idle",
};
const profile: StudentProfileInsight = {
    attempts: [], averageScore: 50, bestScore: 50, latestScore: 50, trendDelta: 0,
    averageElapsedTimeSec: 60, averageQuestionTimeSec: 20, totalTrackedTimeSec: 120,
    focusLossCount: 0, wrongQuestionCount: 2, unansweredQuestionCount: 0, handwritingArchiveCount: 0,
    baseAttemptCount: 2, retakeAttemptCount: 0, weaknessGroups: [], headlineWeaknessGroups: [], mostMissedQuestions: [], tagStats: [],
    conceptMastery: { unmappedQuestionCount: 0, groups: [{
        concept: "문맥 추론", correctCount: 1, totalCount: 4, unansweredCount: 0, distinctQuestionCount: 4,
        attemptCount: 2, correctRate: 25, assessment: "weakness", trendDelta: null,
        evidence: [{ examId: "exam-1", examTitle: "진단 시험", questionNumber: 2, attemptId: "attempt-1", status: "wrong", finishedAt: "2026-09-01", trapPoints: [] }],
    }] },
};

describe("StudentProfileModal concept analytics", () => {
    it("renders server-authorized concept insight and evidence in the roster profile", () => {
        render(<StudentProfileModal student={student} profile={profile} onClose={() => {}} retakeAssignmentsEnabled={false} />);
        const dialog = screen.getByRole("dialog", { name: "김학생 학생 성장 리포트" });
        expect(within(dialog).getByRole("heading", { name: "개념별 강점과 보완점" })).toBeInTheDocument();
        expect(within(dialog).getByRole("heading", { name: "문맥 추론" })).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole("button", { name: /문맥 추론 문항 근거 보기/ }));
        expect(within(dialog).getByRole("link", { name: "진단 시험 · 2번 · 오답" })).toHaveAttribute("href", "/teacher/attempt/attempt-1?view=answers&question=2");
    });

    it("keeps legacy profiles without concept analytics usable", () => {
        render(<StudentProfileModal student={student} profile={{ ...profile, conceptMastery: undefined }} onClose={() => {}} retakeAssignmentsEnabled={false} />);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "개념별 강점과 보완점" })).not.toBeInTheDocument();
    });
});
