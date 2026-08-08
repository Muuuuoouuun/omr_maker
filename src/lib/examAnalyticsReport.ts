export interface ExamHeadlineInsightInput {
    submissionCount: number;
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

function sanitizeCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sanitizeRate(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
    return Math.round(value * 10) / 10;
}

export function buildExamHeadlineInsight(input: ExamHeadlineInsightInput): ExamHeadlineInsight {
    const submissionCount = sanitizeCount(input.submissionCount);
    const lowStudentCount = Math.min(sanitizeCount(input.lowStudentCount), submissionCount);
    const riskyQuestionCount = sanitizeCount(input.riskyQuestionCount);
    const weakConcept = input.weakConcept?.trim() || "";
    const weakConceptRate = sanitizeRate(input.weakConceptRate);

    if (submissionCount < 5) {
        return {
            tone: "observation",
            title: "경향을 확정하려면 표본이 더 필요합니다",
            detail: `현재 ${submissionCount}명 제출 기준입니다.`,
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
        detail: `${submissionCount}명 제출 기준입니다.`,
    };
}
