// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./page";
import { DEFAULT_SETTINGS, readStoredExamDefaults } from "@/lib/appSettings";
import { SETTINGS_STORAGE_KEY } from "@/lib/geminiApiKey";

const mocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: mocks }));
vi.mock("@/app/actions/auth", () => ({ clearTeacherAuthSession: vi.fn(), getTeacherDeploymentReadiness: vi.fn() }));
vi.mock("@/lib/teacherAttemptClient", () => ({ loadTeacherAttemptSummaries: vi.fn() }));
vi.mock("@/lib/teacherAttemptReportingClient", () => ({ loadTeacherAttemptAggregate: vi.fn() }));
vi.mock("@/lib/teacherExamClient", () => ({ loadTeacherExams: vi.fn() }));
vi.mock("@/lib/teacherRosterClient", () => ({ loadTeacherRosterSnapshot: vi.fn() }));

function field(label: string) {
    return screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

function change(label: string, value: string) {
    fireEvent.change(field(label), { target: { value } });
}

function save() {
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
}

function seedSettings(questions = 25) {
    const settings = { ...DEFAULT_SETTINGS, examDefaults: { ...DEFAULT_SETTINGS.examDefaults, questions } };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return settings;
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/teacher/settings");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("teacher settings persistence and validation", () => {
    it("connects each exam-default label to its input or select", () => {
        render(<SettingsPage />);
        expect(field("기본 문항 수").value).toBe("20");
        expect(field("기본 시간 (분)").value).toBe("50");
        expect(field("문항당 기본 배점").value).toBe("5");
        expect(field("선택지 수").value).toBe("5");
        expect(field("자동 저장 주기").value).toBe("30");
    });

    it.each([
        ["기본 문항 수", "", "1~50"],
        ["기본 문항 수", "0", "1~50"],
        ["기본 문항 수", "-1", "1~50"],
        ["기본 문항 수", "51", "1~50"],
        ["기본 문항 수", "20.5", "1~50"],
        ["기본 시간 (분)", "", "1~360"],
        ["기본 시간 (분)", "0", "1~360"],
        ["기본 시간 (분)", "361", "1~360"],
        ["기본 시간 (분)", "50.5", "1~360"],
        ["문항당 기본 배점", "", "0보다 큰"],
        ["문항당 기본 배점", "0", "0보다 큰"],
        ["문항당 기본 배점", "-1", "0보다 큰"],
    ])("rejects invalid %s value %s without saving", (label, value, expectedMessage) => {
        render(<SettingsPage />);
        const write = vi.spyOn(Storage.prototype, "setItem");
        change(label, value);
        save();
        expect(write).not.toHaveBeenCalled();
        expect(screen.queryByText("저장됨")).toBeNull();
        expect(screen.getByRole("alert").textContent).toContain("기본값을 저장하지 않았습니다");
        expect(field(label).getAttribute("aria-invalid")).toBe("true");
        const description = document.getElementById(field(label).getAttribute("aria-describedby")!);
        expect(description?.textContent).toContain(expectedMessage);
        expect(field(label).value).toBe(value === "" ? "0" : value);
    });

    it("clears validation after correction and persists values that round-trip unchanged", () => {
        const original = seedSettings();
        const view = render(<SettingsPage />);
        change("기본 문항 수", "51");
        save();
        change("기본 문항 수", "30");
        change("기본 시간 (분)", "90");
        change("문항당 기본 배점", "2.5");
        change("선택지 수", "4");
        change("자동 저장 주기", "10");
        save();
        const expectedDefaults = { questions: 30, duration: 90, scorePerQ: 2.5, choices: 4, autosaveSec: 10 };
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("status").textContent).toBe("저장됨");
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual({ ...original, examDefaults: expectedDefaults });
        expect(readStoredExamDefaults()).toEqual(expectedDefaults);
        change("기본 문항 수", "40");
        fireEvent.click(screen.getByRole("button", { name: "취소" }));
        expect(field("기본 문항 수").value).toBe("30");
        view.unmount();
        render(<SettingsPage />);
        expect(field("기본 문항 수").value).toBe("30");
        expect(field("기본 시간 (분)").value).toBe("90");
        expect(field("문항당 기본 배점").value).toBe("2.5");
    });

    it.each([["1", "1"], ["50", "360"]])("accepts supported boundary defaults %s questions and %s minutes", (questions, duration) => {
        render(<SettingsPage />);
        change("기본 문항 수", questions);
        change("기본 시간 (분)", duration);
        change("문항당 기본 배점", "0.25");
        change("자동 저장 주기", "0");
        save();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(readStoredExamDefaults()).toMatchObject({ questions: Number(questions), duration: Number(duration), scorePerQ: 0.25, autosaveSec: 0 });
    });

    it.each(["QuotaExceededError", "SecurityError"])("keeps unsaved edits and the previous cancel target on %s", errorName => {
        const original = seedSettings();
        render(<SettingsPage />);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", errorName); });
        change("기본 문항 수", "30");
        save();
        expect(mocks.error).toHaveBeenCalledWith("설정 저장 실패", expect.stringContaining("변경한 내용은 그대로 유지"));
        expect(screen.queryByText("저장됨")).toBeNull();
        expect(field("기본 문항 수").value).toBe("30");
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(original);
        fireEvent.click(screen.getByRole("button", { name: "취소" }));
        expect(field("기본 문항 수").value).toBe("25");
    });

    it("lets the same unsaved edit retry successfully after storage recovers", () => {
        seedSettings();
        render(<SettingsPage />);
        const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });
        change("기본 문항 수", "30");
        save();
        expect(screen.queryByText("저장됨")).toBeNull();
        save();
        expect(write).toHaveBeenCalledTimes(2);
        expect(readStoredExamDefaults().questions).toBe(30);
        expect(screen.getByRole("status").textContent).toBe("저장됨");
    });

    it("removes stale success feedback when a later save fails", () => {
        render(<SettingsPage />);
        save();
        expect(screen.getByRole("status").textContent).toBe("저장됨");
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        change("기본 문항 수", "30");
        save();
        expect(screen.queryByText("저장됨")).toBeNull();
        expect(readStoredExamDefaults().questions).toBe(20);
    });

    it("does not reset settings or close confirmation when the reset write fails", () => {
        const original = seedSettings();
        render(<SettingsPage />);
        fireEvent.click(screen.getByText("백업 · 복원").closest("summary")!);
        fireEvent.click(screen.getByRole("button", { name: "전체 초기화" }));
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        fireEvent.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
        expect(mocks.error).toHaveBeenCalledWith("설정 초기화 실패", expect.any(String));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "설정 초기화 확인" })).toBeTruthy();
        expect(field("기본 문항 수").value).toBe("25");
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(original);
    });

    it("does not replace existing settings or announce success when import storage fails", async () => {
        const original = seedSettings();
        const view = render(<SettingsPage />);
        const backup = { ...DEFAULT_SETTINGS, examDefaults: { ...DEFAULT_SETTINGS.examDefaults, questions: 40 } };
        const file = new File([], "settings.json", { type: "application/json" });
        Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
        await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("설정 가져오기 실패", expect.any(String)));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(field("기본 문항 수").value).toBe("25");
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(original);
    });
});
