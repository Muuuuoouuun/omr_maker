// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GlobalSearch from "./GlobalSearch";

const mocks = vi.hoisted(() => ({ push: vi.fn(), exams: vi.fn(), groups: vi.fn(), students: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/omrPersistence", () => ({ readLocalExams: mocks.exams }));
vi.mock("@/lib/rosterStorage", () => ({ readRosterGroups: mocks.groups, readRosterStudents: mocks.students }));

function openSearch() {
    act(() => { window.dispatchEvent(new Event("omr:open-search")); });
    return screen.getByRole("combobox");
}

describe("global search interactions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.exams.mockReturnValue([
            { id: "math", title: "수학 시험", questions: [{}] },
            { id: "english", title: "영어 시험", questions: [{}] },
        ]);
        mocks.groups.mockReturnValue([]);
        mocks.students.mockReturnValue([]);
    });
    afterEach(cleanup);

    it("reads the latest local items when opened and restores trigger focus on close", () => {
        render(<><button onClick={() => window.dispatchEvent(new Event("omr:open-search"))}>검색 열기</button><GlobalSearch /></>);
        expect(mocks.exams).not.toHaveBeenCalled();
        const trigger = screen.getByRole("button", { name: "검색 열기" });
        trigger.focus();
        fireEvent.click(trigger);
        expect(document.activeElement).toBe(screen.getByRole("combobox"));
        expect(screen.getByRole("option", { name: /수학 시험/ })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "검색 닫기" }));
        expect(document.activeElement).toBe(trigger);
        mocks.exams.mockReturnValue([{ id: "new", title: "새 시험", questions: [] }]);
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        expect(screen.getByRole("option", { name: /새 시험/ })).toBeTruthy();
        expect(screen.queryByRole("option", { name: /수학 시험/ })).toBeNull();
        expect(mocks.exams).toHaveBeenCalledTimes(2);
    });

    it("navigates to the exact hovered result when Enter is pressed", () => {
        render(<GlobalSearch />);
        const input = openSearch();
        const option = screen.getByRole("option", { name: /수학 시험/ });
        fireEvent.mouseEnter(option);
        expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
        expect(option.getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/teacher/dashboard?tab=exam&examId=math");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("resets keyboard selection for a changed query and recovers after no results", () => {
        render(<GlobalSearch />);
        const input = openSearch();
        for (let index = 0; index < 20; index++) fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.change(input, { target: { value: "없는 검색어" } });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input.hasAttribute("aria-activedescendant")).toBe(false);
        fireEvent.change(input, { target: { value: "영어" } });
        fireEvent.keyDown(input, { key: "ArrowUp" });
        const option = screen.getByRole("option", { name: /영어 시험/ });
        expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
        fireEvent.keyDown(input, { key: "Enter" });
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/teacher/dashboard?tab=exam&examId=english");
    });
});
