import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    afterTasks: [] as Array<() => unknown>,
    afterThrows: false,
    deliver: vi.fn(),
}));

vi.mock("next/server", () => ({
    after: (task: () => unknown) => {
        if (mocks.afterThrows) throw new Error("request context unavailable");
        mocks.afterTasks.push(task);
    },
}));

vi.mock("./operationalEventSink.server", async importOriginal => {
    const actual = await importOriginal<typeof import("./operationalEventSink.server")>();
    return { ...actual, deliverOperationalEvent: mocks.deliver };
});

import { reportServerError } from "./reportServerError";

describe("server error scheduling", () => {
    beforeEach(() => {
        mocks.afterTasks.length = 0;
        mocks.afterThrows = false;
        mocks.deliver.mockReset();
        mocks.deliver.mockResolvedValue({ status: "delivered" });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("uses a short bounded fallback when response scheduling is unavailable", async () => {
        mocks.afterThrows = true;
        await expect(reportServerError("server-request-error", new Error("private payload")))
            .resolves.toEqual({ status: "scheduled" });
        expect(mocks.deliver).toHaveBeenCalledWith(
            expect.objectContaining({ event: "omr.runtime_error", context: "server-request-error" }),
            process.env,
            fetch,
            250,
        );
    });

    it("returns without waiting for the external sink and delivers after the response", async () => {
        await expect(reportServerError("student-submit", new Error("private payload")))
            .resolves.toEqual({ status: "scheduled" });
        expect(mocks.deliver).not.toHaveBeenCalled();
        expect(mocks.afterTasks).toHaveLength(1);

        await mocks.afterTasks[0]();
        expect(mocks.deliver).toHaveBeenCalledWith(
            expect.objectContaining({ event: "omr.runtime_error", context: "student-submit" }),
            process.env,
            fetch,
            250,
        );
    });
});
