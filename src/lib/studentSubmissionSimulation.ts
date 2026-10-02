import {
    attemptOwnedBy,
    ownerStudentId,
    type SubmitAttemptInput,
} from "@/lib/studentExamCore";
import { buildServerAttempt } from "@/lib/studentExamServerGrading";
import { resolveStudentSessionSecret, type StudentServerIdentity } from "@/lib/studentServerSession";
import { attemptIdForStudentSubmission } from "@/lib/studentSubmissionId";
import {
    upsertStudentQuestion,
    validateStudentQuestionForAttempt,
    type StudentQuestionInput,
} from "@/lib/studentQuestions";
import type { Attempt, Exam } from "@/types/omr";

type Env = Record<string, string | undefined>;

export type StudentSubmissionSimulationResult =
    | { status: "disabled" }
    | { status: "invalid" }
    | { status: "ok"; attempt: Attempt };

export interface StudentSubmissionSimulator {
    (
        input: SubmitAttemptInput,
        identity: StudentServerIdentity,
        env?: Env,
        now?: number,
    ): StudentSubmissionSimulationResult;
    askQuestion(
        attemptId: string,
        question: StudentQuestionInput,
        identity: StudentServerIdentity,
        env?: Env,
        now?: number,
    ):
        | { status: "disabled" | "invalid" | "not_found" | "denied" }
        | { status: "ok"; attempt: Attempt };
    reset(): void;
    size(): number;
}

export interface StudentSubmissionSimulatorOptions {
    ttlMs?: number;
    maxEntries?: number;
    maxTombstones?: number;
}

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

function submissionFingerprint(input: SubmitAttemptInput): string {
    return JSON.stringify({
        ...input,
        answers: Object.fromEntries(
            Object.entries(input.answers).sort(([left], [right]) => Number(left) - Number(right)),
        ),
    });
}

function deterministicFinishedAt(input: SubmitAttemptInput, attemptId: string): string {
    const startedAt = Date.parse(input.startedAt);
    const entropy = Number.parseInt(attemptId.replace(/-/g, "").slice(0, 8), 16);
    const elapsedSeconds = (Number.isFinite(entropy) ? entropy % 3_600 : 0) + 1;
    return new Date(startedAt + elapsedSeconds * 1_000).toISOString();
}

export function createStudentSubmissionSimulator(
    options: StudentSubmissionSimulatorOptions = {},
): StudentSubmissionSimulator {
    const ttlMs = Math.max(1, options.ttlMs ?? 30 * 60 * 1_000);
    const maxEntries = Math.max(1, options.maxEntries ?? 256);
    const maxTombstones = Math.max(1, options.maxTombstones ?? 4_096);
    const attempts = new Map<string, {
        attempt: Attempt;
        lastAccessedAt: number;
    }>();
    // These fingerprints are security tombstones, not cache entries. They must
    // survive attempt TTL/LRU removal so an id can never accept a new payload
    // until the simulator is explicitly reset.
    const fingerprints = new Map<string, string>();
    const simulate = ((
        input: SubmitAttemptInput,
        identity: StudentServerIdentity,
        env: Env = process.env,
        now: number = Date.now(),
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
        for (const [id, entry] of attempts) {
            if (now - entry.lastAccessedAt > ttlMs) attempts.delete(id);
        }
        const fingerprint = submissionFingerprint(input);
        const existingFingerprint = fingerprints.get(attemptId);
        if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
            return { status: "invalid" };
        }
        if (existingFingerprint === undefined && fingerprints.size >= maxTombstones) {
            return { status: "invalid" };
        }
        const existing = attempts.get(attemptId);
        if (existing) {
            attempts.delete(attemptId);
            attempts.set(attemptId, { ...existing, lastAccessedAt: now });
            return { status: "ok", attempt: existing.attempt };
        }
        const attempt = buildServerAttempt(
            input,
            exam,
            identity,
            attemptId,
            deterministicFinishedAt(input, attemptId),
        );
        while (attempts.size >= maxEntries) {
            const oldest = attempts.keys().next().value;
            if (typeof oldest !== "string") break;
            attempts.delete(oldest);
        }
        fingerprints.set(attemptId, fingerprint);
        attempts.set(attemptId, {
            attempt,
            lastAccessedAt: now,
        });
        return { status: "ok", attempt };
    }) as StudentSubmissionSimulator;
    simulate.askQuestion = (
        attemptId,
        question,
        identity,
        env: Env = process.env,
        now: number = Date.now(),
    ) => {
        if (env.NODE_ENV === "production" || !enabled(env.OMR_E2E_STUDENT_SUBMISSION_SIMULATION)) {
            return { status: "disabled" };
        }
        const entry = attempts.get(clean(attemptId));
        if (!entry) return { status: "not_found" };
        if (!attemptOwnedBy(entry.attempt, identity)) return { status: "denied" };
        const validated = validateStudentQuestionForAttempt(entry.attempt, question);
        if (!validated) return { status: "invalid" };
        const updated = upsertStudentQuestion(entry.attempt, validated, new Date(now).toISOString());
        if (!updated) return { status: "invalid" };
        attempts.delete(entry.attempt.id);
        attempts.set(entry.attempt.id, { attempt: updated, lastAccessedAt: now });
        return { status: "ok", attempt: updated };
    };
    simulate.reset = () => {
        attempts.clear();
        fingerprints.clear();
    };
    simulate.size = () => attempts.size;
    return simulate;
}
