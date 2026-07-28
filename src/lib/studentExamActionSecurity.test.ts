import { beforeEach, describe, expect, it, vi } from "vitest";

const headerStore = vi.hoisted(() => ({ current: new Headers() }));
const getSupabaseServerConfigFromEnv = vi.hoisted(() => vi.fn(() => null));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => headerStore.current),
    cookies: vi.fn(async () => ({ get: vi.fn() })),
}));

vi.mock("@/lib/supabaseServerAdmin", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseServerAdmin")>();
    return {
        ...actual,
        getSupabaseServerConfigFromEnv,
    };
});

import { submitAttempt } from "@/app/actions/studentExam";

const input = {
    examId: "exam-1",
    submissionId: "11111111-1111-4111-8111-111111111111",
    answers: {},
    startedAt: "2026-07-28T00:00:00.000Z",
};

describe("student submit action origin boundary", () => {
    beforeEach(() => {
        vi.stubEnv("OMR_E2E_STUDENT_SUBMISSION_SIMULATION", "");
        getSupabaseServerConfigFromEnv.mockClear();
    });

    it("rejects a missing Origin before resolving the gateway", async () => {
        headerStore.current = new Headers({ host: "localhost:3003" });

        await expect(submitAttempt(input)).resolves.toEqual({ status: "error" });
        expect(getSupabaseServerConfigFromEnv).not.toHaveBeenCalled();
    });

    it("rejects a cross-origin request before resolving the gateway", async () => {
        headerStore.current = new Headers({
            host: "localhost:3003",
            origin: "https://evil.example",
        });

        await expect(submitAttempt(input)).resolves.toEqual({ status: "error" });
        expect(getSupabaseServerConfigFromEnv).not.toHaveBeenCalled();
    });

    it("allows an explicit same-origin request to continue to gateway resolution", async () => {
        headerStore.current = new Headers({
            host: "localhost:3003",
            origin: "http://localhost:3003",
        });

        await expect(submitAttempt(input)).resolves.toEqual({ status: "degraded_local" });
        expect(getSupabaseServerConfigFromEnv).toHaveBeenCalledTimes(1);
    });
});
