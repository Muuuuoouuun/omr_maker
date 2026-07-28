import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    answerStudentQuestion,
    answeredQuestionKeys,
    answeredStudentQuestions,
    collectStudentQuestionInbox,
    newlyAnsweredKeys,
    pendingStudentQuestions,
    validateStudentQuestionForAttempt,
    studentQuestionsByQuestionId,
    upsertStudentQuestion,
    STUDENT_QUESTION_MAX_COUNT,
    STUDENT_QUESTION_MAX_LENGTH,
} from "./studentQuestions";

function attempt(partial: Partial<Attempt> = {}): Attempt {
    return {
        id: "a1",
        examId: "e1",
        examTitle: "시험",
        studentName: "학생",
        startedAt: "2026-07-01T01:00:00.000Z",
        finishedAt: "2026-07-01T02:00:00.000Z",
        score: 0,
        totalScore: 10,
        answers: {},
        status: "completed",
        ...partial,
    };
}

const NOW = "2026-07-02T09:00:00.000Z";

describe("studentQuestions", () => {
    it("adds a trimmed, capped question note with queued status", () => {
        const long = "질".repeat(STUDENT_QUESTION_MAX_LENGTH + 50);
        const updated = upsertStudentQuestion(attempt(), { questionId: 3, questionNumber: 3, body: `  ${long}  ` }, NOW);
        expect(updated?.studentQuestions).toHaveLength(1);
        expect(updated?.studentQuestions?.[0]).toMatchObject({
            questionId: 3,
            questionNumber: 3,
            status: "queued",
            createdAt: NOW,
        });
        expect(updated?.studentQuestions?.[0].body).toHaveLength(STUDENT_QUESTION_MAX_LENGTH);
    });

    it("rejects empty bodies", () => {
        expect(upsertStudentQuestion(attempt(), { questionId: 1, questionNumber: 1, body: "   " }, NOW)).toBeNull();
    });

    it("validates the question id against canonical results and derives its number", () => {
        const ownedAttempt = attempt({
            questionResults: [
                { questionId: 7, questionNumber: 3 } as NonNullable<Attempt["questionResults"]>[number],
            ],
        });

        expect(validateStudentQuestionForAttempt(ownedAttempt, {
            questionId: 7,
            questionNumber: 999,
            body: "  왜 이 답인가요?  ",
        })).toEqual({
            questionId: 7,
            questionNumber: 3,
            body: "왜 이 답인가요?",
        });
        expect(validateStudentQuestionForAttempt(ownedAttempt, {
            questionId: 8,
            questionNumber: 8,
            body: "임의 문항",
        })).toBeNull();
    });

    it("rejects oversized text and a new question beyond the per-attempt cap", () => {
        const results = Array.from({ length: STUDENT_QUESTION_MAX_COUNT + 1 }, (_, index) => ({
            questionId: index + 1,
            questionNumber: index + 1,
        })) as NonNullable<Attempt["questionResults"]>;
        const notes = Array.from({ length: STUDENT_QUESTION_MAX_COUNT }, (_, index) => ({
            questionId: index + 1,
            questionNumber: index + 1,
            body: "질문",
            createdAt: NOW,
            status: "queued" as const,
        }));
        const ownedAttempt = attempt({ questionResults: results, studentQuestions: notes });

        expect(validateStudentQuestionForAttempt(ownedAttempt, {
            questionId: 1,
            questionNumber: 1,
            body: "질".repeat(STUDENT_QUESTION_MAX_LENGTH + 1),
        })).toBeNull();
        expect(validateStudentQuestionForAttempt(ownedAttempt, {
            questionId: STUDENT_QUESTION_MAX_COUNT + 1,
            questionNumber: 1,
            body: "새 질문",
        })).toBeNull();
        expect(validateStudentQuestionForAttempt(ownedAttempt, {
            questionId: 1,
            questionNumber: 999,
            body: "기존 질문 수정",
        })).toMatchObject({ questionId: 1, questionNumber: 1 });
    });

    it("re-asking replaces the note and clears the previous answer", () => {
        let a = upsertStudentQuestion(attempt(), { questionId: 1, questionNumber: 1, body: "왜 3번인가요?" }, NOW)!;
        a = answerStudentQuestion(a, 1, "분모가 0이 되면 안 되기 때문이에요.", NOW, "김선생")!;
        expect(a.studentQuestions?.[0].status).toBe("answered");

        const reAsked = upsertStudentQuestion(a, { questionId: 1, questionNumber: 1, body: "그럼 2번은 왜 안 되나요?" }, NOW)!;
        expect(reAsked.studentQuestions).toHaveLength(1);
        expect(reAsked.studentQuestions?.[0]).toMatchObject({ status: "queued", body: "그럼 2번은 왜 안 되나요?" });
        expect(reAsked.studentQuestions?.[0].answer).toBeUndefined();
    });

    it("keeps notes sorted by question number", () => {
        let a = upsertStudentQuestion(attempt(), { questionId: 5, questionNumber: 5, body: "5번 질문" }, NOW)!;
        a = upsertStudentQuestion(a, { questionId: 2, questionNumber: 2, body: "2번 질문" }, NOW)!;
        expect(a.studentQuestions?.map(n => n.questionNumber)).toEqual([2, 5]);
    });

    it("answers an existing question and counts pending/answered correctly", () => {
        let a = upsertStudentQuestion(attempt(), { questionId: 1, questionNumber: 1, body: "질문 1" }, NOW)!;
        a = upsertStudentQuestion(a, { questionId: 2, questionNumber: 2, body: "질문 2" }, NOW)!;
        a = answerStudentQuestion(a, 2, "이렇게 풀어요", NOW, "김선생")!;

        expect(pendingStudentQuestions(a).map(n => n.questionId)).toEqual([1]);
        expect(answeredStudentQuestions(a).map(n => n.questionId)).toEqual([2]);
        expect(a.studentQuestions?.find(n => n.questionId === 2)?.answer).toMatchObject({
            body: "이렇게 풀어요",
            teacherName: "김선생",
        });
        expect(studentQuestionsByQuestionId(a)[1]).toMatchObject({ body: "질문 1" });
    });

    it("cannot answer a question that was never asked", () => {
        expect(answerStudentQuestion(attempt(), 9, "답", NOW)).toBeNull();
    });

    it("collects a teacher inbox across attempts — pending oldest-first, answered latest-first", () => {
        let a1 = attempt({ id: "a1", examTitle: "중간고사", studentName: "김학생" });
        a1 = upsertStudentQuestion(a1, { questionId: 1, questionNumber: 1, body: "늦게 온 질문" }, "2026-07-02T10:00:00.000Z")!;
        let a2 = attempt({ id: "a2", examTitle: "기말고사", studentName: "이학생" });
        a2 = upsertStudentQuestion(a2, { questionId: 3, questionNumber: 3, body: "먼저 온 질문" }, "2026-07-01T09:00:00.000Z")!;
        a2 = upsertStudentQuestion(a2, { questionId: 4, questionNumber: 4, body: "답변된 질문" }, "2026-07-01T09:30:00.000Z")!;
        a2 = answerStudentQuestion(a2, 4, "이렇게 풀어요", "2026-07-02T08:00:00.000Z", "박선생")!;

        const inbox = collectStudentQuestionInbox([a1, a2]);

        expect(inbox.pending.map(entry => entry.note.body)).toEqual(["먼저 온 질문", "늦게 온 질문"]);
        expect(inbox.pending[0]).toMatchObject({ attemptId: "a2", examTitle: "기말고사", studentName: "이학생" });
        expect(inbox.answered).toHaveLength(1);
        expect(inbox.answered[0].note.answer?.teacherName).toBe("박선생");
    });

    it("returns empty inbox lists when no attempts carry questions", () => {
        expect(collectStudentQuestionInbox([attempt()])).toEqual({ pending: [], answered: [] });
    });

    it("keys only answered questions and re-keys on a fresh answer timestamp", () => {
        let a = attempt({ id: "a1" });
        a = upsertStudentQuestion(a, { questionId: 1, questionNumber: 1, body: "q1" }, "2026-07-01T09:00:00.000Z")!;
        a = upsertStudentQuestion(a, { questionId: 2, questionNumber: 2, body: "q2" }, "2026-07-01T09:10:00.000Z")!;
        a = answerStudentQuestion(a, 1, "answer", "2026-07-02T08:00:00.000Z", "선생")!;

        // Only the answered question (q1) is keyed; the still-queued q2 is not.
        expect(answeredQuestionKeys([a])).toEqual(["a1:1:2026-07-02T08:00:00.000Z"]);

        // Re-answering the same question with a newer timestamp yields a new key.
        const reAnswered = answerStudentQuestion(a, 1, "정정", "2026-07-03T08:00:00.000Z", "선생")!;
        expect(answeredQuestionKeys([reAnswered])).toEqual(["a1:1:2026-07-03T08:00:00.000Z"]);
    });

    it("diffs answer keys against the seen set", () => {
        const seen = ["a1:1:t0"];
        expect(newlyAnsweredKeys(["a1:1:t0", "a1:2:t1"], seen)).toEqual(["a1:2:t1"]);
        expect(newlyAnsweredKeys(["a1:1:t0"], seen)).toEqual([]);
        expect(newlyAnsweredKeys([], seen)).toEqual([]);
    });
});
