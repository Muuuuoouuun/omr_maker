import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const globalStyles = source("src/app/globals.css");
const teacherHeader = source("src/components/TeacherHeader.tsx");
const homePage = source("src/app/page.tsx");
const iosLayoutSpec = source("e2e/ios-mobile-layout.spec.ts");

function cssRuleBlocks(selector: string): string[] {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Array.from(globalStyles.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")))
        .map(match => match[1]);
}

describe("shared iPhone mobile layout surface", () => {
    it("defines reusable inline spacing, section rhythm, and wrapping action primitives", () => {
        expect(globalStyles).toMatch(/--mobile-inline-space:\s*[^;]+;/);
        expect(globalStyles).toMatch(/--mobile-section-gap:\s*[^;]+;/);
        expect(globalStyles).toMatch(/\.mobile-inline-surface\s*\{/);
        expect(globalStyles).toMatch(/\.mobile-section-stack\s*\{/);
        expect(globalStyles).toMatch(/\.mobile-action-row\s*\{/);
        expect(globalStyles).toContain("padding-inline: var(--mobile-inline-space)");
        expect(cssRuleBlocks(".mobile-section-stack").some(rule => rule.includes("gap: var(--mobile-section-gap)"))).toBe(true);
        expect(cssRuleBlocks(".mobile-action-row").some(rule => (
            rule.includes("gap: var(--mobile-section-gap)")
            && rule.includes("flex-wrap: wrap")
        ))).toBe(true);
    });

    it("keeps interactive descendants at least 44px on iPhone widths", () => {
        expect(globalStyles).toMatch(/@media \(max-width: 430px\)[\s\S]*\.mobile-section-stack :where\([^)]+\),[\s\S]*\.mobile-action-row :where\([^)]+\)\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px;/);
    });

    it("applies the shared primitives to the teacher header and home role/login surfaces", () => {
        expect(teacherHeader).toContain('className="teacher-header-actions mobile-action-row"');
        expect(homePage).toContain('className="container animate-fade-in home-container mobile-inline-surface mobile-section-stack"');
        expect(homePage).toContain('className="glass-panel animate-slide-up home-login-card mobile-section-stack"');
    });

    it("checks login controls and teacher header actions against the rendered viewport bounds", () => {
        expect(iosLayoutSpec).toContain("async function expectWithinViewport(locator: Locator, page: Page)");
        expect(iosLayoutSpec).toContain("await expectWithinViewport(control, page);");
        expect(iosLayoutSpec).toContain("await expectWithinViewport(interactiveActions.nth(index), page);");
    });
});
