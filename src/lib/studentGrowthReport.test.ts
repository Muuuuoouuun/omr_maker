import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    buildStudentGrowthReport,
    growthClassKeyForAttempt,
    type GrowthDataStatus,
} from "./studentGrowthReport";

const exam = (id: string, title = id): Exam => ({
    id,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    questions: [],
});

function attempt(partial: Partial<Attempt> & Pick<Attempt, "id" | "examId">): Attempt {
    return {
        id: partial.id,
        examId: partial.examId,
        examTitle: partial.examTitle ?? partial.examId,
        studentName: partial.studentName ?? "김학생",
        studentProfileId: partial.studentProfileId,
        studentId: partial.studentId,
        classId: partial.classId,
        groupId: partial.groupId,
        groupName: partial.groupName,
        regionId: partial.regionId,
        regionName: partial.regionName,
        startedAt: partial.startedAt ?? "2026-01-01T09:00:00.000Z",
        finishedAt: partial.finishedAt ?? "2026-01-01T10:00:00.000Z",
        score: partial.score ?? 0,
        totalScore: partial.totalScore ?? 100,
        answers: partial.answers ?? {},
        retake: partial.retake,
        status: partial.status ?? "completed",
    };
}

function build(
    attempts: Attempt[],
    exams: Exam[] = [],
    overrides: Partial<{
        selectedStudentId: string;
        selectedClassKey: string;
        dataStatus: GrowthDataStatus;
    }> = {},
) {
    return buildStudentGrowthReport({
        selectedStudentId: "student-1",
        selectedClassKey: "class-a",
        dataStatus: "ready",
        attempts,
        exams,
        ...overrides,
    });
}

describe("student growth report", () => {
    it("returns an empty ready model when the selected student has no base scores", () => {
        expect(build([])).toEqual({
            status: "ready",
            rows: [],
            latestScore: null,
            averageGap: null,
            currentRank: null,
            rankDelta: null,
            trend: "insufficient",
        });
    });

    it("uses classId before groupId when isolating the selected class", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentProfileId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "peer", examId: "exam-1", studentProfileId: "student-2", classId: "class-a", score: 60 }),
            attempt({ id: "other", examId: "exam-1", studentProfileId: "student-3", classId: "class-b", groupId: "class-a", score: 100 }),
        ], [exam("exam-1", "중간고사")]);

        expect(model.rows).toEqual([{
            examId: "exam-1",
            examTitle: "중간고사",
            finishedAt: "2026-01-01T10:00:00.000Z",
            studentScore: 80,
            classAverage: 70,
            gap: 10,
            rank: 1,
            participantCount: 2,
            isLatest: true,
        }]);
    });

    it("keeps same-name fallback classes in different regions isolated", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", regionName: "서울", groupName: "A반", score: 80 }),
            attempt({ id: "seoul-peer", examId: "exam-1", studentId: "student-2", regionName: "서울", groupName: "A반", score: 60 }),
            attempt({ id: "busan-peer", examId: "exam-1", studentId: "student-3", regionName: "부산", groupName: "A반", score: 100 }),
        ], [exam("exam-1")], { selectedClassKey: "서울::A반" });

        expect(model.rows[0]).toMatchObject({
            classAverage: 70,
            participantCount: 2,
            rank: 1,
        });
    });

    it("exports the canonical class key and prefers regionId over regionName", () => {
        const selected = attempt({
            id: "selected",
            examId: "exam-1",
            studentId: "student-1",
            regionId: "Region-Seoul",
            regionName: "부산",
            groupName: "A반",
            score: 80,
        });
        const peer = attempt({
            id: "peer",
            examId: "exam-1",
            studentId: "student-2",
            regionId: "Region-Seoul",
            regionName: "대전",
            groupName: "A반",
            score: 60,
        });
        const selectedClassKey = growthClassKeyForAttempt(selected);

        expect(selectedClassKey).toBe("Region-Seoul::a반");
        expect(build([selected, peer], [], { selectedClassKey }).rows[0]).toMatchObject({
            classAverage: 70,
            participantCount: 2,
        });
    });

    it("orders rows oldest-to-newest and marks only the newest row latest", () => {
        const model = build([
            attempt({ id: "new", examId: "exam-3", studentId: "student-1", classId: "class-a", finishedAt: "2026-03-01T10:00:00.000Z", score: 90 }),
            attempt({ id: "old", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 70 }),
            attempt({ id: "middle", examId: "exam-2", studentId: "student-1", classId: "class-a", finishedAt: "2026-02-01T10:00:00.000Z", score: 80 }),
        ]);

        expect(model.rows.map(row => [row.examId, row.isLatest])).toEqual([
            ["exam-1", false],
            ["exam-2", false],
            ["exam-3", true],
        ]);
    });

    it("excludes retakes from selected scores and class comparisons", () => {
        const retake = {
            sourceAttemptId: "selected-base",
            questionIds: [1],
            mode: "wrong" as const,
            createdAt: "2026-01-01T10:30:00.000Z",
        };
        const model = build([
            attempt({ id: "selected-base", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 50 }),
            attempt({ id: "peer-base", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 70 }),
            attempt({ id: "selected-retake", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T11:00:00.000Z", score: 100, retake }),
            attempt({ id: "peer-retake", examId: "exam-1", studentId: "student-2", classId: "class-a", finishedAt: "2026-01-01T11:00:00.000Z", score: 100, retake }),
        ]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            studentScore: 50,
            classAverage: 60,
            gap: -10,
            rank: 2,
            participantCount: 2,
        });
    });

    it("uses the latest representative base submission per student and exam", () => {
        const model = build([
            attempt({ id: "selected-old", examId: "exam-1", studentProfileId: "student-1", classId: "class-a", finishedAt: "2026-01-01T09:00:00.000Z", score: 40 }),
            attempt({ id: "selected-b", examId: "exam-1", studentProfileId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 80 }),
            attempt({ id: "selected-a", examId: "exam-1", studentProfileId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 90 }),
            attempt({ id: "peer-old", examId: "exam-1", studentProfileId: "student-2", classId: "class-a", finishedAt: "2026-01-01T09:00:00.000Z", score: 30 }),
            attempt({ id: "peer-new", examId: "exam-1", studentProfileId: "student-2", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 70 }),
        ]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            finishedAt: "2026-01-01T10:00:00.000Z",
            studentScore: 90,
            classAverage: 80,
            participantCount: 2,
            rank: 1,
        });
    });

    it("does not let a newer in-progress attempt replace a completed submission", () => {
        const model = build([
            attempt({ id: "selected-completed", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 70 }),
            attempt({ id: "selected-progress", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T11:00:00.000Z", score: 100, status: "in_progress" }),
            attempt({ id: "peer", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 80 }),
        ]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            studentScore: 70,
            classAverage: 75,
            participantCount: 2,
            rank: 2,
        });
    });

    it("preserves a legacy final attempt with no stored status", () => {
        const legacyAttempt = {
            ...attempt({ id: "legacy", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 65 }),
            status: undefined,
        } as unknown as Attempt;

        expect(build([legacyAttempt]).rows[0]?.studentScore).toBe(65);
    });

    it("resolves scores from canonical exam grading instead of stale stored totals", () => {
        const canonicalExam: Exam = {
            id: "exam-1",
            title: "채점 기준 시험",
            createdAt: "2026-01-01T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, answer: 1, score: 5 },
                { id: 2, number: 2, answer: 2, score: 5 },
            ],
        };
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", answers: { 1: 1, 2: 1 }, score: 100, totalScore: 100 }),
            attempt({ id: "peer", examId: "exam-1", studentId: "student-2", classId: "class-a", answers: { 1: 1, 2: 2 }, score: 0, totalScore: 100 }),
        ], [canonicalExam]);

        expect(model.rows[0]).toMatchObject({
            studentScore: 50,
            classAverage: 75,
            gap: -25,
            rank: 2,
        });
    });

    it("inherits invalid-denominator handling and clamping from score resolution", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 15, totalScore: 10 }),
            attempt({ id: "peer", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 5, totalScore: 0 }),
        ]);

        expect(model.rows[0]).toMatchObject({
            studentScore: 100,
            classAverage: 50,
            participantCount: 2,
            rank: 1,
        });
    });

    it("counts every higher-scoring participant while selected-score ties share rank", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "peer-a", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 90 }),
            attempt({ id: "peer-b", examId: "exam-1", studentId: "student-3", classId: "class-a", score: 90 }),
            attempt({ id: "peer-tied", examId: "exam-1", studentId: "student-4", classId: "class-a", score: 80 }),
            attempt({ id: "peer-c", examId: "exam-1", studentId: "student-5", classId: "class-a", score: 70 }),
        ]);

        expect(model.rows[0]).toMatchObject({ rank: 3, participantCount: 5 });
    });

    it("returns a null rank for a single participant", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
        ]);

        expect(model.rows[0]).toMatchObject({ rank: null, participantCount: 1 });
        expect(model.currentRank).toBeNull();
    });

    it("prefers profile ids, then student ids, then normalized names for identity", () => {
        const model = build([
            attempt({ id: "selected-profile", examId: "exam-1", studentProfileId: " profile-1 ", studentId: "legacy-id", studentName: "KIM", classId: "class-a", score: 80 }),
            attempt({ id: "different-profile", examId: "exam-1", studentProfileId: "profile-2", studentId: "profile-1", studentName: "KIM", classId: "class-a", score: 60 }),
        ], [], { selectedStudentId: "profile-1" });
        const nameFallback = build([
            attempt({ id: "selected-name", examId: "exam-2", studentName: "  KIM  ", classId: "class-a", score: 75 }),
        ], [], { selectedStudentId: "kim" });

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({ studentScore: 80, participantCount: 2 });
        expect(nameFallback.rows[0]?.studentScore).toBe(75);
    });

    it("deduplicates the same canonical id across profile and legacy student fields", () => {
        const model = build([
            attempt({ id: "selected-legacy", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T09:00:00.000Z", score: 40 }),
            attempt({ id: "selected-profile", examId: "exam-1", studentProfileId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 80 }),
            attempt({ id: "peer", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 60 }),
        ]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            studentScore: 80,
            classAverage: 70,
            participantCount: 2,
            rank: 1,
        });
    });

    it("does not merge a normalized-name fallback with an equal canonical id", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", studentName: "다른 이름", score: 80 }),
            attempt({ id: "name-peer", examId: "exam-1", studentName: " STUDENT-1 ", classId: "class-a", score: 60 }),
        ]);

        expect(model.rows[0]).toMatchObject({ participantCount: 2, classAverage: 70 });
    });

    it("uses the attempt title when exam metadata is missing", () => {
        const model = build([
            attempt({ id: "selected", examId: "missing-exam", examTitle: "현장 모의고사", studentId: "student-1", classId: "class-a", score: 80 }),
        ]);

        expect(model.rows[0]?.examTitle).toBe("현장 모의고사");
    });

    it.each(["partial", "stale"] as const)("propagates a %s data status", dataStatus => {
        expect(build([], [], { dataStatus }).status).toBe(dataStatus);
    });

    it("ignores selected and peer attempts with non-finite scores", () => {
        const model = build([
            attempt({ id: "selected-good", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "peer-invalid", examId: "exam-1", studentId: "student-2", classId: "class-a", score: Number.NaN }),
            attempt({ id: "selected-invalid", examId: "exam-2", studentId: "student-1", classId: "class-a", score: Number.POSITIVE_INFINITY }),
        ]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            examId: "exam-1",
            classAverage: 80,
            participantCount: 1,
            rank: null,
        });
    });

    it("rounds averageGap to one decimal and derives latest summary values", () => {
        const model = build([
            attempt({ id: "s1", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 81 }),
            attempt({ id: "p1", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 79 }),
            attempt({ id: "s2", examId: "exam-2", studentId: "student-1", classId: "class-a", finishedAt: "2026-02-01T10:00:00.000Z", score: 82 }),
            attempt({ id: "p2", examId: "exam-2", studentId: "student-2", classId: "class-a", score: 80 }),
            attempt({ id: "s3", examId: "exam-3", studentId: "student-1", classId: "class-a", finishedAt: "2026-03-01T10:00:00.000Z", score: 82 }),
            attempt({ id: "p3", examId: "exam-3", studentId: "student-2", classId: "class-a", score: 76 }),
        ]);

        expect(model).toMatchObject({
            latestScore: 82,
            averageGap: 1.7,
            currentRank: 1,
            rankDelta: 0,
            trend: "flat",
        });
    });

    it("computes rank improvement and score trend from the previous row", () => {
        const model = build([
            attempt({ id: "old-selected", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 70 }),
            attempt({ id: "old-peer", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 80 }),
            attempt({ id: "new-selected", examId: "exam-2", studentId: "student-1", classId: "class-a", finishedAt: "2026-02-01T10:00:00.000Z", score: 90 }),
            attempt({ id: "new-peer", examId: "exam-2", studentId: "student-2", classId: "class-a", score: 80 }),
        ]);

        expect(model).toMatchObject({
            latestScore: 90,
            currentRank: 1,
            rankDelta: 1,
            trend: "up",
        });
    });

    it("uses a one-point deadband for flat, up, and down trends", () => {
        const trendFor = (previous: number, latest: number) => build([
            attempt({ id: "old", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: previous }),
            attempt({ id: "new", examId: "exam-2", studentId: "student-1", classId: "class-a", finishedAt: "2026-02-01T10:00:00.000Z", score: latest }),
        ]).trend;

        expect(trendFor(80, 81)).toBe("flat");
        expect(trendFor(80, 82)).toBe("up");
        expect(trendFor(80, 78)).toBe("down");
        expect(build([]).trend).toBe("insufficient");
    });

    it("does not mutate caller-owned attempts or exams", () => {
        const attempts = [
            attempt({ id: "new", examId: "exam-2", studentId: "student-1", classId: "class-a", finishedAt: "2026-02-01T10:00:00.000Z", score: 90 }),
            attempt({ id: "old", examId: "exam-1", studentId: "student-1", classId: "class-a", finishedAt: "2026-01-01T10:00:00.000Z", score: 70 }),
        ];
        const exams = [exam("exam-2"), exam("exam-1")];
        const attemptsBefore = structuredClone(attempts);
        const examsBefore = structuredClone(exams);

        build(attempts, exams);

        expect(attempts).toEqual(attemptsBefore);
        expect(exams).toEqual(examsBefore);
    });
});
