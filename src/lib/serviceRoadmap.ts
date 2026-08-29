export const QUESTION_DB_ROADMAP = {
    currentStage: "pdf_region",
    currentLabel: "PDF 영역 메타데이터",
    currentScope: "canonical ID, 유형 태그, 정답, 배점, PDF 영역 좌표로 오답/유형 분석을 먼저 안정화",
    nextStage: "image_asset",
    nextLabel: "문항 이미지 DB",
    nextScope: "프리미어 단계에서 원본 PDF 영역을 문항별 이미지로 커팅해 저장",
} as const;

export const PRIMARY_NOTIFICATION_CHANNEL = {
    key: "kakao",
    label: "카카오",
    status: "planned_primary",
    scope: "초대, 미응시 독려, 결과 안내의 1차 발송 채널",
} as const;

export const PAYMENT_PROVIDER_ROADMAP = [
    { key: "toss", label: "토스페이먼츠", priority: 1 },
    { key: "naver", label: "네이버페이", priority: 2 },
    { key: "kakao", label: "카카오페이", priority: 3 },
] as const;

export const PRODUCT_PRIORITY_ORDER = [
    { key: "exam_distribution", label: "시험 제작/배포", scope: "생성, PDF/OMR, 배포 링크, 접근 제어" },
    { key: "student_solving", label: "학생 풀이/필기 UX", scope: "태블릿 PDF 필기, OMR 사이드바, 자동 저장" },
    { key: "teacher_analytics", label: "관리자 분석", scope: "틀린 문제, 유형, 학생별/반별/시험별 리포트" },
    { key: "billing_auth", label: "결제/플랜/인증", scope: "학생 계정, Supabase 운영 전환, 결제 연동" },
] as const;

export const ANALYTICS_SEGMENTATION_ROADMAP = {
    primaryAxis: "region",
    primaryLabel: "지역",
    supervisorMode: "results_only",
    rolloutDepth: "intermediate_first",
    questionCuttingStage: "metadata_first_image_assets_later",
    axes: [
        { key: "region", label: "지역별", priority: 1 },
        { key: "student", label: "학생별", priority: 2 },
        { key: "class", label: "반별", priority: 3 },
        { key: "exam", label: "시험별", priority: 4 },
        { key: "question", label: "문항별", priority: 5 },
        { key: "type", label: "유형별", priority: 6 },
    ],
} as const;

export const RECOMMENDATION_ROADMAP = [
    { stage: 1, label: "약점 표시", scope: "틀린 문항과 유형을 학생별/반별로 정확히 묶어 보여주기" },
    { stage: 2, label: "추천 액션", scope: "복습 대상 유형, 재시험/보충 과제 후보를 제안하기" },
    { stage: 3, label: "고급 개인화", scope: "문항 이미지 DB와 장기 이력을 붙여 세밀한 추천으로 확장" },
] as const;

/**
 * Product-truth model for the premium learning loop.
 *
 * `available_if_data_ready` means the workflow is implemented, but the result
 * is only as useful as the answer key, question-result rows, stable student
 * identity, and teacher-authored tags behind it. In particular, a `similar`
 * retake currently reorganizes questions from the same exam; it is not a newly
 * generated or independently sourced similar question.
 */
export const PREMIUM_LEARNING_LOOP = [
    {
        key: "wrong_review",
        label: "오답 복습 목록",
        status: "available",
        promise: "학생 답, 정답, 미응답과 교사 피드백을 한곳에서 확인",
        requirement: "정답과 문항별 제출 결과",
    },
    {
        key: "weakness_type",
        label: "오답 유형 정리",
        status: "available_if_data_ready",
        promise: "오답을 개념·단원·스킬·오답 원인 태그 기준으로 묶어 우선순위 제시",
        requirement: "문항별 유형 태그와 신뢰 가능한 학생 식별자",
    },
    {
        key: "wrong_retake",
        label: "오답 다시 풀기",
        status: "available",
        promise: "원시험의 오답·미응답만 다시 풀고 회복 여부 확인",
        requirement: "원시험과 재시험 제출 기록 연결",
    },
    {
        key: "typed_retake",
        label: "유형별 오답 다시 풀기",
        status: "available_if_data_ready",
        promise: "같은 시험의 오답을 유형별로 묶어 재시험 범위 생성",
        requirement: "원시험 안의 유형 태그; 새 유사문항을 제공하는 기능은 아님",
    },
    {
        key: "new_similar_questions",
        label: "새 유사문항 추천",
        status: "planned",
        promise: "원문항과 다른 문제를 난도·개념·스킬 기준으로 추천",
        requirement: "사용 권한이 확인된 문항은행, 문항 이미지, 난도·출처·정답 메타데이터",
    },
    {
        key: "longitudinal_analysis",
        label: "누적 심화 분석",
        status: "available_if_data_ready",
        promise: "반복 약점, 원시험 추이, 재시험 회복을 학생·반 단위로 비교",
        requirement: "학생 계정/명단 연결, 여러 원시험, 동일 기준의 유형 태그",
    },
] as const;

export const ANALYSIS_EVIDENCE_THRESHOLDS = {
    minTaggedQuestionsPerType: 2,
    minOriginalAttemptsForTrend: 3,
    minResultsPerTypeForRepeatedWeakness: 6,
    minStudentsForClassPattern: 5,
    minAlternativeQuestionsForSimilarSet: 3,
} as const;

/**
 * Safe defaults for a low-friction academy recovery assignment. Teachers review
 * one compact proposal instead of configuring every student from scratch.
 * These are product defaults, not immutable grading rules.
 */
export const DEFAULT_RECOVERY_POLICY = {
    teacherApprovalRequired: true,
    includeWrong: true,
    includeUnanswered: true,
    autoAssignSlowCorrect: false,
    minMissedQuestionsForAutoCandidate: 2,
    maxQuestionsPerAssignment: 10,
    defaultDueInHours: 48,
    maxAttempts: 2,
    splitOversizedAssignments: true,
    revealAnswersAfterSubmission: true,
    escalationAfterUnrecoveredAttempts: 2,
} as const;

export const LOW_FRICTION_SERVICE_PRIORITIES = [
    {
        key: "one_click_recovery",
        label: "오늘의 오답 10문항",
        value: "very_high",
        effort: "low",
        userDecisionCount: 1,
        stage: "next",
        reuses: ["오답 문항", "재시험 링크", "회복률"],
    },
    {
        key: "exception_review",
        label: "예외만 확인",
        value: "very_high",
        effort: "low",
        userDecisionCount: 1,
        stage: "next",
        reuses: ["정답 누락", "태그 준비도", "학생 명단 연결"],
    },
    {
        key: "student_single_cta",
        label: "학생 오늘 할 보충",
        value: "high",
        effort: "low",
        userDecisionCount: 1,
        stage: "next",
        reuses: ["학생 대시보드", "미완료 과제", "복습 기록"],
    },
    {
        key: "recovery_traffic_light",
        label: "회복 신호등",
        value: "high",
        effort: "low",
        userDecisionCount: 0,
        stage: "next",
        reuses: ["회복", "미회복", "다시 틀림"],
    },
    {
        key: "deadline_queue",
        label: "마감·미완료 큐",
        value: "very_high",
        effort: "medium",
        userDecisionCount: 0,
        stage: "after_next",
        reuses: ["카카오 후보", "응시 상태", "학생 명단"],
    },
    {
        key: "counseling_card",
        label: "학부모 상담 1페이지",
        value: "high",
        effort: "low",
        userDecisionCount: 1,
        stage: "next",
        reuses: ["인쇄 리포트", "반복 약점", "재시험 회복"],
    },
    {
        key: "saved_policy",
        label: "반별 운영 템플릿",
        value: "medium",
        effort: "medium",
        userDecisionCount: 1,
        stage: "after_next",
        reuses: ["배정 반", "마감", "재시험 범위"],
    },
] as const;

export function formatPaymentProviderRoadmap(): string {
    return PAYMENT_PROVIDER_ROADMAP.map(provider => provider.label).join(" → ");
}
