import { beforeEach, describe, expect, it, vi } from "vitest";

const durableOperations = vi.hoisted(() => [] as string[]);
const durableReservations = vi.hoisted(() => ({ count: 0 }));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => true }));

vi.mock("@/lib/supabaseServerAdmin", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseServerAdmin")>();
    return {
        ...actual,
        getSupabaseServerConfigFromEnv: () => ({ url: "https://example.supabase.co", serviceRoleKey: "test" }),
        createSupabaseAdminClient: () => ({}),
    };
});

vi.mock("@/lib/studentLoginRateLimit", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/studentLoginRateLimit")>();
    return {
        ...actual,
        checkStudentLoginRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
        recordStudentLoginFailure: vi.fn(),
        recordStudentLoginSuccess: vi.fn(),
    };
});

vi.mock("@/lib/durableRateLimit", () => ({
    applyDurableRateLimitToSubjects: async ({ operation }: { operation: string }) => {
        durableOperations.push(operation);
        if (operation !== "consume") return { allowed: true, retryAfterMs: 0 };
        durableReservations.count += 1;
        return { allowed: durableReservations.count <= 5, retryAfterMs: 60_000 };
    },
}));

import { issueStudentSession } from "@/app/actions/studentSession";

describe("student login durable rate limit", () => {
    beforeEach(() => {
        durableOperations.length = 0;
        durableReservations.count = 0;
    });

    it("allows five credential checks and blocks the sixth before validation without double-counting failures", async () => {
        const input = { workspaceId: "default", name: "학생", groupId: "", studentLookup: "" };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await expect(issueStudentSession(input)).resolves.toMatchObject({ status: "invalid_credentials" });
        }
        await expect(issueStudentSession(input)).resolves.toMatchObject({ status: "rate_limited" });

        expect(durableOperations).toEqual(["consume", "consume", "consume", "consume", "consume", "consume"]);
    });
});
