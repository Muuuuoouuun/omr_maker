import { describe, expect, it, vi } from "vitest";
import { activateByInput } from "../../e2e/inputActivation";

type Control = Parameters<typeof activateByInput>[0];

function mockControl() {
    return {
        click: vi.fn<Control["click"]>().mockResolvedValue(undefined),
        tap: vi.fn<Control["tap"]>().mockResolvedValue(undefined),
    };
}

describe.each([
    { input: "touch", hasTouch: true, selected: "tap", unused: "click" },
    { input: "mouse", hasTouch: false, selected: "click", unused: "tap" },
] as const)("activateByInput with $input input", ({ hasTouch, selected, unused }) => {
    it("performs exactly one native action without overriding actionability", async () => {
        const control = mockControl();

        await activateByInput(control, hasTouch);

        expect(control[selected]).toHaveBeenCalledExactlyOnceWith();
        expect(control[unused]).not.toHaveBeenCalled();
    });

    it("waits for the selected action's promise to resolve", async () => {
        const control = mockControl();
        let resolveAction!: () => void;
        const action = new Promise<void>(resolve => { resolveAction = resolve; });
        control[selected].mockReturnValueOnce(action);
        const settled = vi.fn();

        const activation = activateByInput(control, hasTouch);
        void activation.then(settled);
        await Promise.resolve();

        expect(settled).not.toHaveBeenCalled();
        expect(control[selected]).toHaveBeenCalledExactlyOnceWith();
        expect(control[unused]).not.toHaveBeenCalled();

        resolveAction();
        await expect(activation).resolves.toBeUndefined();
        expect(settled).toHaveBeenCalledTimes(1);
        expect(control[selected]).toHaveBeenCalledExactlyOnceWith();
        expect(control[unused]).not.toHaveBeenCalled();
    });

    it("propagates rejection without switching inputs or retrying", async () => {
        const control = mockControl();
        const failure = new Error("Native action failed");
        control[selected].mockRejectedValueOnce(failure);

        await expect(activateByInput(control, hasTouch)).rejects.toBe(failure);

        expect(control[selected]).toHaveBeenCalledExactlyOnceWith();
        expect(control[unused]).not.toHaveBeenCalled();
    });

    it("propagates a synchronous action failure without fallback", async () => {
        const control = mockControl();
        const failure = new Error("Native action threw");
        control[selected].mockImplementationOnce(() => { throw failure; });

        await expect(activateByInput(control, hasTouch)).rejects.toBe(failure);

        expect(control[selected]).toHaveBeenCalledExactlyOnceWith();
        expect(control[unused]).not.toHaveBeenCalled();
    });
});
