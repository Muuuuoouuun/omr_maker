import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StatusPill from "@/components/dashboard/StatusPill";
import { solveSaveStatusChip } from "./solveSaveStatus";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("solve save status chip", () => {
    it("ranks a failed device save above offline, and offline above saved", () => {
        expect(solveSaveStatusChip({ saveState: "idle", online: true })).toBeNull();
        expect(solveSaveStatusChip({ saveState: "saved", online: true })).toMatchObject({ kind: "saved", tone: "muted", label: "저장됨" });
        expect(solveSaveStatusChip({ saveState: "failed", online: true })).toMatchObject({ kind: "failed", tone: "error", label: "저장 실패" });
        expect(solveSaveStatusChip({ saveState: "idle", online: false })).toMatchObject({ kind: "offline", tone: "warning", compactLabel: "오프라인" });
        expect(solveSaveStatusChip({ saveState: "saved", online: false })?.kind).toBe("offline");
        expect(solveSaveStatusChip({ saveState: "failed", online: false })?.kind).toBe("failed");
    });

    it("keeps the full label for assistive tech when a compact label is shown", () => {
        const markup = renderToStaticMarkup(<StatusPill size="sm" tone="error" label="저장 실패" compactLabel="실패" />);
        expect(markup).toContain('<span class="status-pill-label-full">저장 실패</span>');
        expect(markup).toContain('<span class="status-pill-label-compact" aria-hidden="true">실패</span>');
        expect(renderToStaticMarkup(<StatusPill size="sm" label="저장됨" />)).not.toContain("status-pill-label-compact");
    });

    it("renders the chip in the status row as a polite live region and marks failed saves", () => {
        const solve = read("src/app/solve/[id]/page.tsx");
        const chipStart = solve.indexOf('className="solve-save-status"');
        expect(chipStart).toBeGreaterThan(solve.indexOf('<div className="solve-status-row">'));
        const chipMarkup = solve.slice(chipStart, solve.indexOf("</span>", chipStart));
        expect(chipMarkup).toContain('aria-live="polite"');
        expect(chipMarkup).not.toContain('role="status"');
        expect(chipMarkup).toContain('size="sm"');
        expect(solve).toMatch(/\} catch \{\n\s+setDraftSaveState\("failed"\);/);
    });

    it("hides only the handwriting chip on phones and tablet portrait", () => {
        const css = read("src/app/globals.css");
        expect(css).not.toMatch(/\.solve-autosave\s*\{\s*display:\s*none/);
        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.solve-handwriting-status \{\s*display: none !important;/);
        expect(css).toMatch(/@media \(min-width: 600px\) and \(max-width: 1180px\) \{\s*\.solve-handwriting-status \{\s*display: none !important;/);
        expect(css).toMatch(/\.solve-save-status \.status-pill\.is-sm \.status-pill-label \{\s*font-size: var\(--type-micro\);/);
    });
});
