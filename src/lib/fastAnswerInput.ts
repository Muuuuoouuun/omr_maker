import { questionChoiceCount, type Question } from "@/types/omr";

/** Explicit blank marker retained alongside 0 compatibility. */
export const FAST_ANSWER_BLANK = "-";

export type FastAnswerInputResult =
    | { ok: true; answers: Array<number | undefined> }
    | { ok: false; message: string };

/** Each digit is one question. Separators are ignored; 0/- keep a blank slot. */
export function parseFastAnswerInput(value: string, questions: Question[]): FastAnswerInputResult {
    const compact = value.replace(/[\s,;]+/g, "");
    if (/[^1-5\-0]/.test(compact)) {
        return { ok: false, message: "정답은 1~5, 빈 문항은 0 또는 -로 입력하세요. 잘못된 입력은 적용하지 않았습니다." };
    }
    if (compact.length > questions.length) {
        return { ok: false, message: `현재 ${questions.length}문항보다 정답 칸이 많습니다. 문항 수 또는 입력을 확인하세요. 아직 적용하지 않았습니다.` };
    }
    const answers = Array.from(compact, digit => digit === "0" || digit === "-" ? undefined : Number(digit));
    const incompatibleIndex = answers.findIndex((answer, index) => answer !== undefined && answer > questionChoiceCount(questions[index]));
    if (incompatibleIndex >= 0) {
        return { ok: false, message: `${questions[incompatibleIndex].number}번은 ${questionChoiceCount(questions[incompatibleIndex])}지선다입니다. 선택지 범위를 확인하세요. 아직 적용하지 않았습니다.` };
    }
    return { ok: true, answers };
}

/** Clear only the tail previously covered by a valid quick-entry value. */
export function applyFastAnswers(questions: Question[], answers: Array<number | undefined>, previousAppliedLength: number): Question[] {
    return questions.map((question, index) => {
        if (index < answers.length) return { ...question, answer: answers[index] };
        if (index < previousAppliedLength && question.answer !== undefined) return { ...question, answer: undefined };
        return question;
    });
}
