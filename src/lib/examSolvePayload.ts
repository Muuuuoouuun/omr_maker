import type { Attempt, Exam, Question, QuestionSubQuestion } from "@/types/omr";

export type StudentSubQuestion = Omit<QuestionSubQuestion, "answerGuide" | "teacherNote">;
export type SolvableQuestion = Omit<Question, "answer" | "explanation" | "subQuestions"> & {
    subQuestions?: StudentSubQuestion[];
};

export interface SolvableExam
    extends Omit<Exam, "questions" | "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    questions: SolvableQuestion[];
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdf?: undefined;
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
    /** Server-derived capabilities for this exam's organization. */
    premiumCapabilities: {
        handwritingArchive: boolean;
    };
}

export interface ReviewableExam extends Omit<Exam, "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    /** Never shipped on the review payload — the answer sheet stays teacher-side. */
    answerKeyPdf?: undefined;
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
}

/** Remove teacher-only nested fields while otherwise preserving an exam payload. */
export function stripTeacherOnlySubQuestionFields(exam: Exam): Exam {
    return {
        ...exam,
        questions: exam.questions.map(question => ({
            ...question,
            subQuestions: question.subQuestions?.map(({ answerGuide: _guide, teacherNote: _note, ...subQuestion }) => {
                void _guide;
                void _note;
                return subQuestion;
            }),
        })),
    };
}

/**
 * Server-side projection for the POST-SUBMIT review: correct answers and
 * explanations are intentionally kept (the student already submitted), but the
 * inline PIN and the teacher's answer-key PDF never leave the server.
 */
export function stripExamForReview(exam: Exam): ReviewableExam {
    const studentSafeExam = stripTeacherOnlySubQuestionFields(exam);
    const {
        answerKeyPdf: _omitPdf,
        answerKeyPdfRef: _omitPdfRef,
        accessConfig,
        ...rest
    } = studentSafeExam;
    void _omitPdf;
    void _omitPdfRef;

    return {
        ...rest,
        questions: rest.questions,
        accessConfig: accessConfig
            ? { type: accessConfig.type, groupIds: accessConfig.groupIds, hasPin: !!accessConfig.pin }
            : undefined,
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
 */
export function stripExamForAttemptReview(exam: Exam, attempt: Attempt): ReviewableExam {
    const issuedQuestionIds = new Set(
        (attempt.questionResults || [])
            .map(result => result.questionId)
            .filter(questionId => Number.isInteger(questionId) && questionId > 0),
    );
    return stripExamForReview(issuedQuestionIds.size > 0
        ? {
            ...exam,
            questions: exam.questions.filter(question => issuedQuestionIds.has(question.id)),
        }
        : exam);
}

/**
 * Server-side projection of an exam that is safe to ship to the solving client:
 * no correct answers, no answer-key PDF, no inline PIN (only a hasPin flag).
 */
export function stripExamForSolving(
    exam: Exam,
    premiumCapabilities: SolvableExam["premiumCapabilities"] = { handwritingArchive: false },
): SolvableExam {
    const solvableQuestions: SolvableQuestion[] = exam.questions.map(question => {
        const { answer: _omitAnswer, explanation: _omitExplanation, subQuestions, ...rest } = question;
        void _omitAnswer;
        void _omitExplanation;
        return {
            ...rest,
            subQuestions: subQuestions?.map(({ answerGuide: _guide, teacherNote: _note, ...subQuestion }) => {
                void _guide;
                void _note;
                return subQuestion;
            }),
        };
    });

    const {
        answerKeyPdf: _omitPdf,
        answerKeyPdfRef: _omitPdfRef,
        accessConfig,
        questions: _omitQuestions,
        ...rest
    } = exam;
    void _omitPdf;
    void _omitPdfRef;
    void _omitQuestions;

    return {
        ...rest,
        questions: solvableQuestions,
        premiumCapabilities,
        accessConfig: accessConfig
            ? { type: accessConfig.type, groupIds: accessConfig.groupIds, hasPin: !!accessConfig.pin }
            : undefined,
    };
}
