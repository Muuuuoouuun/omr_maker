import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

const textExtensions = new Set([".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".tsx"]);

const textSurfaceRoots = [
    "docs",
    "e2e",
    "examples",
    "src",
    "supabase",
];

const rootTextSurfaceFiles = [
    "README.md",
    "TASK.md",
    "TECHNICAL_SPECS.md",
    "eslint.config.mjs",
    "next.config.ts",
    "package.json",
    "playwright.config.ts",
    "playwright.production.config.ts",
    "tsconfig.json",
    "vitest.config.ts",
];

const broadScanExclusions = new Set([
    "src/lib/textEncodingSurface.test.ts",
]);

function toProjectPath(absolutePath: string): string {
    return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function listTextSurfaceFiles(relativeRoot: string): string[] {
    const absoluteRoot = path.join(rootDir, relativeRoot);
    const entries = readdirSync(absoluteRoot);
    const files: string[] = [];

    for (const entry of entries) {
        const absoluteEntry = path.join(absoluteRoot, entry);
        const relativeEntry = toProjectPath(absoluteEntry);
        const stats = statSync(absoluteEntry);
        if (stats.isDirectory()) {
            files.push(...listTextSurfaceFiles(relativeEntry));
            continue;
        }
        if (stats.isFile() && textExtensions.has(path.extname(entry)) && !broadScanExclusions.has(relativeEntry)) {
            files.push(relativeEntry);
        }
    }

    return files;
}

const broadTextSurfaceFiles = [
    ...rootTextSurfaceFiles,
    ...textSurfaceRoots.flatMap(listTextSurfaceFiles),
].sort();

const coreJourneyFiles = [
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
    "?쒗",
    "?좏",
    "?몄",
    "?ㅽ",
    "?댁",
    "?대",
    "?뺣",
    "?꾩",
    "?쒖",
    "?",
    "AI媛",
    "諛뷀깢",
    "濡쒓렇",
    "寃뚯뒪",
];

const requiredStringsByFile: Record<string, string[]> = {
    "src/app/page.tsx": [
        "교사 포털",
        "학생 포털",
        "아이디 또는 이메일",
        "학생번호 또는 이메일",
        "계정 ID처럼 사용합니다",
        "학생 계정 비밀번호처럼 쓰이는 6자리 코드입니다",
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
    it("keeps tracked source, docs, and e2e text surfaces free of common mojibake fragments", () => {
        for (const filePath of broadTextSurfaceFiles) {
            const content = readProjectFile(filePath);

            for (const fragment of mojibakeFragments) {
                expect(content, `${filePath} contains mojibake fragment ${JSON.stringify(fragment)}`).not.toContain(fragment);
            }
        }
    });

    it("keeps core Korean and English UI copy readable across the main journey", () => {
        for (const filePath of coreJourneyFiles) {
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
