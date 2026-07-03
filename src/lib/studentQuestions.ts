import type { Attempt, StudentQuestionNote } from "@/types/omr";

/**
 * Student→teacher per-question Q&A, stored on the attempt payload so it rides
 * the existing local↔Supabase attempt sync (and the server-action boundary)
 * without a separate store. Pure helpers — pages persist the returned attempt.
 */

export const STUDENT_QUESTION_MAX_LENGTH = 500;

export interface StudentQuestionInput {
    questionId: number;
    questionNumber: number;
    body: string;
}

export function normalizeStudentQuestionBody(body: string): string {
    return body.trim().slice(0, STUDENT_QUESTION_MAX_LENGTH);
}

function sortNotes(notes: StudentQuestionNote[]): StudentQuestionNote[] {
    return [...notes].sort((a, b) => a.questionNumber - b.questionNumber || a.questionId - b.questionId);
}

/**
 * Upsert a student question (replace-by-questionId). Re-asking a question
 * resets it to `queued` and clears the previous teacher answer — the note
 * always shows the latest exchange.
 */
export function upsertStudentQuestion(
    attempt: Attempt,
    input: StudentQuestionInput,
    nowIso: string,
): Attempt | null {
    const body = normalizeStudentQuestionBody(input.body);
    if (!body || !Number.isFinite(input.questionId)) return null;
    const note: StudentQuestionNote = {
        questionId: input.questionId,
        questionNumber: input.questionNumber,
        body,
        createdAt: nowIso,
        status: "queued",
    };
    const rest = (attempt.studentQuestions || []).filter(q => q.questionId !== input.questionId);
    return { ...attempt, studentQuestions: sortNotes([...rest, note]) };
}

/** Attach a teacher answer to an existing student question. */
export function answerStudentQuestion(
    attempt: Attempt,
    questionId: number,
    answerBody: string,
    nowIso: string,
    teacherName?: string,
): Attempt | null {
    const body = normalizeStudentQuestionBody(answerBody);
    if (!body) return null;
    const notes = attempt.studentQuestions || [];
    if (!notes.some(q => q.questionId === questionId)) return null;
    return {
        ...attempt,
        studentQuestions: sortNotes(notes.map(q => q.questionId === questionId
            ? { ...q, status: "answered" as const, answer: { body, createdAt: nowIso, teacherName } }
            : q)),
    };
}

export function studentQuestionsByQuestionId(
    attempt: Pick<Attempt, "studentQuestions">,
): Record<number, StudentQuestionNote> {
    return (attempt.studentQuestions || []).reduce<Record<number, StudentQuestionNote>>((acc, note) => {
        acc[note.questionId] = note;
        return acc;
    }, {});
}

export function pendingStudentQuestions(attempt: Pick<Attempt, "studentQuestions">): StudentQuestionNote[] {
    return (attempt.studentQuestions || []).filter(note => note.status === "queued");
}

export function answeredStudentQuestions(attempt: Pick<Attempt, "studentQuestions">): StudentQuestionNote[] {
    return (attempt.studentQuestions || []).filter(note => note.status === "answered" && !!note.answer);
}

export interface StudentQuestionInboxEntry {
    attemptId: string;
    examId: string;
    examTitle: string;
    studentName: string;
    groupName?: string;
    note: StudentQuestionNote;
}

export interface StudentQuestionInbox {
    /** Oldest first — the queue the teacher should work through. */
    pending: StudentQuestionInboxEntry[];
    /** Most recently answered first. */
    answered: StudentQuestionInboxEntry[];
}

/** Teacher-side inbox: every student question across attempts, pending first. */
export function collectStudentQuestionInbox(attempts: Attempt[]): StudentQuestionInbox {
    const pending: StudentQuestionInboxEntry[] = [];
    const answered: StudentQuestionInboxEntry[] = [];

    for (const attempt of attempts) {
        for (const note of attempt.studentQuestions || []) {
            const entry: StudentQuestionInboxEntry = {
                attemptId: attempt.id,
                examId: attempt.examId,
                examTitle: attempt.examTitle,
                studentName: attempt.studentName,
                groupName: attempt.groupName,
                note,
            };
            if (note.status === "answered" && note.answer) answered.push(entry);
            else pending.push(entry);
        }
    }

    pending.sort((a, b) => Date.parse(a.note.createdAt) - Date.parse(b.note.createdAt));
    answered.sort((a, b) => (
        Date.parse(b.note.answer?.createdAt || b.note.createdAt) - Date.parse(a.note.answer?.createdAt || a.note.createdAt)
    ));
    return { pending, answered };
}
