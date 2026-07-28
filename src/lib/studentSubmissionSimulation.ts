import { buildServerAttempt, ownerStudentId, type SubmitAttemptInput } from "@/lib/studentExamCore";
import { resolveStudentSessionSecret, type StudentServerIdentity } from "@/lib/studentServerSession";
import { attemptIdForStudentSubmission } from "@/lib/studentSubmissionId";
import type { Attempt, Exam } from "@/types/omr";

type Env = Record<string, string | undefined>;

export type StudentSubmissionSimulationResult =
    | { status: "disabled" }
    | { status: "invalid" }
    | { status: "ok"; attempt: Attempt };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function enabled(value: unknown): boolean {
    return value === "1" || value === "true";
}

function trustedExam(env: Env): Exam | null {
    const examId = clean(env.OMR_E2E_STUDENT_SUBMISSION_EXAM_ID);
    const title = clean(env.OMR_E2E_STUDENT_SUBMISSION_EXAM_TITLE);
    const answers = clean(env.OMR_E2E_STUDENT_SUBMISSION_ANSWER_KEY)
        .split(",")
        .map(value => Number(value.trim()));
    if (!examId || !title || answers.length === 0 || answers.some(answer => !Number.isInteger(answer) || answer < 1 || answer > 5)) {
        return null;
    }
    return {
        id: examId,
        title,
        createdAt: "2026-07-28T00:00:00.000Z",
        questions: answers.map((answer, index) => ({
            id: index + 1,
            number: index + 1,
            answer,
            choices: 5,
            score: 10,
        })),
    };
}

function inputMatchesTrustedExam(input: SubmitAttemptInput, exam: Exam): boolean {
    if (input.examId !== exam.id || !Number.isFinite(Date.parse(input.startedAt))) return false;
    const allowed = new Map(exam.questions.map(question => [question.id, question.choices || 5]));
    return Object.entries(input.answers).every(([rawQuestionId, answer]) => {
        const questionId = Number(rawQuestionId);
        const choices = allowed.get(questionId);
        return Number.isInteger(questionId)
            && choices !== undefined
            && Number.isInteger(answer)
            && answer >= 1
            && answer <= choices;
    });
}

export function createStudentSubmissionSimulator(): (
    input: SubmitAttemptInput,
    identity: StudentServerIdentity,
    env?: Env,
    now?: number,
) => StudentSubmissionSimulationResult {
    const attempts = new Map<string, Attempt>();
    return (
        input,
        identity,
        env = process.env,
        now = Date.now(),
    ): StudentSubmissionSimulationResult => {
        if (env.NODE_ENV === "production" || !enabled(env.OMR_E2E_STUDENT_SUBMISSION_SIMULATION)) {
            return { status: "disabled" };
        }
        const exam = trustedExam(env);
        const secret = resolveStudentSessionSecret(env);
        if (!exam || !secret || !inputMatchesTrustedExam(input, exam)) return { status: "invalid" };
        const attemptId = attemptIdForStudentSubmission({
            submissionId: input.submissionId,
            examId: input.examId,
            ownerStudentId: ownerStudentId(identity),
            secret,
        });
        if (!attemptId) return { status: "invalid" };
        const existing = attempts.get(attemptId);
        if (existing) return { status: "ok", attempt: existing };
        const attempt = buildServerAttempt(
            input,
            exam,
            identity,
            attemptId,
            new Date(now).toISOString(),
        );
        attempts.set(attemptId, attempt);
        return { status: "ok", attempt };
    };
}
