import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ rateAllowed: true }));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({
        get: () => undefined,
        set: vi.fn(),
        delete: vi.fn(),
    }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
}));

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
        checkStudentLoginRateLimit: () => ({ allowed: controls.rateAllowed }),
        recordStudentLoginFailure: vi.fn(),
        recordStudentLoginSuccess: vi.fn(),
    };
});

import { issueStudentSession } from "@/app/actions/studentSession";

function throwingGuestAttemptIds(): string[] {
    return new Proxy([] as string[], {
        get(_target, property) {
            if (property === "length" || typeof property === "string") {
                throw new Error("guest attempt ids preprocessed");
            }
            return undefined;
        },
    });
}

describe("student login guest-id preprocessing order", () => {
    beforeEach(() => { controls.rateAllowed = true; });

    it("does not inspect guest IDs when credentials are invalid", async () => {
        await expect(issueStudentSession({
            workspaceId: "default",
            name: "",
            groupId: "",
            studentLookup: "",
            guestAttemptIds: throwingGuestAttemptIds(),
        })).resolves.toMatchObject({ ok: false, status: "invalid_credentials" });
    });

    it("does not inspect guest IDs when the login rate limit rejects first", async () => {
        controls.rateAllowed = false;
        await expect(issueStudentSession({
            workspaceId: "default",
            name: "김학생",
            groupId: "class-1",
            studentLookup: "student-1",
            guestAttemptIds: throwingGuestAttemptIds(),
        })).resolves.toMatchObject({ ok: false, status: "rate_limited" });
    });
});
