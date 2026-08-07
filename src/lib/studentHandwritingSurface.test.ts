import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("student handwriting result surface", () => {
    it("loads the PDF and archived drawings only from the handwriting branch", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const initialLoad = page.slice(
            page.indexOf("const loadTeacherAttempt = async () =>"),
            page.indexOf("void loadTeacherAttempt();"),
        );

        expect(page).toContain("async function loadTeacherPdfFile(exam: Exam)");
        expect(page).toContain("async function loadAttemptDrawings(attempt: Attempt)");
        expect(initialLoad).not.toContain("loadTeacherPdfFile(");
        expect(initialLoad).not.toContain("loadAttemptDrawings(");
        expect(initialLoad).not.toContain("storedDataUrlToFile(");
        expect(initialLoad).not.toContain("getTeacherRemoteAssetUrl(");
        expect(initialLoad).not.toContain("loadFeedbackMarkupDrawings(");
        expect(page).toContain('activeView === "handwriting" && (handwritingArchiveEnabled || feedback?.status === "returned") && attempt?.handwritingArchived');
        expect(page).toContain("void loadHandwritingResources()");
    });

    it("guards lazy handwriting results against a stale attempt route", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const lazyLoad = page.slice(
            page.indexOf("const loadHandwritingResources"),
            page.indexOf("const analytics = useMemo"),
        );

        expect(lazyLoad).toContain("const targetAttemptId = attempt.id");
        expect(lazyLoad).toContain("handwritingLoadingAttemptRef.current === targetAttemptId");
        expect(lazyLoad).toContain("handwritingLoadingAttemptRef.current = targetAttemptId");
        expect(lazyLoad).toContain("activeAttemptIdRef.current !== targetAttemptId");
        expect(lazyLoad).toContain('setHandwritingStatus("loading")');
        expect(lazyLoad).toContain("const drawingsReady = restored !== undefined");
        expect(lazyLoad).toContain("loadFeedbackMarkupDrawings(feedback)");
        expect(lazyLoad).toContain("if (file && drawingsReady) {");
        expect(lazyLoad).toContain('setHandwritingStatus("ready")');
        expect(lazyLoad).toContain('setHandwritingStatus("error")');
        expect(page).toContain('const [handwritingStatus, setHandwritingStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")');
        expect(page).toContain('setHandwritingStatus("idle")');
        expect(page).toContain("handwritingLoadingAttemptRef.current = null");
    });

    it("renders separate locked, empty, loading, and retryable error states", () => {
        const panel = readProjectFile("src/components/teacher/student-results/HandwritingPanel.tsx");

        expect(panel).toContain("<LockedFeaturePanel");
        expect(panel).toContain('title="학생 필기 보관"');
        expect(panel).toContain('description="Pro 이상에서는 이후 제출부터 PDF 필기를 자동으로 보관합니다."');
        expect(panel).toContain('title="저장된 필기가 없습니다"');
        expect(panel).toContain('description="이 제출에는 보관된 필기 원본이 없습니다."');
        expect(panel).toContain('title="필기 원본을 불러오지 못했습니다"');
        expect(panel).toContain('role="status"');
        expect(panel).toContain('role="alert"');
        expect(panel).toContain("onClick={onRetry}");
        expect(panel).toContain("다시 시도");
        expect(panel).toContain("const canShowReviewPdf = !!pdfFile;");
    });

    it("labels the archived plan as the plan captured when the submission was made", () => {
        const panel = readProjectFile("src/components/teacher/student-results/HandwritingPanel.tsx");

        expect(panel).toContain("제출 당시 보관 플랜:");
    });

    it("keeps core text feedback editable after downgrade while markup stays premium", () => {
        const panel = readProjectFile("src/components/teacher/student-results/HandwritingPanel.tsx");
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(panel).toContain("const feedbackReturned = feedback?.status === \"returned\"");
        expect(panel).toContain("feedbackMarkupEnabled: boolean");
        expect(panel).toContain("const canEditFeedbackMarkup = feedbackMarkupEnabled && feedbackViewMode === \"markup\"");
        expect(panel).toContain("전체 피드백");
        expect(panel).toContain("초안 저장");
        expect(panel).toContain("학생에게 반환");
        expect(panel).toContain("교사 첨삭과 첨삭 PDF 다운로드는 Pro 이상에서 사용할 수 있습니다.");
        expect(panel).toContain("disabled={!feedbackMarkupEnabled}");
        expect(panel).toContain("feedbackSummary");
        expect(panel).toContain("hasStudentDrawings && handwritingArchiveEnabled");
        expect(page).toContain('feedback?.status === "returned"');
        expect(page).toContain("if (!attempt) return;");
        expect(page).toContain("feedbackMarkupEnabled");
        expect(page).toContain("feedbackMarkupEnabled && handwritingStatus === \"ready\"");
        expect(page).not.toContain("if (!attempt || !feedbackEnabled) return;");
        expect(page).not.toContain("remoteError?.includes(\"기존 반환본\")");
    });

    it("renders the handwriting panel only for the handwriting tab", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(page).toContain('import HandwritingPanel from "@/components/teacher/student-results/HandwritingPanel"');
        expect(page).toContain('activeView === "handwriting" ? (');
        expect(page).toContain("<HandwritingPanel");
        expect(page).toContain(') : activeView === "report" ? (');
        expect(page).not.toContain('activeView === "handwriting" || activeView === "report"');
    });

    it("omits unloaded markup from saves and keeps handwriting discoverable in the result tabs", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const tabs = readProjectFile("src/components/teacher/student-results/StudentResultTabs.tsx");
        const saveFeedback = page.slice(
            page.indexOf("const saveFeedback = async"),
            page.indexOf("if (accessDenied)"),
        );

        expect(page).toContain("const handwritingReadyAttemptIdRef = useRef<string | null>(null)");
        expect(page).toContain("handwritingReadyAttemptIdRef.current = targetAttemptId");
        expect(saveFeedback).toContain("const markupDrawingsForSave =");
        expect(saveFeedback).toContain('handwritingStatus === "ready"');
        expect(saveFeedback).toContain("handwritingReadyAttemptIdRef.current === targetAttemptId");
        expect(saveFeedback).toContain("activeAttemptIdRef.current === targetAttemptId");
        expect(saveFeedback).toContain("? teacherMarkupDrawings");
        expect(saveFeedback).toContain(": undefined;");
        expect(saveFeedback).toContain("saveTeacherAttemptFeedbackDraft(nextFeedback, markupDrawingsForSave)");
        expect(page).not.toContain("문제 PDF 또는 필기 데이터를 불러오는 중입니다.");
        expect(page).toContain("<StudentResultTabs");
        expect(tabs).toContain('{ view: "handwriting", label: "필기"');
    });
});
