import type { Exam, Question } from "@/types/omr";

export type SolvableQuestion = Omit<Question, "answer" | "explanation">;

export interface SolvableExam
    extends Omit<Exam, "questions" | "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    questions: SolvableQuestion[];
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdf?: undefined;
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
}

export interface ReviewableExam extends Omit<Exam, "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    /** Never shipped on the review payload — the answer sheet stays teacher-side. */
    answerKeyPdf?: undefined;
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
}

/**
 * Server-side projection for the POST-SUBMIT review: correct answers and
 * explanations are intentionally kept (the student already submitted), but the
 * inline PIN and the teacher's answer-key PDF never leave the server.
 */
export function stripExamForReview(exam: Exam): ReviewableExam {
    const {
        answerKeyPdf: _omitPdf,
        answerKeyPdfRef: _omitPdfRef,
        accessConfig,
        ...rest
    } = exam;
    void _omitPdf;
    void _omitPdfRef;

    return {
        ...rest,
        accessConfig: accessConfig
            ? { type: accessConfig.type, groupIds: accessConfig.groupIds, hasPin: !!accessConfig.pin }
            : undefined,
    };
}

/**
 * Server-side projection of an exam that is safe to ship to the solving client:
 * no correct answers, no answer-key PDF, no inline PIN (only a hasPin flag).
 */
export function stripExamForSolving(exam: Exam): SolvableExam {
    const solvableQuestions: SolvableQuestion[] = exam.questions.map(question => {
        const { answer: _omitAnswer, explanation: _omitExplanation, ...rest } = question;
        void _omitAnswer;
        void _omitExplanation;
        return rest;
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
        accessConfig: accessConfig
            ? { type: accessConfig.type, groupIds: accessConfig.groupIds, hasPin: !!accessConfig.pin }
            : undefined,
    };
}
