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
