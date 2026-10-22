import type { Attempt, Exam, Question, QuestionSubQuestion, StoredDataRef, QuestionPdfRegion } from "@/types/omr";

export type StudentSubQuestion = Pick<QuestionSubQuestion,
    "schemaVersion" | "id" | "prompt" | "kind" | "templateId" | "required" | "maxLength"
>;
export type SolvableQuestion = Pick<Question,
    "id" | "number" | "score" | "choices" | "pdfLocation" | "pdfRegion" | "passagePdfRegions"
> & { subQuestions?: StudentSubQuestion[] };
export type ReviewableQuestion = SolvableQuestion & Pick<Question, "answer" | "explanation" | "label"> & {
    tags?: Pick<NonNullable<Question["tags"]>, "concept" | "source">;
};

type StudentExamFields = Pick<Exam,
    "id" | "title" | "revision" | "createdAt" | "updatedAt"
    | "durationMin" | "startAt" | "endAt" | "archived" | "pdfData" | "pdfDataRef"
>;

export interface SolvableExam extends StudentExamFields {
    questions: SolvableQuestion[];
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdf?: undefined;
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group" | "targeted"; hasPin: boolean };
    /** Server-derived capabilities for this exam's organization. */
    premiumCapabilities: { handwritingArchive: boolean };
}

export interface ReviewableExam extends StudentExamFields {
    questions: ReviewableQuestion[];
    /** Never shipped on the review payload — the answer sheet stays teacher-side. */
    answerKeyPdf?: undefined;
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group" | "targeted"; hasPin: boolean };
}

// These explicit projections are a security boundary. New authoring fields must
// be reviewed before being added here; spreading a persisted Exam/Question can
// expose teacher-only material even when answers themselves have been removed.
function studentDataRef(ref: StoredDataRef | undefined): StoredDataRef | undefined {
    return ref ? {
        store: ref.store, key: ref.key, organizationId: ref.organizationId,
        kind: ref.kind, examId: ref.examId, attemptId: ref.attemptId,
        name: ref.name, mimeType: ref.mimeType, size: ref.size, updatedAt: ref.updatedAt,
    } : undefined;
}

function studentPdfRegion(region: QuestionPdfRegion): QuestionPdfRegion {
    return { page: region.page, x: region.x, y: region.y, width: region.width, height: region.height };
}

function studentQuestion(question: Question): SolvableQuestion {
    return {
        id: question.id,
        number: question.number,
        score: question.score,
        choices: question.choices,
        pdfLocation: question.pdfLocation ? {
            page: question.pdfLocation.page, x: question.pdfLocation.x, y: question.pdfLocation.y,
        } : undefined,
        pdfRegion: question.pdfRegion ? studentPdfRegion(question.pdfRegion) : undefined,
        passagePdfRegions: question.passagePdfRegions?.map(studentPdfRegion),
        subQuestions: question.subQuestions?.map(subQuestion => ({
            schemaVersion: subQuestion.schemaVersion,
            id: subQuestion.id,
            prompt: subQuestion.prompt,
            kind: subQuestion.kind,
            templateId: subQuestion.templateId,
            required: subQuestion.required,
            maxLength: subQuestion.maxLength,
        })),
    };
}

function reviewQuestion(question: Question): ReviewableQuestion {
    return {
        ...studentQuestion(question), answer: question.answer, explanation: question.explanation,
        // The submitted-attempt review renders these three student-facing chips.
        // Other diagnostic tags (e.g. trap/mistake prerequisites) stay private.
        label: question.label,
        tags: question.tags ? { concept: question.tags.concept, source: question.tags.source } : undefined,
    };
}

function studentExamFields(exam: Exam): StudentExamFields {
    return {
        id: exam.id, title: exam.title, revision: exam.revision,
        createdAt: exam.createdAt, updatedAt: exam.updatedAt,
        durationMin: exam.durationMin, startAt: exam.startAt, endAt: exam.endAt,
        archived: exam.archived, pdfData: exam.pdfData, pdfDataRef: studentDataRef(exam.pdfDataRef),
    };
}

/**
 * Strip teacher-only question material from the local solve fallback too.
 * NOT a server DTO: local grading and analytics still need the existing answer,
 * PIN, tags and other metadata already stored on this device. Server responses
 * must use the allowlisted DTO projections below instead.
 */
export function stripTeacherOnlySubQuestionFields(exam: Exam): Exam {
    return {
        ...exam,
        questions: exam.questions.map(question => {
            const { contentAnalysis: _analysis, subQuestions, ...localQuestion } = question;
            void _analysis;
            return {
                ...localQuestion,
                subQuestions: subQuestions?.map(subQuestion => {
                    const { answerGuide: _guide, teacherNote: _note, ...studentPrompt } = subQuestion;
                    void _guide;
                    void _note;
                    return studentPrompt;
                }),
            };
        }),
    };
}

/**
 * POST-SUBMIT review intentionally includes answers and explanations. AI content
 * analysis, authoring notes, the inline PIN and answer-key PDF remain private.
 */
export function stripExamForReview(exam: Exam): ReviewableExam {
    return {
        ...studentExamFields(exam),
        questions: exam.questions.map(reviewQuestion),
        accessConfig: exam.accessConfig ? {
            type: exam.accessConfig.type,
            hasPin: !!exam.accessConfig.pin,
        } : undefined,
    };
}

/**
 * Post-submit projection scoped to the question set that was actually issued
 * for this attempt. Server-graded attempts always persist one question result
 * per issued question, including unanswered questions, so this prevents a
 * subset submission from unlocking answers for the rest of the canonical exam.
 *
 * Legacy attempts without question results retain the historical full-exam
 * review behavior because their issued question set cannot be reconstructed.
 * A nonempty but malformed result list must never unlock the full answer key.
 */
export function stripExamForAttemptReview(exam: Exam, attempt: Attempt): ReviewableExam {
    const questionResults = attempt.questionResults || [];
    const issuedQuestionIds = new Set(
        questionResults
            .map(result => result.questionId)
            .filter(questionId => Number.isSafeInteger(questionId) && questionId >= 0),
    );
    return stripExamForReview(questionResults.length > 0
        ? { ...exam, questions: exam.questions.filter(question => issuedQuestionIds.has(question.id)) }
        : exam);
}

/** Safe pre-submit DTO; no teacher analysis, answers, answer-key PDF or PIN. */
export function stripExamForSolving(
    exam: Exam,
    premiumCapabilities: SolvableExam["premiumCapabilities"] = { handwritingArchive: false },
): SolvableExam {
    return {
        ...studentExamFields(exam),
        questions: exam.questions.map(studentQuestion),
        premiumCapabilities: { handwritingArchive: premiumCapabilities.handwritingArchive },
        accessConfig: exam.accessConfig
            ? { type: exam.accessConfig.type, hasPin: !!exam.accessConfig.pin }
            : undefined,
    };
}
