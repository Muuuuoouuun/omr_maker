export const MIN_QUESTION_COUNT = 1;
export const MAX_QUESTION_COUNT = 50;

export function parseQuestionCountInput(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;

    const count = Number(trimmed);
    return Number.isInteger(count)
        && count >= MIN_QUESTION_COUNT
        && count <= MAX_QUESTION_COUNT
        ? count
        : null;
}

export const QUESTION_COUNT_CLAMPED_NOTICE =
    `최대 ${MAX_QUESTION_COUNT}문항까지 만들 수 있어 ${MAX_QUESTION_COUNT}으로 맞췄습니다`;

export type QuestionCountInputResolution =
    | { status: "ok"; count: number }
    | { status: "clamped"; count: typeof MAX_QUESTION_COUNT }
    | { status: "invalid" };

/**
 * Like parseQuestionCountInput, but a whole number above the maximum is
 * clamped to MAX_QUESTION_COUNT (the caller explains it inline) instead of
 * being rejected outright.
 */
export function resolveQuestionCountInput(value: string): QuestionCountInputResolution {
    const count = parseQuestionCountInput(value);
    if (count !== null) return { status: "ok", count };
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed) && Number(trimmed) > MAX_QUESTION_COUNT) {
        return { status: "clamped", count: MAX_QUESTION_COUNT };
    }
    return { status: "invalid" };
}
