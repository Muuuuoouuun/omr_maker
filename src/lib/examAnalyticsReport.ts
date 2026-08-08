export interface ExamHeadlineInsightInput {
    performanceCount: number;
    totalSubmissionCount?: number;
    hasGradableEvidence?: boolean;
    weakConcept?: string;
    weakConceptRate?: number;
    lowStudentCount: number;
    riskyQuestionCount: number;
}

export interface ExamHeadlineInsight {
    tone: "action" | "observation" | "positive";
    title: string;
    detail: string;
}

export type ExamAnalyticsSampleStatus = "ready" | "partial" | "stale";

export function examAnalyticsSampleStatusNote(status: ExamAnalyticsSampleStatus): string | null {
    if (status === "partial") return "일부 제출 기준의 중간 결과입니다.";
    if (status === "stale") return "최신 제출이 아직 반영되지 않았을 수 있습니다.";
    return null;
}

export function resolveExamAnalyticsSampleStatus(input: {
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    remotePartial?: boolean;
}): ExamAnalyticsSampleStatus {
    if (input.remotePartial === true) return "partial";
    if (!input.remoteLoaded || input.remoteSynced === false) return "stale";
    return "ready";
}

function sanitizeCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sanitizeRate(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
    return Math.round(value * 10) / 10;
}

export function buildExamHeadlineInsight(input: ExamHeadlineInsightInput): ExamHeadlineInsight {
    const performanceCount = sanitizeCount(input.performanceCount);
    const totalSubmissionCount = Math.max(
        performanceCount,
        sanitizeCount(input.totalSubmissionCount ?? performanceCount),
    );
    const lowStudentCount = Math.min(sanitizeCount(input.lowStudentCount), performanceCount);
    const riskyQuestionCount = sanitizeCount(input.riskyQuestionCount);
    const weakConcept = input.weakConcept?.trim() || "";
    const weakConceptRate = sanitizeRate(input.weakConceptRate);

    if (input.hasGradableEvidence === false) {
        return {
            tone: "observation",
            title: "채점 가능한 문항 근거가 더 필요합니다",
            detail: "미채점 문항은 취약 개념과 행동 추천에서 제외했습니다.",
        };
    }

    if (performanceCount < 5) {
        return {
            tone: "observation",
            title: "경향을 확정하려면 표본이 더 필요합니다",
            detail: totalSubmissionCount === performanceCount
                ? `현재 ${performanceCount}명 제출 기준입니다.`
                : `전체 제출 ${totalSubmissionCount}건 중 채점 가능한 ${performanceCount}명 기준입니다.`,
        };
    }

    if (weakConcept && weakConceptRate === undefined) {
        return {
            tone: "observation",
            title: "취약 개념의 근거 데이터를 확인해 주세요",
            detail: `‘${weakConcept}’ 정답률을 계산할 수 없습니다.`,
        };
    }

    if (weakConcept && weakConceptRate !== undefined && weakConceptRate < 70) {
        return {
            tone: "action",
            title: `‘${weakConcept}’ 보강이 가장 효과적입니다`,
            detail: `정답률 ${weakConceptRate}% · 지원 학생 ${lowStudentCount}명 · 점검 문항 ${riskyQuestionCount}개`,
        };
    }

    if (riskyQuestionCount > 0) {
        return {
            tone: "observation",
            title: "문항별 정답률 차이를 먼저 점검해 주세요",
            detail: `재점검이 필요한 문항 ${riskyQuestionCount}개입니다.`,
        };
    }

    if (lowStudentCount > 0) {
        return {
            tone: "observation",
            title: "지원이 필요한 학생을 먼저 확인해 주세요",
            detail: `60점 미만 학생 ${lowStudentCount}명입니다.`,
        };
    }

    return {
        tone: "positive",
        title: "현재 시험에서는 뚜렷한 위험 신호가 없습니다",
        detail: `${performanceCount}명 제출 기준입니다.`,
    };
}
