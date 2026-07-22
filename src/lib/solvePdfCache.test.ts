import { describe, expect, it } from "vitest";
import { forgetSolvePdf, recallSolvePdf, rememberSolvePdf } from "./solvePdfCache";

function pdf(name: string): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

describe("solvePdfCache", () => {
    it("returns null before anything is remembered", () => {
        expect(recallSolvePdf("exam-unseen")).toBeNull();
    });

    it("recalls the file remembered for an exam", () => {
        const file = pdf("problem.pdf");
        rememberSolvePdf("exam-a", file);
        expect(recallSolvePdf("exam-a")).toBe(file);
    });

    it("keeps caches separate per exam id", () => {
        rememberSolvePdf("exam-b", pdf("b.pdf"));
        rememberSolvePdf("exam-c", pdf("c.pdf"));
        expect(recallSolvePdf("exam-b")?.name).toBe("b.pdf");
        expect(recallSolvePdf("exam-c")?.name).toBe("c.pdf");
    });

    it("ignores an empty exam id", () => {
        rememberSolvePdf("", pdf("noop.pdf"));
        expect(recallSolvePdf("")).toBeNull();
    });

    it("forgets a cached file on request", () => {
        rememberSolvePdf("exam-d", pdf("d.pdf"));
        forgetSolvePdf("exam-d");
        expect(recallSolvePdf("exam-d")).toBeNull();
    });
});
