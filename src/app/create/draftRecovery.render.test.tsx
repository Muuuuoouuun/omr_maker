// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateOMRPage from "./page";
import { scopedExamDraftStorageKey } from "./createPageHelpers";

const mocks = vi.hoisted(() => ({
    error: vi.fn(), info: vi.fn(), success: vi.fn(),
    workspace: { organizationId: "org-1", actorUserId: "teacher-a" },
    defaults: { questions: 20, duration: 50, choices: 5, scorePerQ: 5, autosaveSec: 30 },
    edit: null as string | null,
    loadExam: vi.fn(),
    savePdf: vi.fn(), deletePdf: vi.fn(), restorePdf: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useSearchParams: () => ({ get: () => mocks.edit }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/BrandLogo", () => ({
    // Plain anchor deliberately models Next Link's no-beforeunload SPA departure.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    default: () => <a href="/">OMR Maker</a>,
}));
vi.mock("@/components/OMRCardView", () => ({ default: () => null }));
vi.mock("@/components/OMRPreview", () => ({ default: () => null }));
vi.mock("@/components/TeacherLogoutButton", () => ({ default: () => null }));
vi.mock("@/components/TeacherSessionChip", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: mocks }));
vi.mock("@/lib/useServerPlan", () => ({ useServerPlan: () => ({ plan: "free" }) }));
vi.mock("@/lib/workspaceContext", () => ({ readActiveWorkspaceContext: () => mocks.workspace }));
vi.mock("@/lib/appSettings", () => ({ readStoredExamDefaults: () => mocks.defaults }));
vi.mock("@/app/actions/remoteAssets", () => ({
    finalizeTeacherExamAssetUpload: vi.fn(), getTeacherRemoteAssetUrl: vi.fn(), prepareTeacherExamAssetUpload: vi.fn(),
}));
vi.mock("@/app/actions/teacherExam", () => ({
    getTeacherExamEntryInviteMetadata: vi.fn(), loadTeacherCanonicalExam: mocks.loadExam,
    revokeTeacherExamEntryInvite: vi.fn(), rotateTeacherExamEntryInvite: vi.fn(), saveTeacherCanonicalExam: vi.fn(),
}));
vi.mock("@/app/actions/teacherAssignment", () => ({
    clearTeacherIndividualAssignment: vi.fn(), loadTeacherIndividualAssignment: vi.fn(), saveTeacherIndividualAssignment: vi.fn(),
}));
vi.mock("@/lib/omrPersistence", () => ({ readLocalExam: vi.fn(), saveExam: vi.fn(), saveLocalExam: vi.fn() }));
vi.mock("@/utils/blobStore", () => ({ saveFileDataUrl: mocks.savePdf, deleteStoredData: mocks.deletePdf, storedDataUrlToFile: mocks.restorePdf }));

const draftKey = scopedExamDraftStorageKey(null, "org-1", "teacher-a");
function titleField() { return screen.getByRole("textbox", { name: "시험 제목" }); }
function fastAnswers() { return screen.getByRole("textbox", { name: "빠른 정답 입력" }); }
function storedDraft() { return JSON.parse(localStorage.getItem(draftKey)!); }
function unloadWarning() {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.edit = null;
    mocks.defaults.autosaveSec = 30;
    mocks.restorePdf.mockResolvedValue(null);
    mocks.deletePdf.mockResolvedValue(undefined);
    mocks.loadExam.mockResolvedValue({ status: "not_found" });
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [{ width: 10, height: 10 }] as unknown as DOMRectList);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("editor departure draft recovery", () => {
    it("restores the latest title and accepted answers after Home then Back inside the 30-second autosave gap", () => {
        const view = render(<CreateOMRPage />);
        fireEvent.change(fastAnswers(), { target: { value: "12345" } });
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions[0].answer).toBe(1);
        fireEvent.change(titleField(), { target: { value: "최신 합성 시험 제목" } });
        act(() => vi.advanceTimersByTime(13_000));
        expect(storedDraft().title).toBe("기말고사 OMR");
        // A Next Link departure unmounts the editor without beforeunload.
        fireEvent.click(screen.getByRole("link", { name: "OMR Maker" }));
        view.unmount();
        render(<CreateOMRPage />);
        fireEvent.click(screen.getByRole("button", { name: "복원" }));
        expect(titleField()).toHaveValue("최신 합성 시험 제목");
        expect(storedDraft().questions.map((q: { answer?: number }) => q.answer).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    });

    it("starts restore on the safe button, wraps keyboard focus, and Escape restores instead of deleting", () => {
        localStorage.setItem(draftKey, JSON.stringify({ title: "복구할 시험", questionsCount: 1, questions: [{ id: 1, number: 1, choices: 5, score: 5, answer: 3 }] }));
        render(<CreateOMRPage />);
        const restore = screen.getByRole("button", { name: "복원" });
        const discard = screen.getByRole("button", { name: "초안 삭제" });
        expect(restore).toHaveFocus();
        fireEvent.keyDown(restore, { key: "Tab" });
        expect(discard).toHaveFocus();
        fireEvent.keyDown(discard, { key: "Tab", shiftKey: true });
        expect(restore).toHaveFocus();
        fireEvent.keyDown(restore, { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(titleField()).toHaveValue("복구할 시험");
        expect(localStorage.getItem(draftKey)).not.toBeNull();
    });

    it("flushes Back synchronously and preserves already serialized PDF references", () => {
        const assets = {
            pdfDataRef: { store: "indexeddb", key: `${draftKey}:problemPdf` },
            answerKeyPdfRef: { store: "indexeddb", key: `${draftKey}:answerKeyPdf` },
        };
        localStorage.setItem(draftKey, JSON.stringify({ ...assets, title: "기존 초안", questionsCount: 1, questions: [{ id: 1, number: 1, choices: 5, score: 5, answer: 2 }] }));
        render(<CreateOMRPage />);
        fireEvent.click(screen.getByRole("button", { name: "복원" }));
        fireEvent.change(titleField(), { target: { value: "Back 직전 편집" } });
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(storedDraft()).toMatchObject({ ...assets, title: "Back 직전 편집" });
        expect(mocks.deletePdf).not.toHaveBeenCalled();
    });

    it("flushes a departing editor slot into its own scoped key and never writes next-route defaults there", () => {
        const view = render(<CreateOMRPage />);
        fireEvent.change(titleField(), { target: { value: "이전 슬롯의 최신 제목" } });
        mocks.edit = "exam-2";
        view.rerender(<CreateOMRPage />);
        expect(storedDraft().title).toBe("이전 슬롯의 최신 제목");
        view.unmount();
        expect(storedDraft().title).toBe("이전 슬롯의 최신 제목");
        expect(localStorage.getItem(scopedExamDraftStorageKey("exam-2", "org-1", "teacher-a"))).toBeNull();
    });

    it("does not create a recovery draft for untouched defaults or when autosave is explicitly disabled", () => {
        render(<CreateOMRPage />).unmount();
        expect(localStorage.getItem(draftKey)).toBeNull();
        mocks.defaults.autosaveSec = 0;
        const view = render(<CreateOMRPage />);
        fireEvent.change(titleField(), { target: { value: "자동저장 꺼짐" } });
        act(() => vi.advanceTimersByTime(60_000));
        expect(unloadWarning()).toBe(true);
        view.unmount();
        expect(localStorage.getItem(draftKey)).toBeNull();
    });

    it("does not overwrite a draft whose failed PDF cleanup still owns its body", () => {
        const prior = JSON.stringify({ title: "정리 재시도 초안", questions: [], pdfDataRef: { store: "indexeddb", key: `${draftKey}:problemPdf` } });
        localStorage.setItem(draftKey, prior);
        localStorage.setItem(`${draftKey}:cleanupPending`, JSON.stringify({ removeDraftBody: true }));
        mocks.deletePdf.mockRejectedValue(new Error("blocked cleanup"));
        const view = render(<CreateOMRPage />);
        fireEvent.change(titleField(), { target: { value: "정리 중 새 편집" } });
        act(() => vi.advanceTimersByTime(30_000));
        view.unmount();
        expect(localStorage.getItem(draftKey)).toBe(prior);
        expect(localStorage.getItem(`${draftKey}:cleanupPending`)).not.toBeNull();
    });

    it("keeps a failed explicit draft save dirty and lets the same edit retry after storage recovers", async () => {
        render(<CreateOMRPage />);
        fireEvent.change(titleField(), { target: { value: "저장 재시도 제목" } });
        const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "초안 저장" })[0]); });
        expect(titleField()).toHaveValue("저장 재시도 제목");
        expect(localStorage.getItem(draftKey)).toBeNull();
        expect(unloadWarning()).toBe(true);
        expect(mocks.success).not.toHaveBeenCalled();
        write.mockRestore();
        await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "초안 저장" })[0]); });
        expect(storedDraft().title).toBe("저장 재시도 제목");
        expect(unloadWarning()).toBe(false);
    });

    it("retains accepted answers, old persisted draft, and native dirty warning on a failed autosave", () => {
        const view = render(<CreateOMRPage />);
        fireEvent.change(fastAnswers(), { target: { value: "12345" } });
        act(() => vi.advanceTimersByTime(30_000));
        const savedPdfRefs = {
            pdfDataRef: { store: "indexeddb", key: `${draftKey}:problemPdf` },
            answerKeyPdfRef: { store: "indexeddb", key: `${draftKey}:answerKeyPdf` },
        };
        localStorage.setItem(draftKey, JSON.stringify({ ...storedDraft(), ...savedPdfRefs }));
        const prior = localStorage.getItem(draftKey);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        fireEvent.change(titleField(), { target: { value: "저장되지 않은 최신 제목" } });
        fireEvent.change(fastAnswers(), { target: { value: "12645" } });
        act(() => vi.advanceTimersByTime(30_000));
        expect(titleField()).toHaveValue("저장되지 않은 최신 제목");
        expect(localStorage.getItem(draftKey)).toBe(prior);
        expect(storedDraft().questions.map((q: { answer?: number }) => q.answer).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(unloadWarning()).toBe(true);
        expect(mocks.success).not.toHaveBeenCalled();
        expect(storedDraft()).toMatchObject(savedPdfRefs);
        expect(mocks.deletePdf).not.toHaveBeenCalled();
        view.unmount();
        expect(localStorage.getItem(draftKey)).toBe(prior);
        expect(unloadWarning()).toBe(false);
    });
});
