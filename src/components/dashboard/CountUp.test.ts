import { describe, expect, it } from "vitest";

describe("CountUp motion preference", () => {
    it("treats either the OS or the app motion setting as reduced motion", async () => {
        const countUpModule = await import("./CountUp");
        const decide = (
            countUpModule as typeof countUpModule & {
                shouldReduceCountUpMotion?: (
                    osPrefersReducedMotion: boolean,
                    appMotionSetting: string | null,
                ) => boolean;
            }
        ).shouldReduceCountUpMotion;

        expect(decide).toBeTypeOf("function");
        expect(decide?.(false, "off")).toBe(true);
        expect(decide?.(true, "on")).toBe(true);
        expect(decide?.(false, "on")).toBe(false);
        expect(decide?.(false, null)).toBe(false);
    });
});
