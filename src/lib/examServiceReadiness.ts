import type { Exam } from "@/types/omr";
import type { ExamValidationIssue, ExamValidationSummary } from "@/lib/examValidation";

export type ExamServiceReadinessLevel = "ready" | "warning" | "blocked";
export type ExamServiceReadinessItemKey = "draft" | "answers" | "problem_pdf" | "answer_pdf" | "pdf_regions" | "metadata" | "distribution";

export interface ExamServiceReadinessItem {
    key: ExamServiceReadinessItemKey;
    label: string;
    status: ExamServiceReadinessLevel;
    value: string;
    message: string;
}

export interface ExamServiceReadinessSummary {
    level: ExamServiceReadinessLevel;
    label: string;
    detail: string;
    canSaveDraft: boolean;
    canOpenDistribution: boolean;
    canPublish: boolean;
    blockingIssues: ExamValidationIssue[];
    warningIssues: ExamValidationIssue[];
    items: ExamServiceReadinessItem[];
}

interface ExamServiceReadinessInput {
    title: string;
    validation: ExamValidationSummary;
    hasProblemPdf: boolean;
    hasAnswerKeyPdf: boolean;
    accessConfig?: Exam["accessConfig"];
}

const ANSWER_ERROR_CODES = new Set(["missing_answers", "answer_out_of_range"]);
const DRAFT_BLOCKING_CODES = new Set([
    "title_required",
    "questions_required",
    "duplicate_question_ids",
    "invalid_question_numbers",
    "duplicate_question_numbers",
]);
const DISTRIBUTION_ERROR_CODES = new Set(["group_required", "invalid_pin"]);

function hasIssue(issues: ExamValidationIssue[], codes: Set<string>): boolean {
    return issues.some(issue => codes.has(issue.code));
}

function distributionValue(accessConfig?: Exam["accessConfig"]): string {
    if (!accessConfig) return "선택 대기";
    if (accessConfig.type === "group") return `${accessConfig.groupIds?.length || 0}개 그룹`;
    return accessConfig.pin ? "공개 링크 · PIN" : "공개 링크";
}

function distributionMessage(accessConfig?: Exam["accessConfig"]): string {
    if (!accessConfig) return "배포하기에서 공개 링크 또는 그룹 배포를 선택하면 최종 링크를 만들 수 있습니다.";
    if (accessConfig.type === "group") return "대상 그룹 기준으로 응시 링크가 제한됩니다.";
    return accessConfig.pin ? "공개 링크에 PIN 접근 보호가 적용됩니다." : "PIN 없는 공개 링크로 배포됩니다.";
}

export function buildExamServiceReadiness(input: ExamServiceReadinessInput): ExamServiceReadinessSummary {
    const errors = input.validation.errors;
    const warnings = input.validation.warnings;
    const totalQuestions = input.validation.totalQuestions;
    const titleReady = input.title.trim().length >= 2;
    const draftBlocked = hasIssue(errors, DRAFT_BLOCKING_CODES);
    const answerBlocked = hasIssue(errors, ANSWER_ERROR_CODES);
    const distributionBlocked = hasIssue(errors, DISTRIBUTION_ERROR_CODES);

    const items: ExamServiceReadinessItem[] = [
        {
            key: "draft",
            label: "저장 기준",
            status: draftBlocked ? "blocked" : "ready",
            value: titleReady && totalQuestions > 0 ? `${totalQuestions}문항` : "확인 필요",
            message: draftBlocked ? "시험 제목, 문항 수, 문항 ID/번호를 먼저 정리해야 합니다." : "기본 시험 구조가 저장 가능한 상태입니다.",
        },
        {
            key: "answers",
            label: "정답키",
            status: answerBlocked ? "blocked" : "ready",
            value: `${input.validation.answeredCount}/${totalQuestions}`,
            message: answerBlocked ? "정답 누락 또는 선택지 범위 오류가 있습니다." : "모든 문항 정답이 선택지 범위 안에 있습니다.",
        },
        {
            key: "problem_pdf",
            label: "문제지 PDF",
            status: input.hasProblemPdf ? "ready" : "warning",
            value: input.hasProblemPdf ? "연결됨" : "미연결",
            message: input.hasProblemPdf ? "학생 풀이 화면에 문제지 PDF를 함께 제공할 수 있습니다." : "OMR만 배포할 수는 있지만 PDF 풀이 경험은 약해집니다.",
        },
        {
            key: "answer_pdf",
            label: "참고 답지",
            status: input.hasAnswerKeyPdf ? "ready" : "warning",
            value: input.hasAnswerKeyPdf ? "보관됨" : "선택 사항",
            message: input.hasAnswerKeyPdf ? "원본 답지 PDF를 교사용 참고 자료로 보관합니다." : "정답은 저장되어 있어 배포 가능하지만 참고 답지 PDF는 없습니다.",
        },
        {
            key: "pdf_regions",
            label: "필기 수집 영역",
            status: input.hasProblemPdf && input.validation.pdfRegionCount === totalQuestions ? "ready" : "warning",
            value: `${input.validation.pdfRegionCount}/${totalQuestions}`,
            message: input.hasProblemPdf
                ? "문항별 PDF 영역이 많을수록 필기 수집과 문항 분석이 정확해집니다."
                : "문제지 PDF를 연결하면 문항별 필기 영역을 잡을 수 있습니다.",
        },
        {
            key: "metadata",
            label: "유형 태그",
            status: input.validation.taggedCount === totalQuestions ? "ready" : "warning",
            value: `${input.validation.taggedCount}/${totalQuestions}`,
            message: "라벨이나 개념 태그가 있어야 오답 유형 분석과 재추천 품질이 올라갑니다.",
        },
        {
            key: "distribution",
            label: "배포 설정",
            status: distributionBlocked ? "blocked" : input.accessConfig ? "ready" : "warning",
            value: distributionValue(input.accessConfig),
            message: distributionBlocked ? "배포 대상 또는 PIN 설정을 다시 확인해야 합니다." : distributionMessage(input.accessConfig),
        },
    ];

    const level: ExamServiceReadinessLevel = errors.length > 0
        ? "blocked"
        : items.some(item => item.status === "warning") || warnings.length > 0
            ? "warning"
            : "ready";

    return {
        level,
        label: level === "ready" ? "서비스 배포 가능" : level === "warning" ? "배포 가능 · 보강 권장" : "배포 전 수정 필요",
        detail: errors[0]?.message
            || warnings[0]?.message
            || "저장, 정답, PDF, 배포 설정이 운영 기준을 충족합니다.",
        canSaveDraft: titleReady && totalQuestions > 0 && !draftBlocked,
        canOpenDistribution: errors.length === 0,
        canPublish: errors.length === 0 && !!input.accessConfig && !distributionBlocked,
        blockingIssues: errors,
        warningIssues: warnings,
        items,
    };
}
