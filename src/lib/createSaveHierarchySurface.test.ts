import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/app/create/page.tsx"), "utf8");
const answerImportSource = readFileSync(join(process.cwd(), "src/components/AnswerImportModal.tsx"), "utf8");

describe("create save and publish hierarchy", () => {
    it("offers an explicit recoverable draft save before distribution", () => {
        expect(source).toContain("const handleSaveDraftNow = async () => {");
        expect(source).toContain('saveFileDataUrl(`${draftStorageKey}:problemPdf`, currentProblemPdf)');
        expect(source).toContain('saveFileDataUrl(`${draftStorageKey}:answerKeyPdf`, currentAnswerKeyPdf)');
        expect(source).toContain("restoreDraftPdfAssets(snap)");
        expect(source).toContain("localStorage.setItem(draftStorageKey, JSON.stringify(draft))");
        expect(source).toContain('"초안 저장 완료"');
        expect(source).toContain("초안 저장");
    });

    it("serializes both draft PDF restore and draft PDF persistence for iPad memory", () => {
        const restore = source.slice(
            source.indexOf("const restoreDraftPdfAssets = async"),
            source.indexOf("const handleConfirmCancel = async"),
        );
        const save = source.slice(
            source.indexOf("const handleSaveDraftNow = async"),
            source.indexOf("return (", source.indexOf("const handleSaveDraftNow = async")),
        );
        expect(restore).not.toContain("Promise.all(");
        expect(save).not.toContain("Promise.all(");
        expect(restore.indexOf('resolveDraftFile("problem.pdf"')).toBeLessThan(
            restore.indexOf('resolveDraftFile("answer_key.pdf"'),
        );
        expect(save.indexOf(":problemPdf")).toBeLessThan(save.indexOf(":answerKeyPdf"));
    });

    it("clears only the failed PDF hydration gate when that asset is replaced", () => {
        expect(source).toContain("assetHydrationFailures.problem");
        expect(source).toContain("assetHydrationFailures.answer");
        expect(source).toContain("problem: false");
        expect(source).toContain("answer: false");
    });

    it("never reads, writes, or deletes an unscoped shared teacher draft", () => {
        expect(source).toContain("scopedExamDraftStorageKey(");
        expect(source).toContain("if (!draftStorageKey) return");
        expect(source).not.toContain("const draftStorageKey = examDraftStorageKey(editId)");
        expect(source).not.toContain("tryAcquireNewExamPublishLock");
        expect(source).not.toContain("releaseNewExamPublishLock");
    });

    it("fails closed before every restore, autosave, manual save, delete, and publish boundary", () => {
        const newRestore = source.slice(
            source.indexOf("Draft restore on mount"),
            source.indexOf("Draft restore in edit mode"),
        );
        const editRestore = source.slice(
            source.indexOf("Draft restore in edit mode"),
            source.indexOf("Mark hydration so autosave"),
        );
        const autosave = source.slice(
            source.indexOf("Autosave draft every"),
            source.indexOf("Warn before leaving edit mode"),
        );
        const publish = source.slice(
            source.indexOf("const handleShareConfig = async"),
            source.indexOf("const performShareConfig = async"),
        );
        const discard = source.slice(
            source.indexOf("const handleConfirmCancel = async"),
            source.indexOf("const handleConfirmDismiss ="),
        );
        const manualSave = source.slice(
            source.indexOf("const handleSaveDraftNow = async"),
            source.indexOf("const handleOpenDistribution ="),
        );

        expect(newRestore).toContain("if (!draftStorageKey) return;");
        expect(editRestore).toContain("if (!draftStorageKey) return;");
        expect(autosave).toContain("if (!draftStorageKey) return;");
        expect(discard).toContain("if (!draftStorageKey) return;");
        expect(publish).toContain("if (!draftStorageKey) {");
        expect(manualSave).toContain("if (!draftStorageKey) {");
        expect(publish).toContain("안전한 배포 잠금 필요");
        expect(publish).not.toContain("requiresCanonicalReservation");
    });

    it("holds an exclusive browser lock around target creation and canonical publish", () => {
        const lock = source.indexOf("await withExclusiveExamPublishLock(");
        const target = source.indexOf("getOrCreateNewExamPublishTarget(");
        const save = source.indexOf("await saveTeacherCanonicalExam(examData)");
        expect(lock).toBeGreaterThan(-1);
        expect(target).toBeGreaterThan(lock);
        expect(save).toBeGreaterThan(target);
    });

    it("cleans scoped IndexedDB draft assets on discard, replacement, and successful publish", () => {
        expect(source).toContain("deleteScopedDraftPdfAssets({");
        expect(source).toContain("deleteStoredData,");
        expect(source).toContain("preserve: assets,");
        expect(source).toContain(":cleanupPending`");
        expect(source).toContain("cleanup.failed > 0");
        expect(source).toContain("PDF 임시 파일을 삭제하지 못했습니다");
        expect(source).toContain("setDraftCleanupRetryGeneration(previous => previous + 1)");
        const publishCleanup = source.indexOf("await deleteCurrentDraftPdfAssets(");
        const bodyRemoval = source.indexOf("localStore.removeItem(draftStorageKey)", publishCleanup);
        expect(publishCleanup).toBeGreaterThan(-1);
        expect(bodyRemoval).toBeGreaterThan(publishCleanup);
    });

    it("resets A editor state before loading B and refuses a mismatched loaded exam", () => {
        const editEffect = source.slice(
            source.indexOf("// Load exam from localStorage"),
            source.indexOf("// Initialize questions when count changes"),
        );
        const load = editEffect.indexOf("loadTeacherCanonicalExam(editId)");
        for (const reset of [
            "setLoadedExam(null)",
            "setLoadedExamIsCanonical(false)",
            "problemPdfFileRef.current = null",
            "answerKeyPdfFileRef.current = null",
            "setPdfFile(null)",
            "setAnswerKeyPdf(null)",
            "setIsDistributeModalOpen(false)",
            "setAssetHydrationFailures({ problem: false, answer: false })",
            "editDraftPromptedRef.current = false",
        ]) {
            expect(editEffect.indexOf(reset)).toBeGreaterThan(-1);
            expect(editEffect.indexOf(reset)).toBeLessThan(load);
        }
        expect(source).toContain("!isLoadedExamCurrentForEdit(editId, loadedExam)");
        expect(source).toContain("isDistributeModalOpen && isLoadedExamCurrentForEdit(editId, loadedExam)");
        expect(source).toContain("key={editorDraftSlot}");
    });

    it("clears every route-owned editor input before B can reuse A interaction state", () => {
        const editEffect = source.slice(
            source.indexOf("// Load exam from localStorage"),
            source.indexOf("const loadExistingExam = async"),
        );
        for (const reset of [
            "setIsSaving(false)",
            "setIsAdvancedDesignOpen(false)",
            "setIsSubQuestionOpen(false)",
            "setBulkSubQuestionId(null)",
            "setSubQuestionBatchTarget('all')",
            "setSubQuestionBatchRange({ start: 1, end: routeDefaults.questions })",
            "setSubQuestionSpecific('')",
            "setSelectedQuestionId(null)",
            'setCustomLabel("")',
            "setLabelBatch({",
            'setFastAnswer("")',
            "setActiveViewTab('problem')",
            "setActiveResizer(null)",
            "pendingPdfReadyToastRef.current = null",
            "distributeTriggerRef.current = null",
        ]) {
            expect(editEffect).toContain(reset);
        }
        expect(editEffect).toContain("start: 1");
        expect(editEffect).toContain("end: routeDefaults.questions");
        expect(editEffect).toContain('label: ""');
        expect(editEffect).toContain('unit: ""');
        expect(editEffect).toContain('concept: ""');
        expect(editEffect).toContain('difficulty: ""');
        expect(source).toContain('const [fastAnswerState, setFastAnswerState] = useState({ slot: editorDraftSlot, value: "" });');
        expect(source).toContain('const fastAnswer = fastAnswerState.slot === editorDraftSlot ? fastAnswerState.value : "";');
        expect(source).toContain("setFastAnswerState({ slot: editorDraftSlot, value });");
    });

    it("fences delayed A file, image, draft, and publish completions from B state", () => {
        expect(source).toContain('import { createEditorRouteGenerationController } from "@/lib/editorRouteGeneration";');
        expect(source).toContain("const editorRouteStateRef = useRef(createEditorRouteGenerationController(editorDraftSlot));");
        expect(source).toContain("useLayoutEffect(() => {");
        expect(source).toContain("editorRouteStateRef.current.commit(editorDraftSlot);");

        const loadExam = source.slice(
            source.indexOf("const loadExistingExam = async"),
            source.indexOf("// Initialize questions when count changes"),
        );
        expect(loadExam).toContain("if (!cancelled && isCurrentRoute()) {");
        expect(loadExam).toContain("toast.error('시험을 찾을 수 없습니다', editId);");

        const cleanupRetry = source.slice(
            source.indexOf("useEffect(() => {", source.indexOf("const deleteCurrentDraftPdfAssets")),
            source.indexOf("// ─── Draft restore on mount"),
        );
        expect(cleanupRetry).toContain("const routeGeneration = editorRouteStateRef.current.generation()");
        expect(cleanupRetry).toContain("if (cancelled || !isEditorRouteGenerationCurrent(routeGeneration)) return;");

        const problemPdf = source.slice(
            source.indexOf("const handleProblemPdfFile = async"),
            source.indexOf("const handleAnswerKeyPdfFile = async"),
        );
        expect(problemPdf).toContain("const routeGeneration = editorRouteStateRef.current.generation()");
        expect(problemPdf).toContain("if (!isEditorRouteGenerationCurrent(routeGeneration)) return false;");

        const saveImage = source.slice(
            source.indexOf("const handleSaveImage = async"),
            source.indexOf("const handleSaveDraftNow = async"),
        );
        expect(saveImage).toContain("const routeGeneration = editorRouteStateRef.current.generation()");
        expect(saveImage).toContain("if (!isEditorRouteGenerationCurrent(routeGeneration)) return;");
        expect(saveImage).toContain("if (isEditorRouteGenerationCurrent(routeGeneration)) setIsSaving(false);");

        const saveDraft = source.slice(
            source.indexOf("const handleSaveDraftNow = async"),
            source.indexOf("const handleOpenDistribution ="),
        );
        const firstAwait = saveDraft.indexOf("await ");
        for (const snapshot of [
            "const routeGeneration = editorRouteStateRef.current.generation()",
            "const previousAssets = draftAssetsRef.current",
            "const currentProblemPdf = problemPdfFileRef.current",
            "const currentAnswerKeyPdf = answerKeyPdfFileRef.current",
        ]) {
            expect(saveDraft.indexOf(snapshot)).toBeGreaterThan(-1);
            expect(saveDraft.indexOf(snapshot)).toBeLessThan(firstAwait);
        }
        expect(saveDraft).toContain("if (isEditorRouteGenerationCurrent(routeGeneration)) {");

        const publish = source.slice(
            source.indexOf("const performShareConfig = async"),
            source.indexOf("const applyImportedAnswers ="),
        );
        const share = source.slice(
            source.indexOf("const handleShareConfig = async"),
            source.indexOf("const applyImportedAnswers ="),
        );
        expect(share).toContain("const routeGeneration = editorRouteStateRef.current.generation()");
        expect(share).toContain("performShareConfig(accessConfig, routeGeneration)");
        expect(publish).toContain("routeGeneration: number");
        expect(publish).toContain("const publishDraftAssets = draftAssetsRef.current");
        const firstPublishAwait = publish.indexOf("await ");
        for (const snapshot of [
            "const publishDraftAssets = draftAssetsRef.current",
            "const currentProblemPdf = problemPdfFileRef.current",
            "const currentAnswerKeyPdf = answerKeyPdfFileRef.current",
            "const problemPdfWasReplaced = problemPdfReplacedRef.current",
            "const answerKeyPdfWasReplaced = answerKeyPdfReplacedRef.current",
        ]) {
            expect(publish.indexOf(snapshot)).toBeGreaterThan(-1);
            expect(publish.indexOf(snapshot)).toBeLessThan(firstPublishAwait);
        }
        const canonicalWrite = publish.indexOf("await saveTeacherCanonicalExam(examData)");
        const loadedExamWrite = publish.indexOf("setLoadedExam(persistedExam)");
        const routeFence = publish.lastIndexOf("if (isEditorRouteGenerationCurrent(routeGeneration)) {", loadedExamWrite);
        expect(canonicalWrite).toBeGreaterThan(-1);
        expect(routeFence).toBeGreaterThan(canonicalWrite);
        expect(loadedExamWrite).toBeGreaterThan(routeFence);
    });

    it("gives draft restore a newer generation than an in-flight edit hydration", () => {
        const restore = source.slice(
            source.indexOf("const restoreDraftPdfAssets = async"),
            source.indexOf("const handleConfirmCancel = async"),
        );
        expect(restore).toContain("const runGeneration = ++assetHydrationGenerationRef.current");
        expect(restore).toContain("mergePdfHydrationFailures(previous");
    });

    it("keeps the current draft intact when the canonical revision conflicts", () => {
        const publish = source.slice(
            source.indexOf("const performShareConfig = async"),
            source.indexOf("const applyImportedAnswers ="),
        );
        const conflict = publish.indexOf('if (serverSave.status === "conflict")');
        const fallback = publish.indexOf("const persistedExam =");
        expect(conflict).toBeGreaterThan(-1);
        expect(conflict).toBeLessThan(fallback);
        const nextStatusBranch = publish.indexOf('if (serverSave.status === "service_unavailable")', conflict);
        const branch = publish.slice(conflict, nextStatusBranch);
        expect(branch).toContain("현재 편집 내용과 자동 저장 초안은 그대로 유지됩니다");
        expect(branch).toContain("새로고침해 서버본과 비교하거나 복제본으로 저장해주세요");
        expect(branch).not.toContain("rollbackNewExamPublish");
        expect(branch).not.toContain("saveExam(");
    });

    it("aborts and fences A auto-detection before B editor state is loaded", () => {
        const editEffect = source.slice(
            source.indexOf("// Load exam from localStorage"),
            source.indexOf("// Initialize questions when count changes"),
        );
        expect(editEffect).toContain("autoDetectGenerationRef.current += 1");
        expect(editEffect).toContain("activeAutoDetect.abortController.abort()");
        const autoDetect = source.slice(
            source.indexOf("const handleAutoDetectLocations = async"),
            source.indexOf("const handleShareConfig = async"),
        );
        expect(autoDetect).toContain("shouldApplyAutoDetectOutcome({");
        expect(autoDetect.indexOf("shouldApplyAutoDetectOutcome({")).toBeLessThan(autoDetect.indexOf("setQuestions(matchedQuestions)"));
    });

    it("retries cleanupPending before a second save and never clears a failed marker", () => {
        const saveDraft = source.slice(
            source.indexOf("const handleSaveDraftNow = async"),
            source.indexOf("const handleOpenDistribution ="),
        );
        const retry = saveDraft.indexOf("await retryPendingScopedDraftPdfCleanup({");
        const failed = saveDraft.indexOf('pendingCleanup.status === "failed"');
        const saveBlob = saveDraft.indexOf("await saveFileDataUrl(");
        expect(retry).toBeGreaterThan(-1);
        expect(failed).toBeGreaterThan(retry);
        expect(saveBlob).toBeGreaterThan(failed);
        expect(saveDraft.slice(failed, saveBlob)).toContain("return;");
    });

    it("unmounts A answer import state before B can receive its answers or PDF", () => {
        const editEffect = source.slice(
            source.indexOf("// Load exam from localStorage"),
            source.indexOf("// Initialize questions when count changes"),
        );
        expect(editEffect).toContain("setIsImportModalOpen(false)");
        const importModal = source.slice(
            source.indexOf("{isImportModalOpen"),
            source.indexOf("{isDistributeModalOpen"),
        );
        expect(importModal).toContain("isLoadedExamCurrentForEdit(editId, loadedExam)");
        expect(importModal).toContain("key={editorDraftSlot}");
        expect(answerImportSource).toContain("analysisRunRef.current += 1");
        expect(answerImportSource).toContain("if (analysisRun !== analysisRunRef.current) return;");
    });

    it("keeps answer import inert until route-owned editor defaults are ready", () => {
        const label = 'aria-label="정답 인식 마법사 열기"';
        const labelIndex = source.indexOf(label);
        const trigger = source.slice(
            source.lastIndexOf("<button", labelIndex),
            source.indexOf("</button>", labelIndex),
        );
        expect(trigger).toContain("disabled={!initialDefaultsReady}");
    });

    it("keeps the mobile completion bar focused on draft safety and distribution", () => {
        const mobileActions = source.slice(source.indexOf('className="create-primary-actions create-primary-actions--mobile"'));
        expect(mobileActions).toContain("저장하고 배포하기");
        expect(mobileActions).toContain("handleSaveDraftNow");
        expect(mobileActions).not.toContain("handleSaveImage");
    });
});
