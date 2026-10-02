// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExamAnalyticsReportOverview, {
    type ExamAnalyticsReportOverviewProps,
} from "./ExamAnalyticsReportOverview";
import ExamAnalyticsTab, {
    buildStudentQuestionAnalysisCsvRows,
    QuestionCorrectRateTooltip,
} from "./ExamAnalyticsTab";
import OverviewTab from "./OverviewTab";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { TeacherDashboardDegradedData } from "@/lib/teacherDashboardCanonicalCache";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import { buildTeacherCanonicalAnalyticsSnapshot } from "@/lib/teacherCanonicalAnalyticsSnapshot.server";

const overviewTestMocks = vi.hoisted(() => ({
    loadExportDataset: vi.fn(),
    archiveExam: vi.fn(),
    deleteExam: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/teacherAttemptReportingClient", () => ({
    loadTeacherAttemptExportDataset: overviewTestMocks.loadExportDataset,
}));

vi.mock("@/lib/teacherExamClient", () => ({
    setTeacherExamArchivedFromSummary: overviewTestMocks.archiveExam,
    deleteTeacherExamMutation: overviewTestMocks.deleteExam,
}));

vi.mock("@/components/Toast", () => ({
    toast: {
        success: overviewTestMocks.toastSuccess,
        error: overviewTestMocks.toastError,
        info: overviewTestMocks.toastInfo,
    },
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-motion");
});

function sealFixtureAttempt(candidate: Attempt): Attempt {
    const questionResults = (candidate.questionResults ?? []).map(result => ({
        ...result,
        attemptId: candidate.id,
        examId: candidate.examId,
        examTitle: candidate.examTitle,
        organizationId: candidate.organizationId,
        classId: candidate.classId,
        assignmentId: candidate.assignmentId,
        assignmentRevision: candidate.assignmentRevision,
        studentProfileId: candidate.studentProfileId,
        studentName: candidate.studentName,
        studentId: candidate.studentId,
        groupId: candidate.groupId,
        groupName: candidate.groupName,
        regionId: candidate.regionId,
        regionName: candidate.regionName,
        identityType: candidate.identityType,
        finishedAt: candidate.finishedAt,
    }));
    const canonical = { ...candidate, questionResults };
    return { ...canonical, ...buildCanonicalQuestionResultEvidence(canonical, questionResults) };
}

function buildUngradedExamAnalyticsFixture(): { exam: Exam; attempts: Attempt[] } {
    const exam: Exam = {
        id: "exam-ungraded",
        title: "미채점 진단",
        createdAt: "2026-08-08T09:00:00.000Z",
        questions: [{
            id: 1,
            number: 1,
            label: "문법",
            score: 10,
            choices: 4,
            tags: { concept: "시제" },
        }],
    };
    const attempts = Array.from({ length: 5 }, (_, index) => {
        const id = `attempt-ungraded-${index + 1}`;
        const finishedAt = `2026-08-08T09:${String(index + 10).padStart(2, "0")}:00.000Z`;
        const result: QuestionResult = {
            schemaVersion: 1,
            attemptId: id,
            examId: exam.id,
            examTitle: exam.title,
            studentName: `학생 ${index + 1}`,
            questionId: 1,
            questionNumber: 1,
            label: "문법",
            concept: "시제",
            score: 0,
            earnedScore: 0,
            status: "ungraded",
            isCorrect: false,
            isWrong: false,
            isUnanswered: false,
            finishedAt,
        };

        return sealFixtureAttempt({
            id,
            examId: exam.id,
            examTitle: exam.title,
            studentName: result.studentName,
            startedAt: "2026-08-08T09:00:00.000Z",
            finishedAt,
            score: 0,
            totalScore: 0,
            answers: {},
            questionResults: [result],
            status: "completed" as const,
        });
    });

    return { exam, attempts };
}

function buildReadyCanonicalAnalyticsFixture(): { exam: Exam; attempt: Attempt } {
    const { exam, attempts } = buildUngradedExamAnalyticsFixture();
    const source = attempts[0];
    const attempt = sealFixtureAttempt({
        ...source,
        organizationId: "org-analytics",
        classId: "class-analytics",
        studentProfileId: "profile-analytics",
        studentId: "student-analytics",
        identityType: "registered",
        score: 10,
        totalScore: 10,
        questionResults: (source.questionResults || []).map(result => ({
            ...result,
            score: 10,
            earnedScore: 10,
            selectedAnswer: 2,
            correctAnswer: 2,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
        })),
    });
    return { exam, attempt };
}

function buildProps(
    overrides: Partial<ExamAnalyticsReportOverviewProps> = {},
): ExamAnalyticsReportOverviewProps {
    return {
        metrics: [
            { id: "mean", label: "평균", value: 74, unit: "점" },
            { id: "median", label: "중앙값", value: 76, unit: "점" },
            { id: "maximum", label: "최고", value: 98, unit: "점" },
            { id: "minimum", label: "최저", value: 32, unit: "점", tone: "grade" },
            { id: "submissions", label: "응시", value: 18, unit: "명" },
            { id: "elapsed", label: "평균 시간", value: "18분 20초" },
        ],
        headline: {
            tone: "action",
            title: "‘이차함수’ 보강이 가장 효과적입니다",
            detail: "정답률 48% · 지원 학생 4명 · 점검 문항 3개",
        },
        distribution: [
            { label: "0-10", min: 0, max: 10, count: 1 },
            { label: "10-20", min: 10, max: 20, count: 2 },
            { label: "20-30", min: 20, max: 30, count: 4 },
            { label: "30-40", min: 30, max: 40, count: 2 },
        ],
        weakQuestions: [
            {
                key: "q-7",
                questionNumber: 7,
                title: "이차함수",
                correctRate: 32,
                evidence: "가장 많이 선택한 오답 3번 · 44%",
            },
            {
                key: "q-12",
                questionNumber: 12,
                title: "확률",
                correctRate: 57,
                evidence: "미응답 2명",
            },
        ],
        achievementBands: [
            { key: "under-40", label: "40점 미만", count: 2, percent: 11, tone: "grade" },
            { key: "under-60", label: "40~59점", count: 4, percent: 22, tone: "warning" },
            { key: "under-80", label: "60~79점", count: 6, percent: 33, tone: "neutral" },
            { key: "over-80", label: "80~100점", count: 6, percent: 33, tone: "success" },
        ],
        actions: [
            {
                key: "questions",
                title: "취약 문항 보기",
                detail: "문항 근거를 자세히 확인합니다.",
                href: "/teacher/retake?question=7",
            },
        ],
        hasPerformanceEvidence: true,
        ...overrides,
    };
}

function buildDegradedOverviewSnapshot(
    status: "active" | "archived" = "archived",
): TeacherDashboardDegradedData {
    return {
        kind: "teacher_dashboard_degraded",
        staleAt: "2026-08-09T00:02:00.000Z",
        exams: [{
            kind: "degraded_exam_summary",
            id: "cached-exam",
            title: "저장된 운영 시험",
            status,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:01:00.000Z",
            questionCount: 0,
            attemptCount: 0,
        }],
        attempts: [],
    };
}

describe("OverviewTab teacher data capability", () => {
    it("renders degraded identity rows without constructing mutation, export, or detail callbacks", () => {
        render(
            <OverviewTab
                capability="degraded_read_only"
                snapshot={buildDegradedOverviewSnapshot()}
            />,
        );

        const identityRegion = screen.getByRole("region", { name: "저장된 시험 식별 정보" });
        expect(within(identityRegion).getByText("저장된 운영 시험", { exact: true })).toBeVisible();
        expect(within(identityRegion).getByText("보관됨", { exact: true })).toBeVisible();
        expect(screen.queryByRole("button", { name: /분석 보기/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /통계 CSV|CSV 다시 시도/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /시험 작업 메뉴/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /알람/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /시험 제작|시험 분석/ })).not.toBeInTheDocument();
    });

    it("cancels an in-flight fresh export before detail load, download, or success publication after degradation", async () => {
        const exam: Exam = {
            id: "exam-live-export",
            title: "전환 중 시험",
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            questions: [],
        };
        const attempt: Attempt = {
            id: "attempt-live-export",
            examId: exam.id,
            examTitle: exam.title,
            studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T00:01:00.000Z",
            score: 1,
            totalScore: 1,
            answers: {},
            status: "completed",
        };
        let resolveDataset!: (value: { status: "local_only" }) => void;
        overviewTestMocks.loadExportDataset.mockReturnValueOnce(new Promise(resolve => {
            resolveDataset = resolve;
        }));
        const onLoadDetailedAttempts = vi.fn().mockResolvedValue([attempt]);
        const createObjectURL = vi.fn(() => "blob:cancelled-export");
        const originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = createObjectURL;

        try {
            const view = render(
                <OverviewTab
                    capability="fresh_mutable"
                    exams={[exam]}
                    attempts={[attempt]}
                    stats={{ totalStudents: 1, avgScore: 100, activeExams: 1 }}
                    trendData={[]}
                    onLoadDetailedAttempts={onLoadDetailedAttempts}
                />,
            );
            fireEvent.click(screen.getByRole("button", { name: "통계 CSV" }));
            expect(overviewTestMocks.loadExportDataset).toHaveBeenCalledOnce();

            view.rerender(
                <OverviewTab
                    capability="degraded_read_only"
                    snapshot={buildDegradedOverviewSnapshot("active")}
                />,
            );
            await act(async () => { resolveDataset({ status: "local_only" }); });
            await waitFor(() => expect(onLoadDetailedAttempts).not.toHaveBeenCalled());
            expect(createObjectURL).not.toHaveBeenCalled();
            expect(overviewTestMocks.toastSuccess).not.toHaveBeenCalled();
            expect(overviewTestMocks.toastError).not.toHaveBeenCalled();
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
        }
    });

    it("completes a permitted fresh export and leaves generating state under StrictMode", async () => {
        const exam: Exam = {
            id: "exam-strict-export",
            title: "StrictMode 내보내기",
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            questions: [],
        };
        const attempt: Attempt = {
            id: "attempt-strict-export",
            examId: exam.id,
            examTitle: exam.title,
            studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T00:01:00.000Z",
            score: 1,
            totalScore: 1,
            answers: {},
            status: "completed",
        };
        overviewTestMocks.loadExportDataset.mockResolvedValueOnce({ status: "local_only" });
        const onLoadDetailedAttempts = vi.fn().mockResolvedValue([attempt]);
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        const createObjectURL = vi.fn(() => "blob:strict-export");
        const revokeObjectURL = vi.fn();
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;

        try {
            render(
                <StrictMode>
                    <OverviewTab
                        capability="fresh_mutable"
                        exams={[exam]}
                        attempts={[attempt]}
                        stats={{ totalStudents: 1, avgScore: 100, activeExams: 1 }}
                        trendData={[]}
                        onLoadDetailedAttempts={onLoadDetailedAttempts}
                    />
                </StrictMode>,
            );

            const exportButton = screen.getByRole("button", { name: "통계 CSV" });
            fireEvent.click(exportButton);

            await waitFor(() => expect(overviewTestMocks.toastSuccess).toHaveBeenCalledOnce());
            expect(onLoadDetailedAttempts).toHaveBeenCalledOnce();
            expect(createObjectURL).toHaveBeenCalledOnce();
            expect(clickSpy).toHaveBeenCalledOnce();
            await waitFor(() => expect(exportButton).toBeEnabled());
            expect(screen.queryByText("생성 중…", { exact: true })).not.toBeInTheDocument();
        } finally {
            clickSpy.mockRestore();
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    it("suppresses an archive completion after the fresh capability is replaced", async () => {
        const exam: Exam = {
            id: "exam-stale-archive",
            title: "이전 교사 시험",
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            questions: [],
        };
        let resolveArchive!: (value: { ok: true; exam: Exam }) => void;
        overviewTestMocks.archiveExam.mockReturnValueOnce(new Promise(resolve => {
            resolveArchive = resolve;
        }));
        const view = render(
            <OverviewTab
                capability="fresh_mutable"
                exams={[exam]}
                attempts={[]}
                stats={{ totalStudents: 0, avgScore: 0, activeExams: 1 }}
                trendData={[]}
                onLoadDetailedAttempts={vi.fn().mockResolvedValue([])}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "시험 작업 메뉴" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "보관" }));
        expect(overviewTestMocks.archiveExam).toHaveBeenCalledOnce();
        view.rerender(
            <OverviewTab
                capability="degraded_read_only"
                snapshot={buildDegradedOverviewSnapshot("active")}
            />,
        );

        await act(async () => {
            resolveArchive({ ok: true, exam: { ...exam, archived: true } });
        });
        expect(overviewTestMocks.toastSuccess).not.toHaveBeenCalled();
        expect(overviewTestMocks.toastError).not.toHaveBeenCalled();
        expect(screen.queryByText("이전 교사 시험", { exact: true })).not.toBeInTheDocument();
    });

    it("suppresses a delete completion after the fresh capability is replaced", async () => {
        const exam: Exam = {
            id: "exam-stale-delete",
            title: "이전 교사 삭제 시험",
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            questions: [],
        };
        let resolveDelete!: (value: { ok: true }) => void;
        overviewTestMocks.deleteExam.mockReturnValueOnce(new Promise(resolve => {
            resolveDelete = resolve;
        }));
        const view = render(
            <OverviewTab
                capability="fresh_mutable"
                exams={[exam]}
                attempts={[]}
                stats={{ totalStudents: 0, avgScore: 0, activeExams: 1 }}
                trendData={[]}
                onLoadDetailedAttempts={vi.fn().mockResolvedValue([])}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "시험 작업 메뉴" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
        fireEvent.click(within(screen.getByRole("dialog", { name: "시험 삭제 확인" }))
            .getByRole("button", { name: "삭제" }));
        expect(overviewTestMocks.deleteExam).toHaveBeenCalledOnce();
        view.rerender(<OverviewTab capability="unavailable" />);

        await act(async () => {
            resolveDelete({ ok: true });
        });
        expect(overviewTestMocks.toastSuccess).not.toHaveBeenCalled();
        expect(overviewTestMocks.toastError).not.toHaveBeenCalled();
        expect(screen.queryByText("이전 교사 삭제 시험", { exact: true })).not.toBeInTheDocument();
    });
});

describe("ExamAnalyticsReportOverview", () => {
    it("exports deleted submitted questions from canonical rows instead of the edited exam", () => {
        const rows = buildStudentQuestionAnalysisCsvRows({
            gradingSource: "canonical_submission",
            questionResults: [{
                schemaVersion: 1,
                attemptId: "attempt-deleted-question",
                examId: "exam-edited",
                examTitle: "수정된 시험",
                studentName: "학생",
                questionId: 99,
                questionNumber: 7,
                label: "삭제된 제출 문항",
                score: 5,
                earnedScore: 5,
                selectedAnswer: 2,
                correctAnswer: 2,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                finishedAt: "2026-08-10T00:10:00.000Z",
            }],
            labelScores: { "삭제된 제출 문항": { earned: 5, total: 5 } },
        });

        expect(rows).toContainEqual([7, "삭제된 제출 문항", 5, 2, 2, "O"]);
    });

    it("fails closed when the remote official snapshot is missing and labels bounded advanced omission honestly", () => {
        const { exam, attempt: canonicalAttempt } = buildReadyCanonicalAnalyticsFixture();

        const view = render(
            <ExamAnalyticsTab
                exams={[exam]}
                attempts={[canonicalAttempt]}
                currentPlan="pro"
                canonicalAnalyticsSnapshots={{}}
            />,
        );
        expect(screen.getByRole("alert")).toHaveTextContent("공식 문항 분석 근거를 확인하지 못했습니다");
        expect(screen.queryByRole("button", { name: "제출 정의 CSV" })).not.toBeInTheDocument();

        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, [canonicalAttempt]);
        view.rerender(
            <ExamAnalyticsTab
                exams={[exam]}
                attempts={[canonicalAttempt]}
                currentPlan="pro"
                canonicalAnalyticsSnapshots={{
                    [exam.id]: {
                        ...snapshot,
                        advancedAggregatesComplete: false,
                        pointBiserial: [],
                        similarQuestionGroups: [],
                        recommendations: [],
                        classMatrix: [],
                    },
                }}
            />,
        );
        expect(screen.getByText(/고급 추천 분석은 사용할 수 없습니다/)).toBeInTheDocument();
    });

    it("does not invoke the client grading verifier or index for an exact remote snapshot", async () => {
        const { exam, attempt: canonicalAttempt } = buildReadyCanonicalAnalyticsFixture();
        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, [canonicalAttempt]);
        const premium = await import("@/lib/premiumAnalytics");
        const indexSpy = vi.spyOn(premium, "buildCanonicalAttemptAnalyticsIndex");
        const resolveSpy = vi.spyOn(premium, "resolveAttemptGrading");

        render(
            <ExamAnalyticsTab
                exams={[exam]}
                attempts={[canonicalAttempt]}
                currentPlan="pro"
                canonicalAnalyticsSnapshots={{ [exam.id]: structuredClone(snapshot) }}
            />,
        );

        expect(indexSpy).not.toHaveBeenCalled();
        expect(resolveSpy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        expect(screen.getByRole("button", { name: "제출 정의 CSV" })).toBeEnabled();
    });

    it("emits only the gateway-supported exact complete wrong-answer retake link for official snapshots", () => {
        const fixture = buildUngradedExamAnalyticsFixture();
        const exactExam: Exam = {
            ...fixture.exam,
            questions: fixture.exam.questions.map(question => ({ ...question, answer: 2 })),
        };
        const source = fixture.attempts[0];
        const exactAttempt = sealFixtureAttempt({
            ...source,
            organizationId: "org-analytics",
            classId: "class-analytics",
            studentProfileId: "profile-analytics",
            studentId: "student-analytics",
            identityType: "registered",
            score: 0,
            totalScore: 10,
            questionResults: (source.questionResults || []).map(result => ({
                ...result,
                score: 10,
                earnedScore: 0,
                selectedAnswer: 1,
                correctAnswer: 2,
                status: "wrong" as const,
                isCorrect: false,
                isWrong: true,
                isUnanswered: false,
            })),
        });
        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exactExam, [exactAttempt]);

        render(
            <ExamAnalyticsTab
                exams={[exactExam]}
                attempts={[exactAttempt]}
                currentPlan="pro"
                canonicalAnalyticsSnapshots={{ [exactExam.id]: structuredClone(snapshot) }}
            />,
        );

        expect(screen.queryByRole("link", { name: /보강 세트 만들기/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));
        const retake = screen.getByRole("link", { name: "오답 1문항" });
        expect(retake).toHaveAttribute("href", expect.stringContaining(`retakeFrom=${encodeURIComponent(exactAttempt.id)}`));
        expect(retake).toHaveAttribute("href", expect.stringContaining("questions=1"));
        expect(retake).toHaveAttribute("href", expect.stringContaining("mode=wrong"));
        expect(retake).toHaveAttribute("href", expect.stringContaining("cohorts="));
        expect(screen.queryByRole("link", { name: /유사|재추천|반별 세트|세트 재시험/ })).not.toBeInTheDocument();
    });

    it("does not invoke the raw grading resolver for remote student analytics", async () => {
        const { exam, attempt: canonicalAttempt } = buildReadyCanonicalAnalyticsFixture();
        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, [canonicalAttempt]);
        const premium = await import("@/lib/premiumAnalytics");
        const resolveSpy = vi.spyOn(premium, "resolveAttemptGrading");
        const StudentAnalyticsTab = (await import("./StudentAnalyticsTab")).default;
        resolveSpy.mockClear();

        render(
            <StudentAnalyticsTab
                exams={[exam]}
                attempts={[canonicalAttempt]}
                currentPlan="pro"
                canonicalAnalyticsSnapshots={{ [exam.id]: structuredClone(snapshot) }}
            />,
        );

        expect(resolveSpy).not.toHaveBeenCalled();
    });
    it("supports active-option keyboard navigation and selection in the exam combobox", () => {
        const { exam } = buildUngradedExamAnalyticsFixture();
        const secondExam: Exam = {
            ...exam,
            id: "exam-second",
            title: "두 번째 진단",
            questions: exam.questions.map(question => ({ ...question })),
        };
        render(<ExamAnalyticsTab exams={[exam, secondExam]} attempts={[]} currentPlan="free" />);

        const combobox = screen.getByRole("combobox", { name: "시험" });
        fireEvent.focus(combobox);

        const firstOption = screen.getByRole("option", { name: /미채점 진단/ });
        const secondOption = screen.getByRole("option", { name: /두 번째 진단/ });
        expect(firstOption).toHaveAttribute("id");
        expect(combobox).toHaveAttribute("aria-activedescendant", firstOption.id);
        expect(firstOption).toHaveAttribute("aria-selected", "true");

        fireEvent.keyDown(combobox, { key: "ArrowDown" });
        expect(combobox).toHaveAttribute("aria-activedescendant", secondOption.id);
        expect(secondOption).toHaveAttribute("aria-selected", "true");
        expect(firstOption).toHaveAttribute("aria-selected", "false");

        fireEvent.keyDown(combobox, { key: "Home" });
        expect(combobox).toHaveAttribute("aria-activedescendant", firstOption.id);
        fireEvent.keyDown(combobox, { key: "End" });
        expect(combobox).toHaveAttribute("aria-activedescendant", secondOption.id);
        fireEvent.keyDown(combobox, { key: "ArrowUp" });
        expect(combobox).toHaveAttribute("aria-activedescendant", firstOption.id);

        fireEvent.keyDown(combobox, { key: "ArrowDown" });
        fireEvent.keyDown(combobox, { key: "Enter" });
        expect(combobox).toHaveValue("두 번째 진단");
        expect(combobox).toHaveAttribute("aria-expanded", "false");
        expect(combobox).not.toHaveAttribute("aria-activedescendant");

        fireEvent.focus(combobox);
        fireEvent.change(combobox, { target: { value: "미채점" } });
        const filteredOption = screen.getByRole("option", { name: /미채점 진단/ });
        expect(combobox).toHaveAttribute("aria-activedescendant", filteredOption.id);
        fireEvent.change(combobox, { target: { value: "없는 시험" } });
        expect(combobox).not.toHaveAttribute("aria-activedescendant");
        expect(screen.getByText("검색 결과가 없습니다")).toBeInTheDocument();
        fireEvent.keyDown(combobox, { key: "Escape" });
        expect(combobox).toHaveValue("두 번째 진단");
        expect(combobox).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps listbox options out of the Tab order while preserving pointer selection", () => {
        const { exam } = buildUngradedExamAnalyticsFixture();
        const secondExam: Exam = {
            ...exam,
            id: "exam-pointer",
            title: "포인터 선택 진단",
            questions: exam.questions.map(question => ({ ...question })),
        };
        const { container } = render(<ExamAnalyticsTab exams={[exam, secondExam]} attempts={[]} currentPlan="free" />);

        const combobox = screen.getByRole("combobox", { name: "시험" });
        combobox.focus();
        fireEvent.focus(combobox);
        const options = within(screen.getByRole("listbox")).getAllByRole("option");

        expect(combobox).toHaveFocus();
        options.forEach(option => expect(option).toHaveAttribute("tabindex", "-1"));
        const tabStops = Array.from(container.querySelectorAll<HTMLElement>("input, select, button, [tabindex]"))
            .filter(element => element.tabIndex >= 0 && !element.hasAttribute("disabled"));
        const nextTabStop = tabStops[tabStops.indexOf(combobox) + 1];
        expect(nextTabStop).toBe(screen.getByRole("combobox", { name: "시험 분석 지역 필터" }));
        nextTabStop.focus();
        expect(screen.getByRole("combobox", { name: "시험 분석 지역 필터" })).toHaveFocus();

        fireEvent.mouseDown(screen.getByRole("option", { name: /포인터 선택 진단/ }));
        expect(combobox).toHaveValue("포인터 선택 진단");
        expect(combobox).toHaveAttribute("aria-expanded", "false");
    });

    it("scrolls only keyboard-changed active options into the visible listbox area", () => {
        const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });

        try {
            const { exam } = buildUngradedExamAnalyticsFixture();
            const exams = [exam, ...Array.from({ length: 4 }, (_, index): Exam => ({
                ...exam,
                id: `exam-scroll-${index + 1}`,
                title: `스크롤 진단 ${index + 1}`,
                questions: exam.questions.map(question => ({ ...question })),
            }))];
            render(<ExamAnalyticsTab exams={exams} attempts={[]} currentPlan="free" />);

            const combobox = screen.getByRole("combobox", { name: "시험" });
            combobox.focus();
            fireEvent.focus(combobox);
            expect(scrollIntoView).not.toHaveBeenCalled();

            fireEvent.keyDown(combobox, { key: "ArrowDown" });
            expect(scrollIntoView).toHaveBeenCalledTimes(1);
            expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
            expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole("option", { name: /스크롤 진단 1/ }));

            fireEvent.keyDown(combobox, { key: "Home" });
            expect(scrollIntoView).toHaveBeenCalledTimes(2);
            fireEvent.keyDown(combobox, { key: "Home" });
            expect(scrollIntoView).toHaveBeenCalledTimes(2);
        } finally {
            if (originalScrollIntoView) {
                Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
            } else {
                delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
            }
        }
    });

    it("uses semantic sortable headers with keyboard-operable buttons", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const namedAttempts = attempts.slice(0, 2).map((attempt, index) => ({
            ...attempt,
            studentName: index === 0 ? "가 학생" : "나 학생",
            score: index === 0 ? 10 : 5,
            totalScore: 10,
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={namedAttempts} currentPlan="free" />);
        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));

        const studentTableRegion = screen.getByRole("region", { name: "학생별 점수 및 성취도 표" });
        const nameHeader = within(studentTableRegion).getByRole("columnheader", { name: "학생 이름" });
        const scoreHeader = within(studentTableRegion).getByRole("columnheader", { name: "총점" });
        expect(nameHeader).toHaveAttribute("aria-sort", "none");
        expect(scoreHeader).toHaveAttribute("aria-sort", "descending");

        const nameSortButton = within(nameHeader).getByRole("button", {
            name: "학생 이름 정렬 (정렬 안 됨)",
        });
        nameSortButton.focus();
        expect(nameSortButton).toHaveFocus();
        fireEvent.click(nameSortButton);
        expect(nameHeader).toHaveAttribute("aria-sort", "descending");
        expect(within(nameHeader).getByRole("button")).toHaveAccessibleName("학생 이름 정렬 (내림차순)");

        fireEvent.click(within(nameHeader).getByRole("button"));
        expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
        expect(within(within(studentTableRegion).getAllByRole("row")[1]).getAllByRole("cell")[0]).toHaveTextContent("가 학생");
    });

    it("exposes every dense analytics table as a named focusable scroll region", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const groupedAttempts = attempts.map((attempt, index) => ({
            ...attempt,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={groupedAttempts} currentPlan="pro" />);

        const assertScrollRegion = (name: string) => {
            const region = screen.getByRole("region", { name });
            expect(region).toHaveAttribute("tabindex", "0");
            const descriptionId = region.getAttribute("aria-describedby");
            expect(descriptionId).toBeTruthy();
            expect(document.getElementById(descriptionId!)).toBeVisible();
            expect(document.getElementById(descriptionId!)).toHaveTextContent("좌우로 스크롤");
        };

        fireEvent.click(screen.getByRole("tab", { name: "운영" }));
        assertScrollRegion("문항 DB 준비 상태 표");

        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        assertScrollRegion("문항별 상세 분석 표");

        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));
        assertScrollRegion("반별 시험 분석 매트릭스 표");
        assertScrollRegion("학생별 점수 및 성취도 표");

        const css = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.module.css"),
            "utf8",
        );
        expect(css).toMatch(/\.horizontalTableRegion\s*\{[\s\S]*?overscroll-behavior-x:\s*contain/);
        expect(css).toMatch(/\.horizontalTableRegion:focus-visible\s*\{/);
    });

    it("renders a fully ungraded question as neutral evidence without actions or percentages", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        render(<ExamAnalyticsTab exams={[exam]} attempts={attempts} currentPlan="free" />);

        expect(screen.getByRole("heading", { name: "채점 가능한 문항 근거가 더 필요합니다" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /보강이 가장 효과적/ })).not.toBeInTheDocument();
        expect(screen.queryByText("보강 세트 만들기")).not.toBeInTheDocument();

        const metricsRegion = screen.getByRole("region", { name: "시험 핵심 지표" });
        expect(within(metricsRegion).getByText("평균").parentElement).toHaveTextContent("평균-");
        expect(within(metricsRegion).getByText("중앙값").parentElement).toHaveTextContent("중앙값-");
        expect(within(metricsRegion).getByText("최고").parentElement).toHaveTextContent("최고-");
        expect(within(metricsRegion).getByText("최저").parentElement).toHaveTextContent("최저-");
        expect(within(metricsRegion).getByText("채점 응시").parentElement).toHaveTextContent("채점 응시0명전체 제출 5건");
        expect(within(screen.getByRole("region", { name: "점수 분포" })).getByRole("status"))
            .toHaveTextContent("채점 가능한 점수 근거가 없습니다.");
        expect(within(screen.getByRole("region", { name: "성취 구간" })).getByRole("status"))
            .toHaveTextContent("채점 가능한 점수 근거가 없습니다.");

        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        const row = screen.getByRole("row", { name: /1번.*시제/ });
        const cells = within(row).getAllByRole("cell");

        expect(cells[1]).toHaveTextContent("미채점");
        expect(cells[1]).not.toHaveTextContent("보강");
        expect(cells[2]).toHaveTextContent(/^-$|^근거 없음$/);
        expect(cells[4]).toHaveTextContent(/^-$|^근거 없음$/);
        expect(within(row).queryByText("0%")).not.toBeInTheDocument();
        expect(screen.getByText("문항별 상세 정답률 데이터: 1번 미채점.")).toBeInTheDocument();

        const chart = screen.getByRole("img", { name: "문항별 상세 정답률" });
        expect(chart.querySelector(".recharts-tooltip-wrapper")).not.toBeNull();
    });

    it("renders an active ungraded chart payload as a neutral tooltip", () => {
        const { container } = render(
            <QuestionCorrectRateTooltip
                active
                label={1}
                payload={[{ value: null }]}
            />,
        );

        expect(within(container).getByRole("status")).toHaveTextContent("1번 문항정답률: 미채점");
        expect(within(container).queryByText("0%")).not.toBeInTheDocument();

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("filterNull={false}");
        expect(source).toContain("content={<QuestionCorrectRateTooltip />}");
    });

    it("keeps premium class aggregates and ungraded student rows neutral", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        exam.questions[0] = { ...exam.questions[0], answer: 2 };
        const mixedAttempts = attempts.map((attempt, index) => sealFixtureAttempt({
            ...attempt,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
            score: index === 0 ? 10 : 0,
            totalScore: index === 0 ? 10 : 0,
            questionResults: attempt.questionResults?.map(result => index === 0 ? {
                ...result,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 2,
                correctAnswer: 2,
                status: "correct" as const,
                isCorrect: true,
            } : result),
        }));
        document.documentElement.dataset.motion = "off";
        render(<ExamAnalyticsTab exams={[exam]} attempts={mixedAttempts} currentPlan="pro" />);

        expect(screen.getByText("전체 제출 5건 중 채점 가능한 1명 기준입니다.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));

        const classScoreRegion = screen.getByRole("heading", { name: "반별 점수 비교" }).closest<HTMLElement>(".card");
        expect(classScoreRegion).not.toBeNull();
        expect(within(classScoreRegion!).getByText("최저 100% · 중앙값 100% · 평균 100% · 최고 100% · 1명"))
            .toBeInTheDocument();

        const matrixRow = screen.getByRole("row", { name: /A반.*제출 5건/ });
        expect(matrixRow).toHaveTextContent("채점 1명");
        expect(matrixRow).toHaveTextContent("100%");

        const ungradedStudentRow = screen.getByRole("row", { name: /학생 2/ });
        expect(ungradedStudentRow).toHaveTextContent("미채점");
        expect(ungradedStudentRow).not.toHaveTextContent("0점");
        expect(ungradedStudentRow).not.toHaveTextContent("(0%)");
        expect(ungradedStudentRow).not.toHaveTextContent("정답률 0%");

        fireEvent.click(screen.getByRole("button", { name: "학생별" }));
        const ungradedOption = screen.getByRole("option", { name: "학생 2 · A반 (미채점)" });
        const studentSelect = ungradedOption.closest<HTMLSelectElement>("select");
        expect(studentSelect).not.toBeNull();
        fireEvent.change(studentSelect!, { target: { value: "student-2" } });
        expect(screen.getByText("학생 2 · A반 · 미채점")).toBeInTheDocument();
    });

    it("renders a fully ungraded class matrix as unavailable evidence", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const groupedAttempts = attempts.map((attempt, index) => ({
            ...attempt,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={groupedAttempts} currentPlan="pro" />);

        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));
        const matrixRow = screen.getByRole("row", { name: /A반.*제출 5건/ });

        expect(matrixRow).toHaveTextContent("미채점");
        expect(matrixRow).toHaveTextContent("근거 없음");
        expect(matrixRow).not.toHaveTextContent("0%");
        expect(matrixRow).not.toHaveTextContent("안정");
        expect(matrixRow).not.toHaveTextContent("추가 보강 없음");
        expect(matrixRow).not.toHaveTextContent("유지");
    });

    it("keeps fully ungraded student and regional operation conclusions neutral", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const groupedAttempts = attempts.map((attempt, index) => ({
            ...attempt,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
            regionName: "서울",
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={groupedAttempts} currentPlan="pro" />);

        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));
        const studentRow = screen.getByRole("row", { name: /학생 1/ });
        expect(studentRow).toHaveTextContent("미채점");
        expect(studentRow).toHaveTextContent("근거 없음");
        expect(studentRow).not.toHaveTextContent("안정");
        expect(studentRow).not.toHaveTextContent("완료");

        fireEvent.click(screen.getByRole("tab", { name: "운영" }));
        const operationsCard = screen.getByRole("heading", { name: "지역별 다음 액션" }).closest<HTMLElement>(".card");
        expect(operationsCard).not.toBeNull();
        expect(within(operationsCard!).getByText(/평균 미채점/)).toBeInTheDocument();
        expect(within(operationsCard!).getByText("근거 없음")).toBeInTheDocument();
        expect(operationsCard).not.toHaveTextContent("관찰");
        expect(operationsCard).not.toHaveTextContent("추가 조치 없음");
        expect(within(operationsCard!).queryByText("재시험 만들기")).not.toBeInTheDocument();
    });

    it.each([
        ["partial" as const, "일부 제출 기준의 중간 결과입니다."],
        ["stale" as const, "최신 제출이 아직 반영되지 않았을 수 있습니다."],
    ])("keeps the %s qualifier persistent and links it to the metric and headline sections", (sampleStatus, copy) => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        render(
            <ExamAnalyticsTab
                exams={[exam]}
                attempts={attempts}
                currentPlan="free"
                sampleStatus={sampleStatus}
            />,
        );

        const contextRegion = screen.getByRole("region", { name: "시험별 통계" });
        const qualifier = within(contextRegion).getByText(copy);
        expect(qualifier).toHaveAttribute("id", "exam-analytics-sample-qualifier");
        expect(screen.getAllByText(copy)).toHaveLength(1);
        expect(screen.getByRole("region", { name: "시험 핵심 지표" })).toHaveAttribute(
            "aria-describedby",
            "exam-analytics-sample-qualifier",
        );
        expect(screen.getByRole("region", { name: "시험 핵심 해석" })).toHaveAttribute(
            "aria-describedby",
            "exam-analytics-sample-qualifier",
        );

        for (const tabName of ["문항 분석", "학생·반", "운영", "요약"]) {
            fireEvent.click(screen.getByRole("tab", { name: tabName }));
            expect(within(contextRegion).getByText(copy)).toBeInTheDocument();
            expect(screen.getAllByText(copy)).toHaveLength(1);
        }
    });

    it("keeps graded question diagnostics and percentages unchanged", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        exam.questions[0] = { ...exam.questions[0], answer: 2 };
        const gradedAttempts = attempts.map(attempt => sealFixtureAttempt({
            ...attempt,
            score: 10,
            totalScore: 10,
            answers: { 1: 2 },
            questionResults: attempt.questionResults?.map(result => ({
                ...result,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 2,
                correctAnswer: 2,
                status: "correct" as const,
                isCorrect: true,
            })),
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={gradedAttempts} currentPlan="free" />);

        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        const row = screen.getByRole("row", { name: /1번.*시제/ });
        const cells = within(row).getAllByRole("cell");

        expect(cells[1]).toHaveTextContent("쉬움");
        expect(cells[2]).toHaveTextContent("100%");
        expect(cells[4]).toHaveTextContent("0%");
        expect(within(row).getAllByText("100%").length).toBeGreaterThanOrEqual(2);
    });

    it("excludes ungraded submissions without depressing mixed performance aggregates", () => {
        document.documentElement.setAttribute("data-motion", "off");
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const mixedAttempts = attempts.map((attempt, index) => index === 0 ? {
            ...attempt,
            score: 10,
            totalScore: 10,
        } : attempt);
        render(<ExamAnalyticsTab exams={[exam]} attempts={mixedAttempts} currentPlan="free" />);

        const metricsRegion = screen.getByRole("region", { name: "시험 핵심 지표" });
        expect(within(metricsRegion).getByText("평균").parentElement).toHaveTextContent("평균100점");
        expect(within(metricsRegion).getByText("최저").parentElement).toHaveTextContent("최저100점");
        expect(within(metricsRegion).getByText("채점 응시").parentElement).toHaveTextContent("채점 응시1명전체 제출 5건");
        expect(screen.getByRole("img", { name: "점수 구간별 응시 인원" })).toHaveAccessibleDescription(
            "90-100점 구간이 1명으로 가장 많습니다. 총 1명입니다.",
        );

        const achievementRegion = screen.getByRole("region", { name: "성취 구간" });
        expect(within(achievementRegion).getByText("40점 미만").closest("li")).toHaveTextContent("0명0%");
        expect(within(achievementRegion).getByText("80~100점").closest("li")).toHaveTextContent("1명100%");
    });

    it("renders the approved editorial report regions in exact reading order", () => {
        render(<ExamAnalyticsReportOverview {...buildProps()} />);

        const orderedRegions = [
            screen.getByRole("region", { name: "시험 핵심 지표" }),
            screen.getByRole("region", { name: "시험 핵심 해석" }),
            screen.getByRole("region", { name: "점수 분포" }),
            screen.getByRole("region", { name: "성취 구간" }),
            screen.getByRole("region", { name: "취약 문항" }),
            screen.getByRole("region", { name: "다음 행동" }),
        ];

        for (let index = 1; index < orderedRegions.length; index += 1) {
            expect(
                orderedRegions[index - 1].compareDocumentPosition(orderedRegions[index])
                & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }

        const headline = screen.getByRole("heading", {
            name: "‘이차함수’ 보강이 가장 효과적입니다",
        });
        expect(
            headline.compareDocumentPosition(screen.getByRole("region", { name: "점수 분포" }))
            & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("exposes score distribution and weak-question evidence as accessible tables", () => {
        render(<ExamAnalyticsReportOverview {...buildProps()} />);

        expect(screen.getByRole("img", { name: "점수 구간별 응시 인원" })).toHaveAccessibleDescription(
            "20-30점 구간이 4명으로 가장 많습니다. 총 9명입니다.",
        );
        expect(screen.getByRole("table", { name: "점수 분포 데이터" })).toBeInTheDocument();

        const weakTable = screen.getByRole("table", { name: "취약 문항 근거" });
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "문항" }));
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "정답률" }));
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "근거" }));
        expect(screen.getByRole("row", { name: /7번 이차함수 32%/ })).toBeInTheDocument();

        const gradeRate = screen.getByText("32%");
        expect(gradeRate.className).toContain("rateGrade");
    });

    it("links one external sample qualifier without duplicating its copy", () => {
        render(
            <>
                <p id="sample-note">일부 제출 기준의 중간 결과입니다.</p>
                <ExamAnalyticsReportOverview
                    {...buildProps({ sampleStatusDescriptionId: "sample-note" })}
                />
            </>,
        );

        expect(screen.getByRole("region", { name: "시험 핵심 지표" })).toHaveAttribute(
            "aria-describedby",
            "sample-note",
        );
        expect(screen.getByRole("region", { name: "시험 핵심 해석" })).toHaveAttribute(
            "aria-describedby",
            "sample-note",
        );
        expect(screen.getAllByText("일부 제출 기준의 중간 결과입니다.")).toHaveLength(1);
    });

    it("preserves linked and callback actions", () => {
        const onAction = vi.fn();
        render(
            <ExamAnalyticsReportOverview
                {...buildProps({
                    actions: [
                        {
                            key: "retake",
                            title: "보강 세트 만들기",
                            detail: "취약 문항으로 재시험을 구성합니다.",
                            href: "/teacher/retake?question=7",
                        },
                        {
                            key: "students",
                            title: "지원 학생 보기",
                            detail: "60점 미만 학생을 확인합니다.",
                            onAction,
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByRole("link", { name: /보강 세트 만들기/ })).toHaveAttribute(
            "href",
            "/teacher/retake?question=7",
        );
        fireEvent.click(screen.getByRole("button", { name: /지원 학생 보기/ }));
        expect(onAction).toHaveBeenCalledOnce();
    });
});

describe("exam overview wiring", () => {
    it("delegates only the overview workspace to the editorial report component", () => {
        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );

        expect(source).toMatch(/import ExamAnalyticsReportOverview,[\s\S]*?from "\.\/ExamAnalyticsReportOverview"/);
        expect(source).toContain("buildExamHeadlineInsight({");
        expect(source).toContain("<ExamAnalyticsReportOverview");
        expect(source).toContain('activeWorkspaceView === "questions"');
        expect(source).toContain('activeWorkspaceView === "students"');
        expect(source).toContain('activeWorkspaceView === "operations"');
    });

    it("hides the generic next-action strip only on the exam analytics tab", () => {
        const source = readFileSync(
            path.join(process.cwd(), "src/app/teacher/dashboard/page.tsx"),
            "utf8",
        );

        expect(source).toContain(
            'dashboardHasRenderableData && !isMockupAccount && teacherDataCapability === "fresh_mutable" && activeTab !== "overview" && activeTab !== "exam"',
        );
        expect(source).not.toContain('.filter(action => dashboardAllowsMutations || (action.key !== "create" && action.key !== "repair"))');
        expect(source).toContain("questionResultRepairPlan.repairableCount > 0");
    });

    it("threads loader completeness from the dashboard into the report sample note", () => {
        const dashboardSource = readFileSync(
            path.join(process.cwd(), "src/app/teacher/dashboard/page.tsx"),
            "utf8",
        );
        const tabSource = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );

        expect(dashboardSource).toContain("sampleStatus={detailedAttemptSampleStatus}");
        expect(tabSource).toContain("sampleStatus = \"ready\"");
        expect(tabSource).toContain("examAnalyticsSampleStatusNote(sampleStatus)");
        expect(tabSource).toContain("EXAM_ANALYTICS_SAMPLE_QUALIFIER_ID");
    });

    it("excludes zero-denominator questions from actionable evidence", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const filterGradableQuestionEvidence = (
            examAnalyticsModule as unknown as {
                filterGradableQuestionEvidence?: <T extends { totalCount: number }>(items: T[]) => T[];
            }
        ).filterGradableQuestionEvidence;
        const items = [
            { id: "ungraded", totalCount: 0 },
            { id: "graded", totalCount: 4 },
        ];

        expect(filterGradableQuestionEvidence).toBeTypeOf("function");
        expect(filterGradableQuestionEvidence?.(items)).toEqual([items[1]]);

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("const gradableQuestionAnalytics = useMemo");
        expect(source).toContain("hasGradableEvidence: gradableQuestionAnalytics.length > 0");
        expect(source).not.toContain("questionAnalytics.slice(0, 5).map");
    });

    it("uses null chart values and a neutral label for questions without a denominator", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const buildQuestionCorrectRateChartData = (
            examAnalyticsModule as unknown as {
                buildQuestionCorrectRateChartData?: <T extends {
                    index: number;
                    totalCount: number;
                    correctRate: number;
                }>(items: T[]) => Array<T & { correctRate: number | null; correctRateLabel: string }>;
            }
        ).buildQuestionCorrectRateChartData;
        const input = [
            { index: 1, totalCount: 0, correctRate: 0 },
            { index: 2, totalCount: 5, correctRate: 60 },
        ];

        expect(buildQuestionCorrectRateChartData).toBeTypeOf("function");
        expect(buildQuestionCorrectRateChartData?.(input)).toEqual([
            { index: 1, totalCount: 0, correctRate: null, correctRateLabel: "미채점" },
            { index: 2, totalCount: 5, correctRate: 60, correctRateLabel: "60%" },
        ]);
    });

    it("uses the shared denominator policy for stored and computed scores", async () => {
        const { hasGradableAttemptScore } = await import("@/lib/premiumAnalytics");

        expect(hasGradableAttemptScore({ totalScore: 10, scorePercent: 0 })).toBe(true);
        expect(hasGradableAttemptScore({ totalScore: 0, scorePercent: 0 })).toBe(false);
        expect(hasGradableAttemptScore({ totalScore: Number.NaN, scorePercent: 80 })).toBe(false);
        expect(hasGradableAttemptScore({ totalScore: 10, scorePercent: Number.NaN })).toBe(false);
    });

    it("keeps the true risky-question total while capping the overview evidence list", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const summarizeRiskyQuestions = (
            examAnalyticsModule as unknown as {
                summarizeRiskyQuestions?: <T>(items: T[]) => {
                    displayQuestions: T[];
                    totalCount: number;
                };
            }
        ).summarizeRiskyQuestions;
        const riskyQuestions = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }));

        expect(summarizeRiskyQuestions).toBeTypeOf("function");
        expect(summarizeRiskyQuestions?.(riskyQuestions)).toEqual({
            displayQuestions: riskyQuestions.slice(0, 5),
            totalCount: 7,
        });

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("riskyQuestionCount: teachingInsights?.riskyQuestionCount ?? 0");
    });

    it("uses the uncapped risky total in the question-quality action title", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const buildQuestionQualityActionTitle = (
            examAnalyticsModule as unknown as {
                buildQuestionQualityActionTitle?: (
                    riskyQuestionCount: number,
                    tooEasyCount: number,
                ) => string;
            }
        ).buildQuestionQualityActionTitle;

        expect(buildQuestionQualityActionTitle).toBeTypeOf("function");
        expect(buildQuestionQualityActionTitle?.(7, 2)).toBe("문항 품질 9개 점검");

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain(
            "buildQuestionQualityActionTitle(teachingInsights.riskyQuestionCount, teachingInsights.tooEasyCount)",
        );
        expect(source).not.toContain(
            "teachingInsights.riskyQuestions.length + teachingInsights.tooEasyCount",
        );
    });

    it("uses the semantic warning text token for partial and stale sample notes", () => {
        const css = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.module.css"),
            "utf8",
        );
        const ruleStart = css.lastIndexOf(".reportSampleNote {");
        const sampleNoteRule = css.slice(ruleStart, css.indexOf("}", ruleStart));

        expect(sampleNoteRule).toContain("color: var(--text-warning)");
        expect(sampleNoteRule).not.toContain("color: var(--warning)");
    });
});
