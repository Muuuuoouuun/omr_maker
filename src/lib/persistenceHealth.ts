import type { Attempt, Exam, Question } from "@/types/omr";
import { getEffectiveExamQuestionsForAttempt } from "@/lib/premiumAnalytics";

export type PersistenceHealthKind = "checking" | "local" | "synced" | "pending" | "error";
export type AnalyticsDataHealthKind = "empty" | "ready" | "attention" | "blocked";
export type AnalyticsDataHealthSeverity = "warning" | "error";

export interface PersistenceHealthSource {
    sourceKey?: string;
    sourceLabel?: string;
    remoteLoaded?: boolean;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
    remoteError?: string;
}

export interface PersistenceHealth {
    kind: PersistenceHealthKind;
    label: string;
    detail: string;
    pendingCount: number;
    remoteLoaded: boolean;
    error?: string;
}

export interface AnalyticsDataHealthIssue {
    key: string;
    label: string;
    detail: string;
    count: number;
    severity: AnalyticsDataHealthSeverity;
}

export interface AnalyticsDataHealth {
    kind: AnalyticsDataHealthKind;
    label: string;
    detail: string;
    score: number;
    issues: AnalyticsDataHealthIssue[];
    totalExamCount: number;
    totalAttemptCount: number;
    totalQuestionCount: number;
    resultReadyAttemptCount: number;
}

function safePendingCount(value?: number): number {
    return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

function hasQuestionTypeMetadata(question: Question): boolean {
    return !!(
        question.label?.trim()
        || question.tags?.concept?.trim()
        || question.tags?.unit?.trim()
        || question.tags?.skill?.trim()
        || (question.tags?.mistakeTypes?.length || 0) > 0
    );
}

function hasProblemPdf(exam: Exam): boolean {
    return !!(exam.pdfData || exam.pdfDataRef);
}

function hasQuestionPdfAnchor(question: Question): boolean {
    return !!(question.pdfLocation || question.pdfRegion || question.imageAssetRef);
}

function issue(
    key: string,
    label: string,
    detail: string,
    count: number,
    severity: AnalyticsDataHealthSeverity,
): AnalyticsDataHealthIssue[] {
    return count > 0 ? [{ key, label, detail, count, severity }] : [];
}

export function summarizePersistenceHealth(sources: PersistenceHealthSource[]): PersistenceHealth {
    const pendingCount = sources.reduce((sum, source) => sum + safePendingCount(source.pendingSyncCount), 0);
    const remoteLoaded = sources.some(source => !!source.remoteLoaded);
    const error = sources
        .map(source => source.remoteError?.trim())
        .filter((message): message is string => !!message)
        .join(" / ") || undefined;

    if (sources.length === 0) {
        return {
            kind: "checking",
            label: "동기화 확인 중",
            detail: "저장 상태를 확인하고 있습니다",
            pendingCount: 0,
            remoteLoaded: false,
        };
    }

    if (error) {
        return {
            kind: "error",
            label: "동기화 확인 필요",
            detail: pendingCount > 0 ? `${pendingCount}건 재시도 대기` : "로컬 데이터 기준",
            pendingCount,
            remoteLoaded,
            error,
        };
    }

    if (!remoteLoaded) {
        return {
            kind: "local",
            label: "로컬 저장",
            detail: "Supabase 미연결",
            pendingCount,
            remoteLoaded,
        };
    }

    if (pendingCount > 0) {
        return {
            kind: "pending",
            label: "동기화 대기",
            detail: `${pendingCount}건 재시도 대기`,
            pendingCount,
            remoteLoaded,
        };
    }

    const remoteSynced = sources.every(source => source.remoteSynced !== false);
    if (remoteSynced) {
        return {
            kind: "synced",
            label: "Supabase 동기화",
            detail: "최신 데이터 기준",
            pendingCount,
            remoteLoaded,
        };
    }

    return {
        kind: "pending",
        label: "동기화 확인 중",
        detail: "원격 상태 확인 중",
        pendingCount,
        remoteLoaded,
    };
}

export function summarizeAnalyticsDataHealth(exams: Exam[], attempts: Attempt[]): AnalyticsDataHealth {
    const examById = new Map(exams.map(exam => [exam.id, exam]));
    const questions = exams.flatMap(exam => exam.questions);
    const totalQuestionCount = questions.length;
    const completedAttempts = attempts.filter(attempt => attempt.status !== "in_progress");

    const orphanAttemptCount = attempts.filter(attempt => !examById.has(attempt.examId)).length;
    let missingResultAttemptCount = 0;
    let partialResultAttemptCount = 0;
    let resultReadyAttemptCount = 0;

    for (const attempt of completedAttempts) {
        const exam = examById.get(attempt.examId);
        if (!exam) continue;
        const expectedQuestions = getEffectiveExamQuestionsForAttempt(exam, attempt);
        const expectedQuestionIds = new Set(expectedQuestions.map(question => question.id));
        const expectedCount = expectedQuestions.length;
        const resultCount = attempt.questionResults?.filter(result => (
            result.examId === exam.id && expectedQuestionIds.has(result.questionId)
        )).length || 0;
        if (expectedCount === 0) continue;
        if (resultCount === 0) {
            missingResultAttemptCount += 1;
        } else if (resultCount < expectedCount) {
            partialResultAttemptCount += 1;
        } else {
            resultReadyAttemptCount += 1;
        }
    }

    const missingAnswerCount = questions.filter(question => typeof question.answer !== "number").length;
    const untaggedQuestionCount = questions.filter(question => !hasQuestionTypeMetadata(question)).length;
    const pdfUnlinkedQuestionCount = exams.reduce((sum, exam) => {
        if (!hasProblemPdf(exam)) return sum;
        return sum + exam.questions.filter(question => !hasQuestionPdfAnchor(question)).length;
    }, 0);
    const regionMissingQuestionCount = questions.filter(question => question.pdfLocation && !question.pdfRegion && !question.imageAssetRef).length;

    const issues: AnalyticsDataHealthIssue[] = [
        ...issue(
            "orphan-attempts",
            "시험 없는 제출",
            "삭제되었거나 동기화되지 않은 시험의 제출이 있어 분석 기준을 확인해야 합니다.",
            orphanAttemptCount,
            "error",
        ),
        ...issue(
            "missing-results",
            "문항 결과 미생성",
            "제출은 있지만 문항별 결과 행이 없어 오답/유형 분석이 제한됩니다.",
            missingResultAttemptCount,
            "error",
        ),
        ...issue(
            "partial-results",
            "문항 결과 일부 누락",
            "일부 제출의 문항 결과 수가 시험 문항 수보다 적습니다.",
            partialResultAttemptCount,
            "warning",
        ),
        ...issue(
            "missing-answers",
            "정답 미입력",
            "정답 없는 문항은 채점과 오답 분석에서 빠집니다.",
            missingAnswerCount,
            "warning",
        ),
        ...issue(
            "untagged-questions",
            "유형 태그 부족",
            "개념/단원/오답 원인 태그가 부족하면 재추천 품질이 낮아집니다.",
            untaggedQuestionCount,
            "warning",
        ),
        ...issue(
            "pdf-unlinked",
            "PDF 위치 미연결",
            "문제지 PDF가 있는 시험에서 문항 위치가 비어 있습니다.",
            pdfUnlinkedQuestionCount,
            "warning",
        ),
        ...issue(
            "region-missing",
            "문항 영역 미확정",
            "문항 위치는 있지만 필기 수집/문항 DB용 영역이 아직 없습니다.",
            regionMissingQuestionCount,
            "warning",
        ),
    ];

    const penalty = issues.reduce((sum, item) => sum + (item.severity === "error" ? 22 : 8), 0);
    const score = exams.length === 0 && attempts.length === 0
        ? 0
        : Math.max(0, 100 - penalty);
    const topIssue = issues[0];
    const hasErrors = issues.some(item => item.severity === "error");

    if (exams.length === 0 && attempts.length === 0) {
        return {
            kind: "empty",
            label: "데이터 대기",
            detail: "시험과 제출이 쌓이면 분석 품질을 점검합니다",
            score,
            issues,
            totalExamCount: 0,
            totalAttemptCount: 0,
            totalQuestionCount: 0,
            resultReadyAttemptCount: 0,
        };
    }

    if (hasErrors) {
        return {
            kind: "blocked",
            label: "데이터 점검 필요",
            detail: topIssue ? `${topIssue.label} ${topIssue.count}건` : "분석 기준 확인 필요",
            score,
            issues,
            totalExamCount: exams.length,
            totalAttemptCount: attempts.length,
            totalQuestionCount,
            resultReadyAttemptCount,
        };
    }

    if (issues.length > 0) {
        return {
            kind: "attention",
            label: "분석 품질 보강",
            detail: topIssue ? `${topIssue.label} ${topIssue.count}건` : "보강 항목 확인",
            score,
            issues,
            totalExamCount: exams.length,
            totalAttemptCount: attempts.length,
            totalQuestionCount,
            resultReadyAttemptCount,
        };
    }

    return {
        kind: "ready",
        label: "분석 데이터 준비",
        detail: "문항 결과/유형/영역 기준 정리됨",
        score,
        issues,
        totalExamCount: exams.length,
        totalAttemptCount: attempts.length,
        totalQuestionCount,
        resultReadyAttemptCount,
    };
}
