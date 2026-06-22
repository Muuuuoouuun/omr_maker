export const AI_ANSWER_MODELS = {
    default: "gemini-3.5-flash",
    highAccuracy: "gemini-3.1-pro-preview",
    fallback: "gemini-2.5-pro",
} as const;

export type AiAnswerRecognitionMode = "default" | "rerecognition";

export interface AiAnswerModelRoutingOptions {
    recognitionMode?: AiAnswerRecognitionMode;
}

export interface AiAnswerQualityReport {
    status: "ok" | "many_errors";
    reason: string;
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateQuestions: number;
    lowConfidenceRows: number;
    missingQuestionGaps: number;
}

const ANSWER_MAP: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    D: 4,
    E: 5,
    "①": 1,
    "②": 2,
    "③": 3,
    "④": 4,
    "⑤": 5,
    "가": 1,
    "나": 2,
    "다": 3,
    "라": 4,
    "마": 5,
};

function parseQuestionNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (typeof value !== "string") return null;
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
}

function parseAnswerValue(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
    }
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const mapped = ANSWER_MAP[trimmed.toUpperCase()] ?? ANSWER_MAP[trimmed];
    if (mapped) return mapped;

    const numeric = trimmed.match(/[1-5](?=\s*번|\s*$|[^0-9])/);
    return numeric ? Number(numeric[0]) : null;
}

function extractCandidateFields(row: unknown): { questionNum: number | null; answer: number | null; confidence?: number } {
    if (!row || typeof row !== "object") {
        return { questionNum: null, answer: null };
    }

    const item = row as Record<string, unknown>;
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? item.confidence
        : undefined;

    return {
        questionNum: parseQuestionNumber(item.questionNum ?? item.question ?? item.number ?? item.id ?? item.no ?? item.q),
        answer: parseAnswerValue(item.answer ?? item.correctAnswer ?? item.correct ?? item.value ?? item.val ?? item.choice),
        confidence,
    };
}

function countMissingQuestionGaps(questionNumbers: number[]): number {
    const unique = [...new Set(questionNumbers)].sort((a, b) => a - b);
    if (unique.length < 10 || unique[0] !== 1) return 0;

    const maxQuestion = unique[unique.length - 1];
    if (maxQuestion > 300) return 0;

    return Math.max(0, maxQuestion - unique.length);
}

export function evaluateAnswerRowsQuality(rows: unknown[]): AiAnswerQualityReport {
    if (!Array.isArray(rows) || rows.length === 0) {
        return {
            status: "many_errors",
            reason: "no_rows",
            totalRows: Array.isArray(rows) ? rows.length : 0,
            validRows: 0,
            invalidRows: Array.isArray(rows) ? rows.length : 0,
            duplicateQuestions: 0,
            lowConfidenceRows: 0,
            missingQuestionGaps: 0,
        };
    }

    const seenQuestions = new Set<number>();
    const validQuestionNumbers: number[] = [];
    let validRows = 0;
    let invalidRows = 0;
    let duplicateQuestions = 0;
    let lowConfidenceRows = 0;

    for (const row of rows) {
        const fields = extractCandidateFields(row);
        if (!fields.questionNum || !fields.answer) {
            invalidRows += 1;
            continue;
        }

        validRows += 1;
        validQuestionNumbers.push(fields.questionNum);

        if (seenQuestions.has(fields.questionNum)) {
            duplicateQuestions += 1;
        }
        seenQuestions.add(fields.questionNum);

        if (fields.confidence !== undefined && fields.confidence < 0.65) {
            lowConfidenceRows += 1;
        }
    }

    const missingQuestionGaps = countMissingQuestionGaps(validQuestionNumbers);
    const totalRows = rows.length;
    const invalidRatio = invalidRows / totalRows;
    const lowConfidenceRatio = validRows > 0 ? lowConfidenceRows / validRows : 1;
    const duplicateRatio = validRows > 0 ? duplicateQuestions / validRows : 1;
    const gapRatio = seenQuestions.size > 0 ? missingQuestionGaps / seenQuestions.size : 0;

    let reason = "ok";
    if (validRows === 0) {
        reason = "no_valid_rows";
    } else if (invalidRows >= 2 && invalidRatio >= 0.2) {
        reason = "too_many_invalid_rows";
    } else if (lowConfidenceRows >= 2 && lowConfidenceRatio >= 0.25) {
        reason = "too_many_low_confidence_rows";
    } else if (duplicateQuestions >= 2 || duplicateRatio >= 0.15) {
        reason = "too_many_duplicate_questions";
    } else if (missingQuestionGaps >= 3 && gapRatio >= 0.25) {
        reason = "too_many_question_gaps";
    }

    return {
        status: reason === "ok" ? "ok" : "many_errors",
        reason,
        totalRows,
        validRows,
        invalidRows,
        duplicateQuestions,
        lowConfidenceRows,
        missingQuestionGaps,
    };
}

export function shouldUseHighAccuracyAnswerModel(
    options: AiAnswerModelRoutingOptions = {},
    qualityReport?: AiAnswerQualityReport,
): boolean {
    return options.recognitionMode === "rerecognition" || qualityReport?.status === "many_errors";
}
