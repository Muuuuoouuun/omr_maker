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
        expect(page).toContain('activeView === "handwriting" && handwritingArchiveEnabled && attempt?.handwritingArchived');
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

    it("renders the handwriting panel only for the handwriting tab", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(page).toContain('import HandwritingPanel from "@/components/teacher/student-results/HandwritingPanel"');
        expect(page).toContain('activeView === "handwriting" ? (');
        expect(page).toContain("<HandwritingPanel");
        expect(page).toContain(') : activeView === "report" ? (');
        expect(page).not.toContain('activeView === "handwriting" || activeView === "report"');
    });

    it("omits unloaded markup from report saves and directs teachers to the handwriting tab", () => {
        const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
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
        expect(page).toContain('buildStudentResultHref(attempt.id, "handwriting")');
        expect(page).toContain("필기 탭에서 원본 보기");
    });
});
