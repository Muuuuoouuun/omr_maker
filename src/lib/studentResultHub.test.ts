import { describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import {
    buildStudentAttemptSeries,
    buildStudentRetakeScoreDelta,
    buildStudentResultHref,
    buildCumulativeExamMap,
    filterCumulativeAttemptsForStudent,
    matchRosterStudentForAttempt,
    markUnresolvedGrowthAttempt,
    parseStudentResultView,
    sameStudentAttempt,
} from "./studentResultHub";
import { buildStudentProfileInsight } from "./studentProfileAnalytics";
import { buildStudentReportHeadline } from "./studentReportHeadline";
import { buildStudentGrowthReport } from "./studentGrowthReport";

function student(partial: Partial<RosterStudent>): RosterStudent {
    return {
        id: "student-1",
        name: "김학생",
        email: "student@example.com",
        group: "A반",
        avatar: "#fff",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "2026-06-01T10:00:00.000Z",
        trend: "flat",
        status: "active",
        ...partial,
    };
}

function attempt(partial: Partial<Attempt>): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-01T09:00:00.000Z",
        finishedAt: "2026-06-01T10:00:00.000Z",
        score: 0,
        totalScore: 100,
        answers: {},
        status: "completed",
        ...partial,
    };
}

describe("student result hub", () => {
    it("exposes a strict roster matcher for cumulative student results", async () => {
        const hub = await import("./studentResultHub");
        expect(hub).toHaveProperty("matchRosterStudentForAttempt");
        expect(hub).toHaveProperty("filterCumulativeAttemptsForStudent");
    });

    it("prefers an exact stable roster id over duplicate name and group matches", () => {
        const duplicate = student({ id: "student-2" });
        const exact = student({ id: "profile-1" });

        expect(matchRosterStudentForAttempt(
            attempt({ studentProfileId: " profile-1 ", studentId: "legacy-id", groupName: "A반" }),
            [duplicate, exact],
        )).toBe(exact);
    });

    it("does not fall back to name and group when a stable attempt id has no roster match", () => {
        expect(matchRosterStudentForAttempt(
            attempt({ studentProfileId: "missing-profile", groupName: "A반" }),
            [student({ id: "student-2" })],
        )).toBeNull();
    });

    it("does not fall back to a legacy student id when an authoritative profile id is present", () => {
        expect(matchRosterStudentForAttempt(
            attempt({ studentProfileId: "missing-profile", studentId: "student-2", groupName: "A반" }),
            [student({ id: "student-2" })],
        )).toBeNull();
    });

    it("accepts only one legacy roster candidate and rejects ambiguous duplicates", () => {
        const first = student({ id: "student-1" });
        const duplicate = student({ id: "student-2" });
        const otherGroup = student({ id: "student-3", group: "B반" });
        const legacyAttempt = attempt({ groupName: "A반" });

        expect(matchRosterStudentForAttempt(legacyAttempt, [first, otherGroup])).toBe(first);
        expect(matchRosterStudentForAttempt(legacyAttempt, [first, duplicate])).toBeNull();
    });

    it("filters cumulative attempts through the selected attempt identity", () => {
        const selected = attempt({ id: "selected", studentProfileId: "student-1", groupName: "A반" });
        const same = attempt({ id: "same", studentId: "student-1", groupName: "A반" });
        const duplicateName = attempt({ id: "duplicate", studentId: "student-2", groupName: "A반" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [duplicateName, same, selected],
            [student({ id: "student-1" }), student({ id: "student-2" })],
        ))
            .toEqual([same, selected]);
    });

    it("uses only authoritative profile ids for cumulative stable matching", () => {
        const selected = attempt({
            id: "selected",
            studentProfileId: "student-a",
            studentId: "student-b",
            groupName: "A반",
        });
        const conflictingProfile = attempt({
            id: "conflicting-profile",
            studentProfileId: "student-b",
            groupName: "A반",
        });
        const roster = [student({ id: "student-a" }), student({ id: "student-b" })];

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [conflictingProfile, selected],
            roster,
            roster[0],
        )).toEqual([selected]);
    });

    it("rejects cumulative candidates from another organization before exact-id matching", () => {
        const selected = attempt({
            id: "shared-attempt",
            organizationId: "org-a",
            studentProfileId: "student-a",
            groupName: "A반",
        });
        const otherOrganization = attempt({
            id: "shared-attempt",
            organizationId: "org-b",
            studentProfileId: "student-a",
            groupName: "A반",
        });
        const rosterStudent = student({ id: "student-a" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [otherOrganization, selected],
            [rosterStudent],
            rosterStudent,
        )).toEqual([selected]);
    });

    it("uses an authoritative organization to scope a legacy selected student's cumulative evidence", () => {
        const selected = attempt({
            id: "selected",
            studentProfileId: "student-a",
            groupName: "A반",
        });
        const orgA = attempt({
            id: "org-a-history",
            organizationId: "org-a",
            studentProfileId: "student-a",
            groupName: "A반",
        });
        const orgB = attempt({
            id: "org-b-history",
            organizationId: "org-b",
            studentProfileId: "student-a",
            groupName: "A반",
        });
        const rosterStudent = student({ id: "student-a" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [orgB, selected, orgA],
            [rosterStudent],
            rosterStudent,
            "org-a",
        )).toEqual([selected, orgA]);
    });

    it("builds deterministic personal evidence from the active organization when ids collide", () => {
        const selectedStudent = student({ id: "student-a" });
        const selected = attempt({
            id: "selected",
            examId: "shared-exam",
            examTitle: "legacy title",
            studentProfileId: "student-a",
            groupName: "A반",
            startedAt: "2026-06-01T10:00:00.000Z",
            finishedAt: "2026-06-01T10:10:00.000Z",
            answers: { 1: 2 },
        });
        const orgAHistory = attempt({
            id: "org-a-history",
            examId: "shared-exam",
            examTitle: "A 조직 시험",
            organizationId: "org-a",
            studentProfileId: "student-a",
            groupName: "A반",
            startedAt: "2026-05-01T10:00:00.000Z",
            finishedAt: "2026-05-01T10:20:00.000Z",
            answers: { 1: 2 },
        });
        const orgBHistory = attempt({
            ...orgAHistory,
            id: "org-a-history",
            organizationId: "org-b",
            startedAt: "2026-05-01T09:00:00.000Z",
            finishedAt: "2026-05-01T10:00:00.000Z",
        });
        const orgAExam: Exam = {
            id: "shared-exam",
            title: "A 조직 시험",
            organizationId: "org-a",
            createdAt: "2026-05-01T00:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 1, score: 1, tags: { concept: "A 개념" } }],
        };
        const orgBExam: Exam = {
            ...orgAExam,
            title: "B 조직 시험",
            organizationId: "org-b",
            questions: [{ id: 1, number: 1, answer: 2, score: 1, tags: { concept: "B 개념" } }],
        };
        const personalAttempts = filterCumulativeAttemptsForStudent(
            selected,
            [orgBHistory, selected, orgAHistory],
            [selectedStudent],
            selectedStudent,
            "org-a",
        );
        const insight = buildStudentProfileInsight(
            selectedStudent,
            personalAttempts,
            buildCumulativeExamMap([orgBExam, orgAExam], "org-a"),
        );
        const headline = buildStudentReportHeadline(insight.headlineWeaknessGroups, "fallback");

        expect(insight.attempts.map(item => item.id)).toEqual(["selected", "org-a-history"]);
        expect(insight.attempts.map(item => item.examTitle)).not.toContain("B 조직 시험");
        expect(insight.averageElapsedTimeSec).toBe(900);
        expect(insight.headlineWeaknessGroups.map(group => group.title)).toContain("A 개념");
        expect(insight.headlineWeaknessGroups.map(group => group.title)).not.toContain("B 개념");
        expect(headline.headline).toContain("A 개념");
    });

    it("excludes an ambiguous id-less legacy attempt for duplicate roster students", () => {
        const selected = attempt({ id: "selected", studentProfileId: "student-a", groupName: "A반" });
        const exactA = attempt({ id: "exact-a", studentId: "student-a", groupName: "A반" });
        const exactB = attempt({ id: "exact-b", studentProfileId: "student-b", groupName: "A반" });
        const ambiguousLegacy = attempt({ id: "legacy", groupName: "A반" });
        const roster = [student({ id: "student-a" }), student({ id: "student-b" })];

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [exactB, ambiguousLegacy, exactA, selected],
            roster,
            roster[0],
        )).toEqual([exactA, selected]);
    });

    it("prefers the canonical exam revision before recency regardless of input order", () => {
        const canonical: Exam = {
            id: "exam-collision",
            title: "충돌 시험",
            organizationId: "org-a",
            revision: 8,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 2, score: 1 }],
        };
        const newerButStale: Exam = {
            ...canonical,
            revision: 7,
            updatedAt: "2026-08-01T00:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 1, score: 1 }],
        };

        expect(buildCumulativeExamMap([newerButStale, canonical], "org-a").get(canonical.id)).toBe(canonical);
        expect(buildCumulativeExamMap([canonical, newerButStale], "org-a").get(canonical.id)).toBe(canonical);
    });

    it("uses a stable semantic tie-break for same-scope exam collisions", () => {
        const first: Exam = {
            id: "exam-semantic-tie",
            title: "동일 시험",
            organizationId: "org-a",
            revision: 3,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 1, score: 1 }],
        };
        const second: Exam = {
            ...first,
            questions: [{ id: 1, number: 1, answer: 2, score: 1 }],
        };

        const forward = buildCumulativeExamMap([first, second], "org-a").get(first.id);
        const reverse = buildCumulativeExamMap([second, first], "org-a").get(first.id);
        expect(forward).toEqual(reverse);
    });

    it("keeps a compatible id-less legacy attempt when the roster match is unique", () => {
        const selected = attempt({ id: "selected", studentProfileId: "student-a", groupName: "A반" });
        const legacy = attempt({ id: "legacy", groupName: "A반" });
        const onlyStudent = student({ id: "student-a" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [legacy, selected],
            [onlyStudent],
            onlyStudent,
        )).toEqual([legacy, selected]);
    });

    it("does not attach an id-less legacy attempt when the selected stable id has no roster record", () => {
        const selected = attempt({ id: "selected", studentProfileId: "missing-student", groupName: "A반" });
        const legacy = attempt({ id: "legacy", groupName: "A반" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [legacy, selected],
            [student({ id: "other-student" })],
            null,
        )).toEqual([selected]);
    });

    it("does not trust a supplied roster student when the selected attempt cannot uniquely resolve", () => {
        const selected = attempt({ id: "selected", studentProfileId: "missing-student", groupName: "A반" });
        const legacy = attempt({ id: "legacy", groupName: "A반" });
        const unrelated = student({ id: "other-student" });

        expect(filterCumulativeAttemptsForStudent(
            selected,
            [legacy, selected],
            [unrelated],
            unrelated,
        )).toEqual([selected]);
    });

    it("preserves an unresolved in-scope row as omitted evidence without merging its ambiguous name", () => {
        const selected = attempt({
            id: "selected",
            examId: "exam-1",
            studentProfileId: "student-a",
            classId: "class-a",
            score: 80,
        });
        const unresolved = markUnresolvedGrowthAttempt(attempt({
            id: "ambiguous",
            examId: "exam-1",
            studentName: "김학생",
            classId: "class-a",
            score: 60,
        }));
        const model = buildStudentGrowthReport({
            selectedStudentId: "student-a",
            selectedAttemptId: selected.id,
            selectedClassKey: "class-a",
            dataStatus: "ready",
            attempts: [selected, unresolved],
            exams: [{ id: "exam-1", title: "시험", createdAt: "2026-01-01T00:00:00.000Z", questions: [] }],
        });

        expect(unresolved).toMatchObject({ studentName: "", studentProfileId: undefined, studentId: undefined });
        expect(model.rows[0]).toMatchObject({ participantCount: 1, studentScore: 80 });
        expect(model.omittedCount).toBe(1);
    });

    it("defaults missing or invalid views to answers while retaining handwriting", () => {
        expect(parseStudentResultView()).toBe("answers");
        expect(parseStudentResultView("unexpected")).toBe("answers");
        expect(parseStudentResultView("handwriting")).toBe("handwriting");
        expect(parseStudentResultView("report")).toBe("report");
        expect(parseStudentResultView("analytics")).toBe("analytics");
    });

    it("builds canonical result links with encoded attempt ids", () => {
        expect(buildStudentResultHref("attempt/a", "analytics")).toBe("/teacher/attempt/attempt%2Fa?view=analytics");
    });

    it("matches stable student identifiers across profile and legacy id fields", () => {
        expect(sameStudentAttempt(
            attempt({ studentProfileId: " profile-1 " }),
            attempt({ id: "attempt-2", studentId: "profile-1" }),
        )).toBe(true);
    });

    it("does not let a legacy id override a conflicting authoritative profile id", () => {
        expect(sameStudentAttempt(
            attempt({ studentProfileId: "profile-a", studentId: "profile-b", groupId: "group-1" }),
            attempt({ id: "attempt-2", studentProfileId: "profile-b", groupId: "group-1" }),
        )).toBe(false);
    });

    it("rejects organization conflicts before matching attempt or student ids", () => {
        const scoped = attempt({
            id: "shared-attempt",
            organizationId: "org-a",
            studentProfileId: "profile-1",
        });

        expect(sameStudentAttempt(scoped, attempt({
            id: "shared-attempt",
            organizationId: "org-b",
            studentProfileId: "profile-1",
        }))).toBe(false);
        expect(sameStudentAttempt(scoped, attempt({
            id: "other-attempt",
            studentProfileId: "profile-1",
        }))).toBe(true);
    });

    it("does not bridge one stable attempt to an id-less legacy attempt", () => {
        expect(sameStudentAttempt(
            attempt({ studentProfileId: "profile-1", groupName: "A반" }),
            attempt({ id: "legacy", groupName: "A반" }),
        )).toBe(false);
    });

    it("falls back to matching guest ids without joining different guests", () => {
        expect(sameStudentAttempt(
            attempt({ guestId: "guest-1" }),
            attempt({ id: "same-guest", guestId: "guest-1" }),
        )).toBe(true);
        expect(sameStudentAttempt(
            attempt({ guestId: "guest-1" }),
            attempt({ id: "other-guest", guestId: "guest-2" }),
        )).toBe(false);
    });

    it("does not fall back when conflicting stable ids are present", () => {
        expect(sameStudentAttempt(
            attempt({ studentId: "student-1", guestId: "guest-1", groupId: "group-1" }),
            attempt({ id: "other-student", studentProfileId: "student-2", guestId: "guest-1", groupId: "group-1" }),
        )).toBe(false);
    });

    it("does not fall back to name and group when guest ids differ", () => {
        expect(sameStudentAttempt(
            attempt({ guestId: "guest-1", groupId: "group-1" }),
            attempt({ id: "other-guest", guestId: "guest-2", groupId: "group-1" }),
        )).toBe(false);
    });

    it("only uses the legacy name fallback within the same non-empty group", () => {
        const grouped = attempt({ studentName: " 김학생 ", groupId: "group-1" });
        expect(sameStudentAttempt(grouped, attempt({ id: "same-group", studentName: "김학생", groupName: "group-1" }))).toBe(true);
        expect(sameStudentAttempt(grouped, attempt({ id: "other-group", studentName: "김학생", groupId: "group-2" }))).toBe(false);
        expect(sameStudentAttempt(
            attempt({ studentName: "김학생" }),
            attempt({ id: "bare-name", studentName: "김학생" }),
        )).toBe(false);
    });

    it("builds an ordered same-student series with retake score deltas", () => {
        const original = attempt({ id: "original", studentId: "student-1", score: 60, finishedAt: "2026-06-01T10:00:00.000Z" });
        const retake = attempt({
            id: "retake",
            studentProfileId: "student-1",
            score: 80,
            finishedAt: "2026-06-03T10:00:00.000Z",
            retake: { sourceAttemptId: "original", questionIds: [1, 2], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });
        const otherExam = attempt({ id: "other-exam", examId: "exam-2", studentId: "student-1" });
        const otherStudent = attempt({ id: "other-student", studentId: "student-2" });

        expect(buildStudentAttemptSeries(retake, [retake, otherExam, original, otherStudent])).toEqual([
            expect.objectContaining({ attempt: original, kind: "original", ordinal: 1, scorePercent: 60, scoreDelta: null }),
            expect.objectContaining({ attempt: retake, kind: "retake", ordinal: 1, scorePercent: 80, scoreDelta: 20 }),
        ]);
    });

    it("keeps same-exam and same-student attempts inside their organization", () => {
        const selected = attempt({
            id: "selected",
            organizationId: "org-a",
            studentProfileId: "student-1",
        });
        const otherOrganization = attempt({
            id: "selected",
            organizationId: "org-b",
            studentProfileId: "student-1",
        });

        expect(buildStudentAttemptSeries(selected, [otherOrganization, selected])
            .map(item => item.attempt.organizationId))
            .toEqual(["org-a"]);
    });

    it("includes a legacy attempt itself even without an identity fallback", () => {
        const legacy = attempt({ id: "legacy", studentName: "김학생" });
        const unrelated = attempt({ id: "same-name", studentName: "김학생" });

        expect(buildStudentAttemptSeries(legacy, [unrelated, legacy]).map(item => item.attempt.id)).toEqual(["legacy"]);
    });

    it("orders attempts chronologically within original and retake groups", () => {
        const laterOriginal = attempt({ id: "original-later", studentId: "student-1", finishedAt: "2026-06-03T10:00:00.000Z" });
        const earlierOriginal = attempt({ id: "original-earlier", studentId: "student-1", finishedAt: "2026-06-01T10:00:00.000Z" });
        const laterRetake = attempt({
            id: "retake-later",
            studentId: "student-1",
            finishedAt: "2026-06-05T10:00:00.000Z",
            retake: { sourceAttemptId: "original-later", questionIds: [], mode: "wrong", createdAt: "2026-06-04T10:00:00.000Z" },
        });
        const earlierRetake = attempt({
            id: "retake-earlier",
            studentId: "student-1",
            finishedAt: "2026-06-04T10:00:00.000Z",
            retake: { sourceAttemptId: "original-earlier", questionIds: [], mode: "wrong", createdAt: "2026-06-03T10:00:00.000Z" },
        });

        expect(buildStudentAttemptSeries(laterOriginal, [laterRetake, laterOriginal, earlierRetake, earlierOriginal])
            .map(item => [item.attempt.id, item.ordinal]))
            .toEqual([
                ["original-earlier", 1],
                ["original-later", 2],
                ["retake-earlier", 1],
                ["retake-later", 2],
            ]);
    });

    it("uses safe score percentages and a null delta when a retake source is missing", () => {
        const original = attempt({ id: "original", studentId: "student-1", score: 3, totalScore: 6 });
        const orphanRetake = attempt({
            id: "orphan-retake",
            studentId: "student-1",
            score: 5,
            totalScore: 8,
            retake: { sourceAttemptId: "missing", questionIds: [], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });

        expect(buildStudentAttemptSeries(original, [orphanRetake, original])).toEqual([
            expect.objectContaining({ attempt: original, scorePercent: 50, scoreDelta: null }),
            expect.objectContaining({ attempt: orphanRetake, scorePercent: 63, scoreDelta: null }),
        ]);
    });

    it("does not publish percentages or retake deltas for completely ungraded attempts", () => {
        const original = attempt({ id: "original-ungraded", studentId: "student-1", score: 0, totalScore: 0 });
        const retake = attempt({
            id: "retake-ungraded",
            studentId: "student-1",
            score: 0,
            totalScore: 0,
            retake: { sourceAttemptId: original.id, questionIds: [], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });

        expect(buildStudentAttemptSeries(retake, [original, retake])).toEqual([
            expect.objectContaining({ attempt: original, scorePercent: null, scoreDelta: null }),
            expect.objectContaining({ attempt: retake, scorePercent: null, scoreDelta: null }),
        ]);
    });

    it("refuses an attempt-page retake comparison unless both scores are gradable", () => {
        expect(buildStudentRetakeScoreDelta(
            { totalScore: 100, scorePercent: 80 },
            { totalScore: 0, scorePercent: 0 },
        )).toBeNull();
        expect(buildStudentRetakeScoreDelta(
            { totalScore: 100, scorePercent: 80 },
            { totalScore: 100, scorePercent: 60 },
        )).toEqual({ sourceScorePercent: 60, currentScorePercent: 80, delta: 20 });
    });

    it("rounds fractional source deltas to one decimal place", async () => {
        vi.resetModules();
        vi.doMock("@/lib/scoreUtils", () => ({
            safeScorePercent: (score: number) => score,
            hasGradableAttemptScore: ({ totalScore, scorePercent }: { totalScore: number; scorePercent: number }) => (
                totalScore > 0 && Number.isFinite(scorePercent)
            ),
        }));

        const original = attempt({ id: "original", studentId: "student-1", score: 60.01, totalScore: 10 });
        const retake = attempt({
            id: "retake",
            studentId: "student-1",
            score: 80.06,
            totalScore: 10,
            retake: { sourceAttemptId: "original", questionIds: [], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });
        try {
            const { buildStudentAttemptSeries: buildSeriesWithFractionalScores } = await import("./studentResultHub");
            const [, result] = buildSeriesWithFractionalScores(original, [original, retake]);
            expect(result.scoreDelta).toBe(20.1);
        } finally {
            vi.doUnmock("@/lib/scoreUtils");
            vi.resetModules();
        }
    });
});
