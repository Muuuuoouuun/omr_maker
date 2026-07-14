import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("premium mutation authorization order", () => {
    it("authorizes outgoing subquestions before any exam persistence", () => {
        const createPage = source("src/app/create/page.tsx");
        const entitlement = createPage.indexOf("await authorizeAdvancedQuestionDesign()");
        const save = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        expect(entitlement).toBeGreaterThan(-1);
        expect(save).toBeGreaterThan(entitlement);
        expect(createPage).toContain('from "@/app/actions/teacherExam"');
    });

    it("checks every outgoing edit that retains paid subquestions", () => {
        const createPage = source("src/app/create/page.tsx");
        expect(createPage).toContain("questionsWithRegions.some(question => (question.subQuestions?.length || 0) > 0)");
        expect(createPage).toContain("every save that contains them");
        expect(createPage).toContain("await releaseExamCreationAuthorization(reservedExamId)");
    });

    it("compensates shared-AI reservations for every post-reservation failure", () => {
        const aiAction = source("src/app/actions/analyzeKey.ts");
        const reserve = aiAction.indexOf("await authorizeSharedAiRecognition(sharedAiRequestId)");
        const providerInitialization = aiAction.indexOf("new GoogleGenerativeAI(apiKey)");
        const release = aiAction.indexOf("await releaseSharedAiRecognition(sharedAiRequestId)");
        expect(providerInitialization).toBeGreaterThan(reserve);
        expect(release).toBeGreaterThan(providerInitialization);
        expect(aiAction.lastIndexOf("catch (error: unknown)")).toBeLessThan(release);
    });
});
