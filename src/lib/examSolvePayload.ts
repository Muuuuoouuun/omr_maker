import type { Exam, Question } from "@/types/omr";

export type SolvableQuestion = Omit<Question, "answer">;

export interface SolvableExam
    extends Omit<Exam, "questions" | "answerKeyPdf" | "answerKeyPdfRef" | "accessConfig"> {
    questions: SolvableQuestion[];
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdf?: undefined;
    /** Always absent on the solve payload — never sent to the client. */
    answerKeyPdfRef?: undefined;
    accessConfig?: { type: "public" | "group"; groupIds?: string[]; hasPin: boolean };
}

/**
 * Server-side projection of an exam that is safe to ship to the solving client:
 * no correct answers, no answer-key PDF, no inline PIN (only a hasPin flag).
 */
export function stripExamForSolving(exam: Exam): SolvableExam {
    const solvableQuestions: SolvableQuestion[] = exam.questions.map(question => {
        const { answer: _omitAnswer, ...rest } = question;
        void _omitAnswer;
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
