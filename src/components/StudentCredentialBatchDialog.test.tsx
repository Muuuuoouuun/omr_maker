// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudentCredentialBatchDialog from "./StudentCredentialBatchDialog";

vi.mock("next/navigation", () => ({ usePathname: () => "/teacher/users" }));
const students = [{ studentId: "student-1", name: "학생", group: "1반" }];

beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("student credential dialog committed callbacks and request lifetime", () => {
    it("uses the latest committed close callback for keyboard events", () => {
        const previousClose = vi.fn();
        const currentClose = vi.fn();
        const issue = vi.fn();
        const view = render(<StudentCredentialBatchDialog open expectedStudents={students} students={students}
            issueStudentCredentialBatch={issue} onClose={previousClose} />);
        view.rerender(<StudentCredentialBatchDialog open expectedStudents={students} students={students}
            issueStudentCredentialBatch={issue} onClose={currentClose} />);

        fireEvent.keyDown(window, { key: "Escape" });

        expect(previousClose).not.toHaveBeenCalled();
        expect(currentClose).toHaveBeenCalledTimes(1);
    });

    it("blocks close during issuance and invalidates the pending result when the page hides", async () => {
        type IssuedBatch = {
            status: "issued";
            credentials: { studentId: string; startCode: string }[];
            idempotencyKey: string;
        };
        let resolveIssue!: (value: IssuedBatch) => void;
        const issue = vi.fn<(studentIds: readonly string[], idempotencyKey: string) => Promise<IssuedBatch>>(
            () => new Promise(resolve => { resolveIssue = resolve; }),
        );
        const onClose = vi.fn();
        const onIssued = vi.fn();
        render(<StudentCredentialBatchDialog open expectedStudents={students} students={students}
            issueStudentCredentialBatch={issue} onClose={onClose} onIssued={onIssued} />);
        fireEvent.click(screen.getByRole("button", { name: "1명 발급" }));
        expect(issue).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "닫기" })).toBeDisabled();

        fireEvent(window, new Event("pagehide"));
        await act(async () => {
            resolveIssue({
                status: "issued",
                credentials: [{ studentId: "student-1", startCode: "AB2CD3" }],
                idempotencyKey: issue.mock.calls[0][1] as string,
            });
        });

        expect(onIssued).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "CSV 다운로드" })).not.toBeInTheDocument();
    });
});
