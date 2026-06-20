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

export function formatPaymentProviderRoadmap(): string {
    return PAYMENT_PROVIDER_ROADMAP.map(provider => provider.label).join(" → ");
}
