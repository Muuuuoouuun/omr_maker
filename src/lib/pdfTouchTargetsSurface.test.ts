import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("PDF editor touch targets", () => {
    it("provides 44 by 44 pixel drawing and color controls on touch layouts", () => {
        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.pdf-tool-button[\s\S]*width: 44px[\s\S]*height: 44px/);
        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.pdf-color-swatch[\s\S]*min-width: 44px[\s\S]*min-height: 44px/);
        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.pdf-seg-button[\s\S]*min-width: 44px[\s\S]*min-height: 44px/);
    });
});
