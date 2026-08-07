import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/app/create/page.tsx"), "utf8");

describe("create save and publish hierarchy", () => {
    it("offers an explicit recoverable draft save before distribution", () => {
        expect(source).toContain("const handleSaveDraftNow = async () => {");
        expect(source).toContain('saveFileDataUrl(`${draftStorageKey}:problemPdf`, currentProblemPdf)');
        expect(source).toContain('saveFileDataUrl(`${draftStorageKey}:answerKeyPdf`, currentAnswerKeyPdf)');
        expect(source).toContain("restoreDraftPdfAssets(snap)");
        expect(source).toContain("localStorage.setItem(draftStorageKey, JSON.stringify(draft))");
        expect(source).toContain('"초안 저장 완료"');
        expect(source).toContain("초안 저장");
    });

    it("keeps the mobile completion bar focused on draft safety and distribution", () => {
        const mobileActions = source.slice(source.indexOf('className="create-primary-actions create-primary-actions--mobile"'));
        expect(mobileActions).toContain("저장하고 배포하기");
        expect(mobileActions).toContain("handleSaveDraftNow");
        expect(mobileActions).not.toContain("handleSaveImage");
    });
});
