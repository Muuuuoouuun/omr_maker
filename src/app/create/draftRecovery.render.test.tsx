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
    plan: "free",
    loadPdfJs: vi.fn(),
    loadExam: vi.fn(),
    savePdf: vi.fn(), deletePdf: vi.fn(), restorePdf: vi.fn(),
}));
vi.mock("@/lib/pdfjsRuntime", () => ({loadPdfJs: mocks.loadPdfJs}));
vi.mock("@/lib/directTeacherAssetUpload.client", () => ({isPdfFileByMagic: vi.fn(async()=>true), uploadTeacherPdfDirect: vi.fn()}));
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
vi.mock("@/components/OMRCardView", () => ({ default: ({ onQuestionClick }: { onQuestionClick: (id:number) => void }) => <button onClick={() => onQuestionClick(1)}>문제 1번 편집</button> }));
vi.mock("@/components/OMRPreview", () => ({ default: () => null }));
vi.mock("@/components/TeacherLogoutButton", () => ({ default: () => null }));
vi.mock("@/components/TeacherSessionChip", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: mocks }));
vi.mock("@/lib/useServerPlan", () => ({ useServerPlan: () => ({ plan: mocks.plan }) }));
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
    mocks.plan = "free";
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


describe("exam setup confirmation and recovery", () => {
    it("does not overwrite answers or points until a preset is confirmed and restores setup metadata", () => {
        const view = render(<CreateOMRPage />);
        fireEvent.change(fastAnswers(), { target: { value: "12345" } });
        fireEvent.click(screen.getByText("시험 기준·배점 설정"));
        fireEvent.click(screen.getByRole("button", { name: "국어 모의고사 기본 설정" }));
        expect(screen.getByRole("dialog", { name: "국어 모의고사 기본 설정" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "취소" }));
        expect(screen.getByLabelText("문항 수 직접 입력")).toHaveValue(20);
        fireEvent.click(screen.getByRole("button", { name: "국어 모의고사 기본 설정" }));
        fireEvent.click(screen.getByRole("button", { name: "확인하고 적용" }));
        expect(screen.getByLabelText("문항 수 직접 입력")).toHaveValue(45);
        expect(screen.getByLabelText("목표 총점")).toHaveValue(100);
        expect(screen.getByText("설정 총점 90점 / 목표 100점")).toBeInTheDocument();
        fireEvent.click(screen.getByText(/PDF 자동 매칭 범위/));
        fireEvent.click(screen.getByRole("button", { name: "언매 범위 예시" }));
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions.slice(0,5).map((q: {answer?:number}) => q.answer)).toEqual([1,2,3,4,5]);
        expect(storedDraft().authoringSettings).toEqual({targetTotalScore:100,pdfPageRange:"1-12,17-20"});
        view.unmount();
        render(<CreateOMRPage />);
        fireEvent.click(screen.getByRole("button", { name: "복원" }));
        fireEvent.click(screen.getByText("시험 기준·배점 설정"));
        fireEvent.click(screen.getByText(/PDF 자동 매칭 범위/));
        expect(screen.getByLabelText("목표 총점")).toHaveValue(100);
        expect(screen.getByLabelText("PDF 포함 페이지")).toHaveValue("1-12,17-20");
    });
    it("keeps answers intact when applying mixed points and supports undo", () => {
        render(<CreateOMRPage />);
        fireEvent.change(fastAnswers(), { target: { value: "54321" } });
        fireEvent.click(screen.getByText("시험 기준·배점 설정"));
        fireEvent.change(screen.getByLabelText("3점 문항 번호"), { target: { value: "5,8,11-12,14-18,20" } });
        fireEvent.click(screen.getByRole("button", { name: "2·3점 배점 적용 확인" }));
        fireEvent.click(screen.getByRole("button", { name: "확인하고 적용" }));
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions.reduce((sum:number,q:{score:number})=>sum+q.score,0)).toBe(50);
        expect(storedDraft().questions.slice(0,5).map((q:{answer?:number})=>q.answer)).toEqual([5,4,3,2,1]);
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions.reduce((sum:number,q:{score:number})=>sum+q.score,0)).toBe(100);
    });
});


describe("question-level safe edits", { timeout: 15_000 }, () => {
    it("requires confirmation before clearing answer5 when changing just one question to4choices", () => {
        render(<CreateOMRPage />);
        fireEvent.change(fastAnswers(), { target: { value: "54" } });
        fireEvent.click(screen.getByRole("button", {name:"문제 1번 편집"}));
        fireEvent.change(screen.getByLabelText("선택 문항 보기 수"), {target:{value:"4"}});
        fireEvent.click(screen.getByRole("button", {name:"취소"}));
        expect(screen.getByLabelText("선택 문항 보기 수")).toHaveValue("5");
        fireEvent.change(screen.getByLabelText("선택 문항 보기 수"), {target:{value:"4"}});
        fireEvent.click(screen.getByRole("button", {name:"확인하고 적용"}));
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions[0].answer).toBeUndefined();
        expect(storedDraft().questions[0].choices).toBe(4);
        expect(storedDraft().questions[1].answer).toBe(4);
        expect(storedDraft().questions[1].choices).toBe(5);
    });
    it("previews bulk subquestion impact and leaves other questions untouched when cancelled", () => {
        mocks.plan = "pro";
        render(<CreateOMRPage />);
        fireEvent.click(screen.getByRole("button", {name:"문제 1번 편집"}));
        fireEvent.click(screen.getByRole("button", {name:/고급 문항 구성/}));
        fireEvent.click(screen.getByRole("button", {name:"직접 만들기"}));
        fireEvent.change(screen.getByRole("textbox", {name:"1번 하위 질문 문구"}), {target:{value:"선택한 근거를 설명하세요."}});
        fireEvent.click(screen.getByRole("button", {name:"이 설정 일괄 적용"}));
        fireEvent.click(screen.getByRole("button", {name:"추가 적용"}));
        expect(screen.getByRole("dialog", {name:"하위 질문 일괄 적용 확인"})).toHaveTextContent("20문항 중 19문항");
        fireEvent.click(screen.getByRole("button", {name:"취소"}));
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions.filter((q:{subQuestions?:unknown[]})=>q.subQuestions?.length)).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", {name:"추가 적용"}));
        fireEvent.click(screen.getByRole("button", {name:"확인하고 적용"}));
        act(() => vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions.every((q:{subQuestions?:unknown[]})=>q.subQuestions?.length===1)).toBe(true);
    });
});


describe("pending PDF matching", {timeout:15_000}, () => {
    async function startDelayedMatching() {
        let finish!: (value:unknown)=>void;
        const promise = new Promise(resolve=>{finish=resolve;});
        const destroy=vi.fn(async()=>undefined);
        mocks.loadPdfJs.mockResolvedValue({getDocument:()=>({promise,destroy})});
        const view=render(<CreateOMRPage />);
        const file=new File(["%PDF-test"],"synthetic.pdf",{type:"application/pdf"});
        Object.defineProperty(file,'arrayBuffer',{value:async()=>new ArrayBuffer(4)});
        await act(async()=>fireEvent.change(view.container.querySelector('#pdf-upload-input')!,{target:{files:[file]}}));
        await act(async()=>fireEvent.click(screen.getByRole('button',{name:'PDF 문제 위치 자동 매칭'})));
        const finishScan=async()=>{await act(async()=>finish({numPages:1,getPage:async()=>({getViewport:()=>({width:100,height:100}),getTextContent:async()=>({items:[{str:'1. 합성 문제를 읽고 답하시오.',transform:[1,0,0,1,10,70],width:50,height:2}]})})}));};
        return {finishScan,destroy};
    }
    it('keeps edits made during a delayed scan and disables bulk presets until it finishes', async()=>{
        const {finishScan,destroy}=await startDelayedMatching();
        fireEvent.click(screen.getByText('시험 기준·배점 설정'));
        expect(screen.getByRole('button',{name:'국어 모의고사 기본 설정'})).toBeDisabled();
        expect(screen.getByRole('button',{name:'2·3점 배점 적용 확인'})).toBeDisabled();
        fireEvent.change(fastAnswers(),{target:{value:'543'}});
        fireEvent.click(screen.getByRole('button',{name:'문제 1번 편집'}));
        fireEvent.change(screen.getByLabelText('선택 문항 직접 배점'),{target:{value:'3'}});
        await finishScan();
        act(()=>vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions[0]).toMatchObject({answer:5,score:3,pdfLocation:{page:1}});
        expect(storedDraft().questions[1].answer).toBe(4);
        expect(destroy).toHaveBeenCalled();
    });
    it('cancels a stale scan when the question set is resized', async()=>{
        const {finishScan}=await startDelayedMatching();
        fireEvent.change(screen.getByLabelText('문항 수 직접 입력'),{target:{value:'3'}});
        fireEvent.keyDown(screen.getByLabelText('문항 수 직접 입력'),{key:'Enter'});
        await finishScan();
        act(()=>vi.advanceTimersByTime(30_000));
        expect(storedDraft().questions).toHaveLength(3);
        expect(storedDraft().questions.every((q:{pdfLocation?:unknown})=>!q.pdfLocation)).toBe(true);
        expect(mocks.info).toHaveBeenCalledWith('자동 매칭 중단','문항 구성이 바뀌었습니다. 새 구성에서 다시 실행하세요.');
    });
});
