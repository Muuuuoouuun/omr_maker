import { describe, expect, it } from "vitest";
import { createEditorRouteGenerationController } from "./editorRouteGeneration";

describe("editor route generation controller", () => {
    it("keeps A current when a B render is abandoned before commit", () => {
        const controller = createEditorRouteGenerationController("exam-a");
        const aGeneration = controller.generation();

        // Rendering B must not mutate ownership. React only calls commit from
        // a committed layout effect, so an abandoned B render never appears here.
        expect(controller.slot()).toBe("exam-a");
        expect(controller.isCurrent(aGeneration)).toBe(true);
    });

    it("invalidates A only after B commits", () => {
        const controller = createEditorRouteGenerationController("exam-a");
        const aGeneration = controller.generation();

        controller.commit("exam-b");

        expect(controller.slot()).toBe("exam-b");
        expect(controller.isCurrent(aGeneration)).toBe(false);
        expect(controller.generation()).toBe(aGeneration + 1);
    });
});
