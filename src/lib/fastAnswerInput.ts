/** Character that marks a question as intentionally blank in the quick answer input. */
export const FAST_ANSWER_BLANK = "-";

export interface FastAnswerParseResult {
    /** Input with rejected characters removed (blanks and separators are kept as typed). */
    value: string;
    /** One slot per question in order; `undefined` is an explicit blank (`-`). */
    answers: Array<number | undefined>;
    /** Characters dropped because they are not 1..maxChoice, `-`, or a separator. */
    rejectedCount: number;
}

const SEPARATOR = /[\s,]/;

/**
 * Parse the create screen's quick answer string ("31-24, 51...").
 *
 * - digits 1..maxChoice set the answer of the next question
 * - `-` leaves the next question blank but keeps its position, so later
 *   answers do not shift up a slot
 * - spaces and commas are visual separators only
 * - anything else (0, digits above maxChoice, letters) is rejected and counted
 */
export function parseFastAnswerInput(raw: string, maxChoice: number): FastAnswerParseResult {
    const answers: Array<number | undefined> = [];
    let value = "";
    let rejectedCount = 0;
    for (const char of raw) {
        if (SEPARATOR.test(char)) {
            value += char;
            continue;
        }
        if (char === FAST_ANSWER_BLANK) {
            value += char;
            answers.push(undefined);
            continue;
        }
        const digit = char >= "0" && char <= "9" ? Number(char) : Number.NaN;
        if (Number.isInteger(digit) && digit >= 1 && digit <= maxChoice) {
            value += char;
            answers.push(digit);
            continue;
        }
        rejectedCount += 1;
    }
    return { value, answers, rejectedCount };
}
