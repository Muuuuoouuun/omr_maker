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
        organizationId: partial.organizationId,
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
    exams: Exam[] = Array.from(new Set(attempts.map(item => item.examId))).map(id => exam(id)),
    overrides: Partial<{
        selectedStudentId: string;
        selectedAttemptId: string;
        selectedClassKey: string;
        selectedOrganizationId: string;
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
            currentPercentile: null,
            rankDelta: null,
            trend: "insufficient",
            omittedCount: 0,
            selectedAttemptIncluded: false,
        });
    });

    it("uses the authoritative organization scope for a legacy selected attempt", () => {
        const orgAExam = { ...exam("exam-1", "A 조직 시험"), organizationId: "org-a" };
        const orgBExam = { ...exam("exam-1", "B 조직 시험"), organizationId: "org-b" };
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "org-a-peer", examId: "exam-1", organizationId: "org-a", studentId: "student-2", classId: "class-a", score: 60 }),
            attempt({ id: "org-b-peer", examId: "exam-1", organizationId: "org-b", studentId: "student-3", classId: "class-a", score: 100 }),
        ], [orgAExam, orgBExam], {
            selectedAttemptId: "selected",
            selectedOrganizationId: "org-a",
        });

        expect(model.rows[0]).toMatchObject({
            examTitle: "A 조직 시험",
            classAverage: 70,
            participantCount: 2,
            rank: 1,
        });
        expect(model.selectedAttemptIncluded).toBe(true);
    });

    it("isolates an explicit organization while retaining unscoped legacy attempts during migration", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", organizationId: "org-a", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "same-org", examId: "exam-1", organizationId: "org-a", studentId: "student-2", classId: "class-a", score: 60 }),
            attempt({ id: "legacy", examId: "exam-1", studentId: "student-3", classId: "class-a", score: 70 }),
            attempt({ id: "other-org", examId: "exam-1", organizationId: "org-b", studentId: "student-4", classId: "class-a", score: 100 }),
        ], [exam("exam-1")], { selectedOrganizationId: "org-a" });

        expect(model.rows[0]).toMatchObject({
            classAverage: 70,
            participantCount: 3,
            rank: 1,
        });
    });

    it("does not pull explicitly scoped attempts into an unscoped legacy report", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "legacy-peer", examId: "exam-1", studentId: "student-2", classId: "class-a", score: 60 }),
            attempt({ id: "scoped-peer", examId: "exam-1", organizationId: "org-b", studentId: "student-3", classId: "class-a", score: 100 }),
        ]);

        expect(model.rows[0]).toMatchObject({ classAverage: 70, participantCount: 2, rank: 1 });
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
        expect(build([selected, peer], undefined, { selectedClassKey }).rows[0]).toMatchObject({
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
        expect(model.currentPercentile).toBe(60);
    });

    it("returns a null rank for a single participant", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
        ]);

        expect(model.rows[0]).toMatchObject({ rank: null, participantCount: 1 });
        expect(model.currentRank).toBeNull();
        expect(model.currentPercentile).toBeNull();
    });

    it("prefers profile ids, then student ids, then normalized names for identity", () => {
        const model = build([
            attempt({ id: "selected-profile", examId: "exam-1", studentProfileId: " profile-1 ", studentId: "legacy-id", studentName: "KIM", classId: "class-a", score: 80 }),
            attempt({ id: "different-profile", examId: "exam-1", studentProfileId: "profile-2", studentId: "profile-1", studentName: "KIM", classId: "class-a", score: 60 }),
        ], undefined, { selectedStudentId: "profile-1" });
        const nameFallback = build([
            attempt({ id: "selected-name", examId: "exam-2", studentName: "  KIM  ", classId: "class-a", score: 75 }),
        ], undefined, { selectedStudentId: "kim" });

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

    it("omits otherwise eligible attempts with missing exam metadata or student identity", () => {
        const model = build([
            attempt({ id: "selected", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "missing-exam", examId: "exam-2", studentId: "student-1", classId: "class-a", score: 90 }),
            attempt({ id: "missing-identity", examId: "exam-1", studentName: "   ", classId: "class-a", score: 60 }),
        ], [exam("exam-1", "확인된 시험")]);

        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({ examTitle: "확인된 시험", participantCount: 1 });
        expect(model.omittedCount).toBe(2);
    });

    it("distinguishes a missing selected attempt from unrelated omitted cohort rows", () => {
        const model = build([
            attempt({ id: "selected-history", examId: "exam-1", studentId: "student-1", classId: "class-a", score: 80 }),
            attempt({ id: "missing-identity", examId: "exam-1", studentName: "   ", classId: "class-a", score: 60 }),
        ], [exam("exam-1")], {
            dataStatus: "partial",
            selectedAttemptId: "selected-current",
        });

        expect(model.rows).toHaveLength(1);
        expect(model.omittedCount).toBe(1);
        expect(model.selectedAttemptIncluded).toBe(false);
    });

    it("retains selected-attempt evidence when that included row is omitted from metrics", () => {
        const model = build([
            attempt({ id: "selected-current", examId: "missing-exam", studentId: "student-1", classId: "class-a", score: 80 }),
        ], [], {
            dataStatus: "partial",
            selectedAttemptId: "selected-current",
        });

        expect(model.rows).toHaveLength(0);
        expect(model.omittedCount).toBe(1);
        expect(model.selectedAttemptIncluded).toBe(true);
    });

    it("prefers organization-matching exam metadata when exam ids collide", () => {
        const orgAExam = { ...exam("exam-1", "A 조직 시험"), organizationId: "org-a" };
        const orgBExam = { ...exam("exam-1", "B 조직 시험"), organizationId: "org-b" };
        const model = build([
            attempt({ id: "selected", examId: "exam-1", organizationId: "org-a", studentId: "student-1", classId: "class-a", score: 80 }),
        ], [orgAExam, orgBExam], { selectedOrganizationId: "org-a" });

        expect(model.rows[0]?.examTitle).toBe("A 조직 시험");
        expect(model.omittedCount).toBe(0);
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

    it("averages only the latest six chronological rows with a class comparison", () => {
        const attempts = Array.from({ length: 8 }, (_, index) => {
            const examId = `exam-${index + 1}`;
            const month = String(index + 1).padStart(2, "0");
            const selectedScore = index < 2 ? 60 : 80;
            const peerScore = index < 2 ? 80 : 60;
            const rows = [attempt({
                id: `selected-${index + 1}`,
                examId,
                studentId: "student-1",
                classId: "class-a",
                finishedAt: `2026-${month}-01T10:00:00.000Z`,
                score: selectedScore,
            })];
            if (index !== 6) {
                rows.push(attempt({
                    id: `peer-${index + 1}`,
                    examId,
                    studentId: "student-2",
                    classId: "class-a",
                    finishedAt: `2026-${month}-01T10:00:00.000Z`,
                    score: peerScore,
                }));
            }
            return rows;
        }).flat();

        const model = build(attempts);

        expect(model.rows).toHaveLength(8);
        expect(model.averageGap).toBe(6.7);
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
