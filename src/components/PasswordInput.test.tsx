// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PasswordInput from "./PasswordInput";

describe("PasswordInput", () => {
    afterEach(cleanup);
    it("shows and hides the existing value without submitting the form", () => {
        const submit = vi.fn(event => event.preventDefault());
        const change = vi.fn();
        render(<form onSubmit={submit}><label htmlFor="password">비밀번호</label>
            <PasswordInput id="password" value="synthetic-password" onChange={change} autoComplete="current-password" />
        </form>);
        const input = screen.getByLabelText("비밀번호");
        expect(input).toHaveAttribute("type", "password");
        fireEvent.click(screen.getByRole("button", { name: "비밀번호 표시" }));
        expect(input).toHaveAttribute("type", "text");
        expect(input).toHaveValue("synthetic-password");
        expect(input).toHaveAttribute("autocomplete", "current-password");
        expect(screen.getByRole("button", { name: "비밀번호 숨기기" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "비밀번호 숨기기" }));
        expect(input).toHaveAttribute("type", "password");
        expect(submit).not.toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
    });

    it("masks again when the account form mode changes", () => {
        const { rerender } = render(<PasswordInput key="login" id="password" aria-label="비밀번호" value="synthetic-password" readOnly />);
        fireEvent.click(screen.getByRole("button", { name: "비밀번호 표시" }));
        rerender(<PasswordInput key="signup" id="password" aria-label="비밀번호" value="synthetic-password" readOnly />);
        expect(screen.getByLabelText("비밀번호")).toHaveAttribute("type", "password");
        expect(screen.getByLabelText("비밀번호")).toHaveValue("synthetic-password");
    });

    it("preserves disabled state and accessible input descriptions", () => {
        render(<PasswordInput id="password" aria-label="비밀번호" aria-describedby="requirement" disabled />);
        expect(screen.getByLabelText("비밀번호")).toBeDisabled();
        expect(screen.getByLabelText("비밀번호")).toHaveAttribute("aria-describedby", "requirement");
        expect(screen.getByRole("button", { name: "비밀번호 표시" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "비밀번호 표시" }));
        expect(screen.getByLabelText("비밀번호")).toHaveAttribute("type", "password");
    });
});
