import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/app/teacher/billing/page.tsx"), "utf8");

describe("billing status feedback", () => {
    it("keeps passive plan authority status inline instead of obscuring usage with a toast", () => {
        expect(source).toContain('aria-live="polite"');
        expect(source).toContain("planAuthorityMeta.detail");
        expect(source).not.toContain('toast.info(\n                    "서버 플랜 확인 불가"');
        expect(source).not.toContain('toast.info(\n                    "로컬 사용량 기준으로 표시 중"');
    });
});
