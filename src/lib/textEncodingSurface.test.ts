import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

const userFacingFiles = [
    "src/app/page.tsx",
    "src/app/create/page.tsx",
    "src/app/solve/[id]/page.tsx",
    "src/app/student/dashboard/page.tsx",
    "src/app/student/review/[attemptId]/page.tsx",
    "src/components/dashboard/AssignmentBlock.tsx",
    "src/app/teacher/dashboard/page.tsx",
    "src/components/dashboard/tabs/OverviewTab.tsx",
    "src/components/dashboard/tabs/ExamAnalyticsTab.tsx",
    "src/components/dashboard/tabs/StudentAnalyticsTab.tsx",
    "e2e/full-journey.spec.ts",
];

const mojibakeFragments = [
    "�",
    "Ã",
    "Â",
    "â€",
    "ì„",
    "í•",
    "ê°",
    "ë",
    "ðŸ",
];

const requiredStringsByFile: Record<string, string[]> = {
    "src/app/page.tsx": [
        "교사 포털",
        "학생 포털",
        "아이디 또는 이메일",
        "학생번호 또는 이메일",
        "대시보드 입장",
        "동명이인이 있습니다",
    ],
    "src/app/create/page.tsx": [
        "Smart Editor",
        "배포하기",
        "인쇄용 (A4)",
        "OMR 미리보기 접기",
    ],
    "src/app/solve/[id]/page.tsx": [
        "시험 PIN 확인",
        "답안 제출",
        "OMR 답안",
        "답안지 펼치기",
        "모든 문제 표기 완료",
    ],
    "src/app/student/dashboard/page.tsx": [
        "학생 로그인",
        "연결하지 않은 게스트 기록",
        "완료한 원시험",
    ],
    "src/components/dashboard/AssignmentBlock.tsx": [
        "미완료 과제",
        "완료 기록",
        "모든 과제를 완료했습니다!",
        "시작",
        "복습",
    ],
    "src/app/student/review/[attemptId]/page.tsx": [
        "결과 리포트",
        "목록으로",
        "응시 완료",
        "필기 보관",
    ],
    "src/app/teacher/dashboard/page.tsx": [
        "Analytics Center",
        "시험 분석",
        "학생 성취도",
        "데모 데이터 모드",
    ],
    "src/components/dashboard/tabs/OverviewTab.tsx": [
        "Quick Action",
        "통계 CSV",
        "통계 CSV 생성됨",
        "대시보드 요약과 시험별 통계를 내보냈습니다.",
    ],
    "src/components/dashboard/tabs/ExamAnalyticsTab.tsx": [
        "학생별 점수 및 성취도",
        "정오표(CSV)",
        "시험 분석 지역 필터",
        "카카오 후보 검토",
    ],
    "src/components/dashboard/tabs/StudentAnalyticsTab.tsx": [
        "분석할 학생 선택",
        "학생별 액션 잠금",
        "세부 시험 분석 내역",
    ],
    "e2e/full-journey.spec.ts": [
        "E2E 국어 통합 시험",
        "김학생",
        "답안지 펼치기 · 0/3 · 미답 3개",
    ],
};

describe("text encoding surface", () => {
    it("keeps core Korean and English UI copy readable across the main journey", () => {
        for (const filePath of userFacingFiles) {
            const content = readProjectFile(filePath);

            for (const fragment of mojibakeFragments) {
                expect(content, `${filePath} contains mojibake fragment ${JSON.stringify(fragment)}`).not.toContain(fragment);
            }

            for (const expected of requiredStringsByFile[filePath] || []) {
                expect(content, `${filePath} lost required UI copy ${JSON.stringify(expected)}`).toContain(expected);
            }
        }
    });
});
