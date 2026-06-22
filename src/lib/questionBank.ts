import { questionChoiceCount, questionWeight, type Attempt, type Exam, type Question, type QuestionResult } from "@/types/omr";

export type QuestionBankReadinessStatus = "ready" | "analysis_ready" | "metadata_needed" | "crop_needed";

export interface QuestionBankRecord {
    canonicalQuestionId: string;
    examId: string;
    examTitle: string;
    questionId: number;
    questionNumber: number;
    label: string;
    concept: string;
    subject?: string;
    unit?: string;
    skill?: string;
    source?: string;
    difficulty?: NonNullable<Question["tags"]>["difficulty"];
    mistakeTypes: string[];
    choices: 4 | 5;
    correctAnswer?: number;
    score: number;
    hasAnswer: boolean;
    hasTypeMetadata: boolean;
    hasPdfLocation: boolean;
    hasPdfRegion: boolean;
    hasImageAsset: boolean;
    resultRowCount: number;
    attemptAnswerCount: number;
    analysisReady: boolean;
    cropReady: boolean;
    imageAssetRequired: boolean;
    readinessStatus: QuestionBankReadinessStatus;
    missingActions: string[];
}

export interface QuestionBankReadinessSummary {
    totalQuestions: number;
    analysisReadyCount: number;
    cropReadyCount: number;
    metadataReadyCount: number;
    resultBackedCount: number;
    imageAssetRequiredCount: number;
    analysisReadyRate: number;
    cropReadyRate: number;
    metadataReadyRate: number;
    weakestRecords: QuestionBankRecord[];
}

function roundRate(numerator: number, denominator: number): number {
    return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function cleanText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}

function statusForRecord(params: {
    analysisReady: boolean;
    hasTypeMetadata: boolean;
    cropReady: boolean;
}): QuestionBankReadinessStatus {
    if (params.analysisReady && params.hasTypeMetadata && params.cropReady) return "ready";
    if (!params.hasTypeMetadata) return "metadata_needed";
    if (!params.cropReady) return "crop_needed";
    return "analysis_ready";
}

function missingActionsForRecord(params: {
    hasAnswer: boolean;
    hasTypeMetadata: boolean;
    hasPdfLocation: boolean;
    hasPdfRegion: boolean;
    hasImageAsset: boolean;
    resultRowCount: number;
}): string[] {
    const actions: string[] = [];
    if (!params.hasAnswer) actions.push("정답 입력");
    if (!params.hasTypeMetadata) actions.push("유형/개념 태그");
    if (!params.hasPdfLocation && !params.hasImageAsset) actions.push("PDF 문항 위치 지정");
    if (params.hasPdfLocation && !params.hasPdfRegion && !params.hasImageAsset) actions.push("문항 영역 커팅");
    if (params.resultRowCount === 0) actions.push("제출 결과 수집");
    return actions;
}

export function canonicalQuestionIdFor(examId: string, questionId: number): string {
    return `${examId}:${questionId}`;
}

export function buildQuestionBankRecords(exam: Exam, attempts: Attempt[] = []): QuestionBankRecord[] {
    const resultCounts = new Map<number, number>();
    const answerCounts = new Map<number, number>();

    for (const attempt of attempts) {
        if (attempt.examId !== exam.id) continue;
        for (const result of attempt.questionResults || []) {
            if (result.examId && result.examId !== exam.id) continue;
            resultCounts.set(result.questionId, (resultCounts.get(result.questionId) || 0) + 1);
        }
        for (const questionIdText of Object.keys(attempt.answers || {})) {
            const questionId = Number(questionIdText);
            if (Number.isFinite(questionId)) {
                answerCounts.set(questionId, (answerCounts.get(questionId) || 0) + 1);
            }
        }
    }

    return exam.questions.map(question => {
        const concept = cleanText(question.tags?.concept) || cleanText(question.label) || "일반";
        const label = cleanText(question.label) || concept;
        const hasAnswer = typeof question.answer === "number";
        const hasTypeMetadata = !!(
            cleanText(question.tags?.concept)
            || cleanText(question.tags?.unit)
            || cleanText(question.tags?.skill)
            || cleanText(question.label)
            || (question.tags?.mistakeTypes?.length || 0) > 0
        );
        const hasPdfLocation = !!question.pdfLocation || !!question.pdfRegion;
        const hasPdfRegion = !!question.pdfRegion;
        const hasImageAsset = !!question.imageAssetRef;
        const resultRowCount = resultCounts.get(question.id) || 0;
        const attemptAnswerCount = answerCounts.get(question.id) || 0;
        const analysisReady = hasAnswer && hasTypeMetadata;
        const cropReady = hasPdfRegion || hasImageAsset;
        const missingActions = missingActionsForRecord({
            hasAnswer,
            hasTypeMetadata,
            hasPdfLocation,
            hasPdfRegion,
            hasImageAsset,
            resultRowCount,
        });

        return {
            canonicalQuestionId: canonicalQuestionIdFor(exam.id, question.id),
            examId: exam.id,
            examTitle: exam.title,
            questionId: question.id,
            questionNumber: question.number,
            label,
            concept,
            subject: cleanText(question.tags?.subject),
            unit: cleanText(question.tags?.unit),
            skill: cleanText(question.tags?.skill),
            source: cleanText(question.tags?.source),
            difficulty: question.tags?.difficulty,
            mistakeTypes: [...(question.tags?.mistakeTypes || [])],
            choices: questionChoiceCount(question),
            correctAnswer: question.answer,
            score: questionWeight(question, exam.questions.length),
            hasAnswer,
            hasTypeMetadata,
            hasPdfLocation,
            hasPdfRegion,
            hasImageAsset,
            resultRowCount,
            attemptAnswerCount,
            analysisReady,
            cropReady,
            imageAssetRequired: !cropReady,
            readinessStatus: statusForRecord({ analysisReady, hasTypeMetadata, cropReady }),
            missingActions,
        };
    });
}

export function summarizeQuestionBankReadiness(records: QuestionBankRecord[]): QuestionBankReadinessSummary {
    const totalQuestions = records.length;
    const analysisReadyCount = records.filter(record => record.analysisReady).length;
    const cropReadyCount = records.filter(record => record.cropReady).length;
    const metadataReadyCount = records.filter(record => record.hasTypeMetadata).length;
    const resultBackedCount = records.filter(record => record.resultRowCount > 0).length;
    const imageAssetRequiredCount = records.filter(record => record.imageAssetRequired).length;
    const statusRank: Record<QuestionBankReadinessStatus, number> = {
        metadata_needed: 0,
        crop_needed: 1,
        analysis_ready: 2,
        ready: 3,
    };
    const weakestRecords = [...records]
        .sort((a, b) => {
            if (statusRank[a.readinessStatus] !== statusRank[b.readinessStatus]) {
                return statusRank[a.readinessStatus] - statusRank[b.readinessStatus];
            }
            if (a.resultRowCount !== b.resultRowCount) return a.resultRowCount - b.resultRowCount;
            return a.questionNumber - b.questionNumber;
        })
        .slice(0, 5);

    return {
        totalQuestions,
        analysisReadyCount,
        cropReadyCount,
        metadataReadyCount,
        resultBackedCount,
        imageAssetRequiredCount,
        analysisReadyRate: roundRate(analysisReadyCount, totalQuestions),
        cropReadyRate: roundRate(cropReadyCount, totalQuestions),
        metadataReadyRate: roundRate(metadataReadyCount, totalQuestions),
        weakestRecords,
    };
}

export function buildQuestionBankReadiness(exam: Exam, attempts: Attempt[] = []): QuestionBankReadinessSummary {
    return summarizeQuestionBankReadiness(buildQuestionBankRecords(exam, attempts));
}

export function ensureQuestionResultCanonicalId(result: QuestionResult): QuestionResult {
    return {
        ...result,
        canonicalQuestionId: result.canonicalQuestionId || canonicalQuestionIdFor(result.examId, result.questionId),
    };
}
