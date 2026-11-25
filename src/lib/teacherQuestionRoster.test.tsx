// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExamDetailPage from "@/app/teacher/exam/[id]/page";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import { buildQuestionResults } from "@/lib/questionResultBuilder";
import type { Attempt, Exam } from "@/types/omr";

const api = vi.hoisted(() => ({
    params: { id: "" }, exam: vi.fn(), attempts: vi.fn(), aggregate: vi.fn(), summaries: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: () => api.params }));
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/lib/teacherSession", () => ({ readTeacherSession: () => null }));
vi.mock("@/lib/teacherExamClient", () => ({ loadTeacherExamDetail: api.exam }));
vi.mock("@/lib/teacherAttemptClient", () => ({ loadTeacherAttempts: api.attempts, loadTeacherAttemptSummaries: api.summaries }));
vi.mock("@/lib/teacherAttemptReportingClient", () => ({
    loadTeacherAttemptAggregate: api.aggregate, loadTeacherAttemptExportDataset: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const timestamp = "2025-01-02T12:00:00.000Z";
function exam(id: string): Exam {
    return { id, title: `합성 시험 ${id}`, organizationId: "synthetic", createdAt: timestamp,
        questions: [3, 2, 4, 1].map((answer, index) => ({
            id: 21 - index, number: [1, 2, 10, 11][index], answer, score: 1, choices: 4,
        })) };
}
function submit(e: Exam, name: string, choices: (number | null)[]): Attempt {
    const answers: Record<number, number> = {};
    for (const [index, choice] of choices.entries()) {
        if (choice !== null) answers[e.questions[index].id] = choice;
    }
    const attempt: Attempt = {
        id: e.id + "-" + name, examTitle: e.title, examId: e.id, organizationId: e.organizationId,
        startedAt: timestamp, finishedAt: timestamp, status: "completed", studentName: name, answers,
        score: choices.filter((choice, index) => choice === e.questions[index].answer).length, totalScore: 4,
    };
    const questionResults = buildQuestionResults(e, attempt);
    return { ...attempt, questionResults, ...buildCanonicalQuestionResultEvidence(attempt, questionResults) };
}
function mount(e: Exam, attempts: Attempt[], count: number, partial = false) {
    api.params.id = e.id;
    api.exam.mockResolvedValue({ status: "loaded", exam: e, source: "server" });
    api.attempts.mockResolvedValue({ items: attempts, remoteLoaded: true, remotePartial: partial });
    api.aggregate.mockResolvedValue({ status: "loaded", aggregate: {
        completedBaseAttemptCount: count, completedAttemptCount: count, averageScorePercent: 75,
    } });
    return render(<ExamDetailPage />);
}
async function rosterPanel() {
    return within(await screen.findByRole("region", { name: "문항별 학생 찾기" }));
}
describe("teacher exam detail original submission roster", () => {
    it("keeps unanswered separate, preserves numeric item order, excludes retakes and unfinished submissions", async () => {
        const e = exam("one");
        const a = submit(e, "합성 A", [3, 1, null, 1]);
        const b = submit(e, "합성 B", [3, 1, 4, 1]);
        const c = submit(e, "합성 C", [3, 2, 4, 1]);
        const retake = { ...a, id: "retry", retake: {
            sourceAttemptId: a.id, questionIds: [20], mode: "wrong" as const, createdAt: timestamp,
        } };
        mount(e, [c, b, a, retake, { ...a, id: "draft", status: "in_progress" }], 3);
        const panel = await rosterPanel();
        const questions = panel.getByRole("combobox", { name: /^문항$/ });
        expect(within(questions).getAllByRole("option").map(o => o.textContent)).toEqual(["1번", "2번", "10번", "11번"]);
        fireEvent.change(questions, { target: { value: 20 } });
        expect(panel.getByRole("status")).toHaveTextContent("2번 · 본시험 제출 3건 중 2건");
        expect(panel.getAllByRole("listitem").map(i => i.textContent)).toEqual(["합성 A · 1번 선택", "합성 B · 1번 선택"]);
        fireEvent.change(panel.getByLabelText("응답 조건"), { target: { value: "1" } });
        expect(panel.getAllByRole("listitem")).toHaveLength(2);
        fireEvent.change(questions, { target: { value: 19 } });
        expect(panel.getByRole("status")).toHaveTextContent("10번 · 본시험 제출 3건 중 0건");
        fireEvent.change(panel.getByLabelText("응답 조건"), { target: { value: "unanswered" } });
        expect(panel.getByRole("listitem")).toHaveTextContent("합성 A · 미응답");
    });
    it("uses only the second exam and stops when a different exam or workspace is returned", async () => {
        const e = exam("two");
        const participant = submit(e, "다른 합성 학생", [4, 2, 4, 1]);
        mount(e, [participant], 1);
        const panel = await rosterPanel();
        expect(panel.getByRole("listitem")).toHaveTextContent("다른 합성 학생 · 4번 선택");
        expect(api.attempts).toHaveBeenCalledWith("two");
        for (const records of [[{ ...participant, examId: "one" }], [{ ...participant, organizationId: "other" }], [participant, participant]]) {
            cleanup();
            mount(e, records, 1);
            expect(await screen.findByTestId("exam-detail-unavailable")).toBeInTheDocument();
            expect(screen.queryByText("다른 합성 학생")).not.toBeInTheDocument();
        }
    });
    it("preserves a legacy stored score and suppresses the entire roster when even one original lacks evidence", async () => {
        const e = exam("legacy");
        const a = submit(e, "기록 있음", [3, 2, 4, 1]);
        const historical = { ...submit(e, "옛 총점", [3, 2, 4, 1]), score: 1, questionResults: undefined };
        mount(e, [a, historical], 2);
        const panel = await rosterPanel();
        expect(panel.getByRole("status")).toHaveTextContent("문항별 명단을 확인할 수 없습니다");
        expect(panel.queryByRole("combobox")).not.toBeInTheDocument();
        const row = screen.getByRole("row", { name: /옛 총점/ });
        expect(row).toHaveTextContent("25%");
        expect(row).toHaveTextContent("1/4");
        expect(row).toHaveTextContent("문항 기록 없음");
    });
    it("recovers totals through a scoped server summary when the rich gateway rejects one record", async () => {
        const e = exam("summary");
        const legacy = { ...submit(e, "옛 제출", [3, 2, 4, 1]), questionResults: undefined, score: 3 };
        for (const remoteLoaded of [true, false]) {
            api.attempts.mockResolvedValueOnce({ items: [], remoteError: "rich rows unavailable" });
            api.summaries.mockResolvedValueOnce({ items: [legacy], remoteLoaded });
            mount(e, [], 1);
            if (remoteLoaded) {
                expect((await rosterPanel()).getByRole("status")).toHaveTextContent("문항별 명단을 확인할 수 없습니다");
                expect(screen.getByRole("row", { name: /옛 제출/ })).toHaveTextContent("3/4");
            } else {
                expect(await screen.findByTestId("exam-detail-unavailable")).toBeInTheDocument();
                expect(screen.queryByText("옛 제출")).not.toBeInTheDocument();
            }
            expect(api.summaries).toHaveBeenCalledWith(e.id);
            cleanup();
        }
    });
    it("withholds partial, changed-definition or damaged sets and distinguishes a verified empty exam", async () => {
        const e = exam("mixed");
        const a = submit(e, "가", [3, 2, 4, 1]);
        const changed = { ...e, questions: e.questions.map(q => ({ ...q, answer: 1 })) };
        const sets: [Attempt[], number, boolean][] = [
            [[a], 2, false], [[a], 1, true],
            [[a, submit(changed, "나", [1, 1, 1, 1])], 2, false],
            [[submit({ ...e, organizationId: undefined }, "범위 누락", [3, 2, 4, 1])], 1, false],
            [[{ ...a, questionResultsFullEvidenceHash: "invalid" }], 1, false],
        ];
        for (const [records, count, partial] of sets) {
            mount(e, records, count, partial);
            expect((await rosterPanel()).getByRole("status")).toHaveTextContent("문항별 명단을 확인할 수 없습니다");
            cleanup();
        }
        mount(e, [], 0);
        expect((await rosterPanel()).getByText("아직 제출을 마친 본시험 답안이 없습니다.")).toBeInTheDocument();
    });
});
