import { describe, expect, it } from "vitest";
import {
    clearNewExamPublishTarget,
    discardNewExamPublishTarget,
    getOrCreateNewExamPublishTarget,
    getOrCreatePdfUploadAttemptNonce,
    isEditDraftNewerThanExam,
    isLoadedExamCurrentForEdit,
    mergePdfHydrationFailures,
    rotatePdfUploadAttemptNonce,
    resolveExamEditorLoad,
    resolvePdfHydrationPairSequentially,
    safeBrowserStorage,
    scopedExamDraftStorageKey,
    shouldApplyAutoDetectOutcome,
    shouldApplyPdfHydrationOutcome,
    withExclusiveExamPublishLock,
    runPdfAssetUploadsSequentially,
    shouldUploadExamPdf,
} from "./createPageHelpers";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

describe("scopedExamDraftStorageKey", () => {
    it("isolates draft bodies and PDF blob keys by organization, actor, and editor slot", () => {
        const teacherA = scopedExamDraftStorageKey(null, "org-1", "teacher-a");
        const teacherB = scopedExamDraftStorageKey(null, "org-1", "teacher-b");
        const otherOrg = scopedExamDraftStorageKey(null, "org-2", "teacher-a");
        const editing = scopedExamDraftStorageKey("exam-1", "org-1", "teacher-a");

        expect(new Set([teacherA, teacherB, otherOrg, editing])).toHaveLength(4);
        expect(teacherA).not.toBe("omr_exam_draft");
        expect(teacherA).toContain(":workspace:org-1:teacher-a:new");
        expect(editing).toContain(":workspace:org-1:teacher-a:exam:exam-1");
        expect(`${teacherA}:problemPdf`).not.toBe(`${teacherB}:problemPdf`);
        expect(`${teacherA}:answerKeyPdf`).not.toBe(`${teacherB}:answerKeyPdf`);
    });

    it("fails closed instead of falling back to an unsafe shared draft key", () => {
        expect(() => scopedExamDraftStorageKey(null, "", "teacher-a")).toThrow("scope");
        expect(() => scopedExamDraftStorageKey(null, "org-1", "")).toThrow("scope");
        expect(() => scopedExamDraftStorageKey("unsafe/edit", "org-1", "teacher-a")).toThrow("scope");
    });

    it("never looks up or deletes another account's draft, PDFs, or publish target", async () => {
        const storage = memoryStorage();
        const teacherA = scopedExamDraftStorageKey(null, "org-1", "teacher-a");
        const teacherB = scopedExamDraftStorageKey(null, "org-1", "teacher-b");
        storage.setItem(teacherA, "teacher-a-draft");
        storage.setItem(`${teacherA}:problemPdf`, "teacher-a-problem");
        storage.setItem(`${teacherA}:answerKeyPdf`, "teacher-a-answer");
        const teacherATarget = getOrCreateNewExamPublishTarget(storage, teacherA, () => "teacher-a-target");
        getOrCreateNewExamPublishTarget(storage, teacherB, () => "teacher-b-target");

        expect(storage.getItem(teacherB)).toBeNull();
        expect(storage.getItem(`${teacherB}:problemPdf`)).toBeNull();
        expect(storage.getItem(`${teacherB}:answerKeyPdf`)).toBeNull();
        storage.removeItem(teacherB);
        storage.removeItem(`${teacherB}:problemPdf`);
        storage.removeItem(`${teacherB}:answerKeyPdf`);
        await discardNewExamPublishTarget(storage, teacherB, async () => undefined);

        expect(storage.getItem(teacherA)).toBe("teacher-a-draft");
        expect(storage.getItem(`${teacherA}:problemPdf`)).toBe("teacher-a-problem");
        expect(storage.getItem(`${teacherA}:answerKeyPdf`)).toBe("teacher-a-answer");
        expect(getOrCreateNewExamPublishTarget(storage, teacherA, () => "unexpected"))
            .toBe(teacherATarget);
    });
});

describe("resolveExamEditorLoad", () => {
    it("imports one organization-scoped browser exam only after an authoritative not-found", async () => {
        const browserExam = { id: "legacy-exam", organizationId: "org-1" };
        const readBrowserOnly = async (id: string) => id === browserExam.id ? browserExam : null;

        await expect(resolveExamEditorLoad(
            { status: "not_found" },
            browserExam.id,
            "org-1",
            readBrowserOnly,
        )).resolves.toEqual({ exam: browserExam, canonical: false, source: "browser_import" });
    });

    it("never masks an authorization or service failure with browser data", async () => {
        let reads = 0;
        const readBrowserOnly = async () => {
            reads += 1;
            return { id: "legacy-exam", organizationId: "org-1" };
        };

        await expect(resolveExamEditorLoad(
            { status: "unauthorized" },
            "legacy-exam",
            "org-1",
            readBrowserOnly,
        )).resolves.toBeNull();
        await expect(resolveExamEditorLoad(
            { status: "service_unavailable" },
            "legacy-exam",
            "org-1",
            readBrowserOnly,
        )).resolves.toBeNull();
        await expect(resolveExamEditorLoad(
            { status: "local_only" },
            "legacy-exam",
            "org-1",
            readBrowserOnly,
        )).resolves.toBeNull();
        expect(reads).toBe(0);
    });

    it("rejects a browser import when active organization scope is missing or mismatched", async () => {
        const readBrowserOnly = async () => ({ id: "legacy-exam", organizationId: "org-1" });

        await expect(resolveExamEditorLoad(
            { status: "not_found" },
            "legacy-exam",
            "",
            readBrowserOnly,
        )).resolves.toBeNull();
        await expect(resolveExamEditorLoad(
            { status: "not_found" },
            "legacy-exam",
            "org-2",
            readBrowserOnly,
        )).resolves.toBeNull();
    });
});

describe("new exam publish retry identity", () => {
    it("persists one target id per tab draft until a confirmed save clears it", () => {
        const storage = memoryStorage();
        let sequence = 0;
        const mint = () => `exam-target-${++sequence}`;
        const first = getOrCreateNewExamPublishTarget(storage, "omr_exam_draft", mint);
        const responseLossRetry = getOrCreateNewExamPublishTarget(storage, "omr_exam_draft", mint);
        expect(responseLossRetry).toBe(first);
        expect(sequence).toBe(1);

        clearNewExamPublishTarget(storage, "omr_exam_draft");
        expect(getOrCreateNewExamPublishTarget(storage, "omr_exam_draft", mint)).not.toBe(first);
    });

    it("keeps one volatile publish target when per-tab storage is blocked", () => {
        const blocked = {
            getItem() { throw new Error("blocked"); },
            setItem() { throw new Error("blocked"); },
            removeItem() { throw new Error("blocked"); },
        };
        let sequence = 0;
        const mint = () => `exam-target-${++sequence}`;
        const first = getOrCreateNewExamPublishTarget(blocked, "omr_exam_draft", mint);

        expect(getOrCreateNewExamPublishTarget(blocked, "omr_exam_draft", mint)).toBe(first);
        expect(sequence).toBe(1);
        clearNewExamPublishTarget(blocked, "omr_exam_draft");
        expect(getOrCreateNewExamPublishTarget(blocked, "omr_exam_draft", mint)).not.toBe(first);
    });

    it("falls back safely when the browser storage getter itself throws", () => {
        let sequence = 0;
        const storage = safeBrowserStorage(() => {
            throw new Error("SecurityError reading sessionStorage");
        });
        const first = getOrCreateNewExamPublishTarget(
            storage,
            "omr_exam_draft",
            () => `exam-target-${++sequence}`,
        );

        expect(getOrCreateNewExamPublishTarget(
            safeBrowserStorage(() => { throw new Error("blocked"); }),
            "omr_exam_draft",
            () => `exam-target-${++sequence}`,
        )).toBe(first);
        expect(sequence).toBe(1);
    });

    it("runs target creation and publishing inside one exclusive browser lock", async () => {
        let held = false;
        const locks = {
            async request<T>(
                name: string,
                _options: { mode: "exclusive"; ifAvailable: true },
                callback: (lock: { name: string } | null) => Promise<T> | T,
            ): Promise<T> {
                if (held) return callback(null);
                held = true;
                try {
                    return await callback({ name });
                } finally {
                    held = false;
                }
            },
        };
        const storage = memoryStorage();
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let firstStarted!: () => void;
        const started = new Promise<void>(resolve => { firstStarted = resolve; });
        const minted: string[] = [];
        const publish = async () => {
            const target = getOrCreateNewExamPublishTarget(storage, "scoped-draft", () => {
                const id = `exam-target-${minted.length + 1}`;
                minted.push(id);
                return id;
            });
            firstStarted();
            await firstGate;
            return target;
        };

        const first = withExclusiveExamPublishLock(locks, "scoped-draft", publish);
        await started;
        const second = await withExclusiveExamPublishLock(locks, "scoped-draft", publish);
        expect(second).toEqual({ status: "busy" });
        releaseFirst();
        await expect(first).resolves.toEqual({ status: "acquired", value: "exam-target-1" });
        expect(minted).toEqual(["exam-target-1"]);
    });

    it("fails closed when the browser has no exclusive lock manager", async () => {
        let ran = false;
        await expect(withExclusiveExamPublishLock(null, "scoped-draft", async () => {
            ran = true;
            return "unsafe";
        })).resolves.toEqual({ status: "unsupported" });
        expect(ran).toBe(false);
    });

    it("explicitly releases and clears a provisional target when its draft is discarded", async () => {
        const storage = memoryStorage();
        getOrCreateNewExamPublishTarget(storage, "omr_exam_draft", () => "exam-target-1");
        const released: string[] = [];

        await expect(discardNewExamPublishTarget(
            storage,
            "omr_exam_draft",
            async targetId => { released.push(targetId); },
        )).resolves.toBe("exam-target-1");
        expect(released).toEqual(["exam-target-1"]);
        expect(getOrCreateNewExamPublishTarget(storage, "omr_exam_draft", () => "exam-target-2"))
            .toBe("exam-target-2");
    });

    it("scopes persisted upload nonces by exam, kind, and selected file", () => {
        const storage = memoryStorage();
        let sequence = 0;
        const mint = () => `nonce-${++sequence}`;
        const problem = new File(["%PDF-1.7"], "problem.pdf", {
            type: "application/pdf",
            lastModified: 1_000,
        });
        const replacement = new File(["%PDF-1.7 changed"], "problem-v2.pdf", {
            type: "application/pdf",
            lastModified: 2_000,
        });

        const first = getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", problem, mint);
        expect(getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", problem, mint)).toBe(first);
        expect(getOrCreatePdfUploadAttemptNonce(storage, "exam-b", "problem_pdf", problem, mint)).not.toBe(first);
        expect(getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "answer_key_pdf", problem, mint)).not.toBe(first);
        expect(getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", replacement, mint)).not.toBe(first);
    });

    it("rotates and persists only the selected upload nonce after explicit expiry", () => {
        const storage = memoryStorage();
        const file = new File(["%PDF-1.7"], "problem.pdf", { type: "application/pdf", lastModified: 1_000 });
        const first = getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", file, () => "nonce-1");
        const rotated = rotatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", file, () => "nonce-2");
        expect(rotated).toBe("nonce-2");
        expect(rotated).not.toBe(first);
        expect(getOrCreatePdfUploadAttemptNonce(storage, "exam-a", "problem_pdf", file, () => "nonce-3"))
            .toBe("nonce-2");
    });

    it("keeps a stable in-memory nonce when per-tab storage is blocked", () => {
        const blocked = {
            getItem() { throw new Error("blocked"); },
            setItem() { throw new Error("blocked"); },
            removeItem() { throw new Error("blocked"); },
        };
        const file = new File(["%PDF-1.7"], "problem.pdf", { type: "application/pdf", lastModified: 1_000 });
        let sequence = 0;
        const first = getOrCreatePdfUploadAttemptNonce(
            blocked,
            "exam-a",
            "problem_pdf",
            file,
            () => `nonce-000${++sequence}`,
        );
        expect(getOrCreatePdfUploadAttemptNonce(
            blocked,
            "exam-a",
            "problem_pdf",
            file,
            () => `nonce-000${++sequence}`,
        )).toBe(first);
        expect(sequence).toBe(1);
    });
});

describe("isEditDraftNewerThanExam", () => {
    it("offers a draft saved after the last exam save", () => {
        expect(
            isEditDraftNewerThanExam("2026-07-13T10:05:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(true);
    });

    it("ignores a draft that is same-age or older than the saved exam", () => {
        expect(
            isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(false);
        expect(
            isEditDraftNewerThanExam("2026-07-13T09:55:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(false);
    });

    it("treats a missing exam timestamp as epoch so any valid draft wins", () => {
        expect(isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", undefined)).toBe(true);
    });

    it("rejects a draft with a missing or unparseable savedAt", () => {
        expect(isEditDraftNewerThanExam(undefined, "2026-07-13T10:00:00.000Z")).toBe(false);
        expect(isEditDraftNewerThanExam("not-a-date", "2026-07-13T10:00:00.000Z")).toBe(false);
    });

    it("falls back to epoch when the exam timestamp is unparseable", () => {
        expect(isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", "garbage")).toBe(true);
    });
});

describe("shouldUploadExamPdf", () => {
    it("does not upload a remote PDF materialized only for preview", () => {
        const previewFile = new File(["remote preview"], "problem.pdf", { type: "application/pdf" });

        expect(shouldUploadExamPdf(previewFile, false, { store: "remote", key: "remote-asset" })).toBe(false);
    });

    it("uploads a PDF only after the teacher explicitly selects a replacement", () => {
        const replacement = new File(["replacement"], "replacement.pdf", { type: "application/pdf" });

        expect(shouldUploadExamPdf(replacement, true)).toBe(true);
        expect(shouldUploadExamPdf(null, true)).toBe(false);
    });

    it("automatically migrates a materialized legacy browser or inline PDF", () => {
        const legacy = new File(["%PDF-1.7"], "problem.pdf", { type: "application/pdf" });

        expect(shouldUploadExamPdf(legacy, false, {
            store: "indexeddb",
            key: "browser-only-problem",
        })).toBe(true);
        expect(shouldUploadExamPdf(legacy, false, undefined, "data:application/pdf;base64,JVBERi0=")).toBe(true);
        expect(shouldUploadExamPdf(legacy, false, undefined, "data:application/x-pdf;base64,JVBERi0=")).toBe(true);
        expect(shouldUploadExamPdf(legacy, false, undefined, "data:;base64,JVBERi0=")).toBe(true);
    });
});

describe("PDF hydration recovery", () => {
    it("loads problem then answer sequentially and preserves a successful problem when answer fails", async () => {
        const events: string[] = [];
        const result = await resolvePdfHydrationPairSequentially({
            problem: async () => {
                events.push("problem");
                return "problem-file";
            },
            answer: async () => {
                events.push("answer");
                throw new Error("answer unavailable");
            },
        });

        expect(events).toEqual(["problem", "answer"]);
        expect(result.problem).toEqual({ status: "loaded", value: "problem-file" });
        expect(result.answer).toMatchObject({ status: "failed" });
    });

    it("ignores stale hydration failures after the teacher selected a replacement", () => {
        expect(shouldApplyPdfHydrationOutcome({
            runGeneration: 1,
            currentGeneration: 1,
            replaced: true,
        })).toBe(false);
        expect(shouldApplyPdfHydrationOutcome({
            runGeneration: 1,
            currentGeneration: 2,
            replaced: false,
        })).toBe(false);
        expect(shouldApplyPdfHydrationOutcome({
            runGeneration: 2,
            currentGeneration: 2,
            replaced: false,
        })).toBe(true);
    });

    it("does not let an older hydration clear a newer restore failure", () => {
        const newerFailure = { problem: true, answer: false };

        expect(mergePdfHydrationFailures(newerFailure, {
            runGeneration: 1,
            currentGeneration: 2,
            problem: { replaced: false, failed: false },
            answer: { replaced: false, failed: false },
        })).toEqual(newerFailure);
        expect(mergePdfHydrationFailures(newerFailure, {
            runGeneration: 2,
            currentGeneration: 2,
            problem: { replaced: true, failed: false },
            answer: { replaced: false, failed: true },
        })).toEqual({ problem: true, answer: true });
    });
});

describe("edit route transition boundary", () => {
    it("blocks A state from publishing while route B failed or has not loaded", () => {
        expect(isLoadedExamCurrentForEdit("exam-b", { id: "exam-a" })).toBe(false);
        expect(isLoadedExamCurrentForEdit("exam-b", null)).toBe(false);
        expect(isLoadedExamCurrentForEdit("exam-b", { id: "exam-b" })).toBe(true);
        expect(isLoadedExamCurrentForEdit(null, null)).toBe(true);
        expect(isLoadedExamCurrentForEdit(null, { id: "exam-a" })).toBe(false);
    });

    it("ignores delayed A auto-detection after route B advances the editor generation", async () => {
        let currentGeneration = 1;
        const controller = new AbortController();
        let questions = "B questions";
        let finishA!: (value: string) => void;
        const delayedA = new Promise<string>(resolve => { finishA = resolve; });
        const applyA = delayedA.then(value => {
            if (shouldApplyAutoDetectOutcome({
                runGeneration: 1,
                currentGeneration,
                aborted: controller.signal.aborted,
            })) questions = value;
        });

        currentGeneration = 2;
        controller.abort();
        finishA("A detected questions");
        await applyA;

        expect(questions).toBe("B questions");
    });
});

describe("runPdfAssetUploadsSequentially", () => {
    it("finishes the problem PDF before starting the answer key to bound browser memory", async () => {
        const events: string[] = [];
        let finishProblem!: () => void;
        let finishAnswer!: () => void;
        let markAnswerStarted!: () => void;
        const problemGate = new Promise<void>(resolve => { finishProblem = resolve; });
        const answerGate = new Promise<void>(resolve => { finishAnswer = resolve; });
        const answerStarted = new Promise<void>(resolve => { markAnswerStarted = resolve; });

        const pending = runPdfAssetUploadsSequentially({
            problem: async () => {
                events.push("problem:start");
                await problemGate;
                events.push("problem:finish");
                return "problem-ref";
            },
            answer: async () => {
                events.push("answer:start");
                markAnswerStarted();
                await answerGate;
                events.push("answer:finish");
                return "answer-ref";
            },
        });

        await Promise.resolve();
        expect(events).toEqual(["problem:start"]);

        finishProblem();
        await answerStarted;
        expect(events).toEqual(["problem:start", "problem:finish", "answer:start"]);
        finishAnswer();
        await expect(pending).resolves.toEqual({
            problem: { status: "uploaded", value: "problem-ref" },
            answer: { status: "uploaded", value: "answer-ref" },
        });
    });

    it("reports each upload outcome independently", async () => {
        const problemError = new Error("problem failed");

        await expect(runPdfAssetUploadsSequentially({
            problem: async () => { throw problemError; },
            answer: async () => "answer-ref",
        })).resolves.toEqual({
            problem: { status: "failed", error: problemError },
            answer: { status: "uploaded", value: "answer-ref" },
        });
    });

    it("rolls back once after both sequential outcomes settle when either fails", async () => {
        let rollbackCalls = 0;

        const result = await runPdfAssetUploadsSequentially({
            problem: async () => { throw new Error("problem failed"); },
            answer: async () => { throw new Error("answer failed"); },
            rollback: async () => { rollbackCalls += 1; },
        });

        expect(result.problem.status).toBe("failed");
        expect(result.answer.status).toBe("failed");
        expect(rollbackCalls).toBe(1);
    });
});
