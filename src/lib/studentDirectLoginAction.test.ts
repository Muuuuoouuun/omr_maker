import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedStudentSessionCookie, parseSignedStudentSessionCookie } from "@/lib/studentServerSession";

const mocks = vi.hoisted(() => ({
    configured: true,
    sameOrigin: true,
    cookie: "",
    cookieSet: vi.fn(),
    resolve: vi.fn(),
    limiter: vi.fn(),
    claim: vi.fn(),
    client: { rpc: vi.fn() },
}));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ host: "localhost:3003", origin: "http://localhost:3003" }),
    cookies: async () => ({
        get: (name: string) => name === "omr_student_server_session" && mocks.cookie ? { value: mocks.cookie } : undefined,
        set: mocks.cookieSet,
    }),
}));
vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => mocks.sameOrigin }));
vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => mocks.configured ? { url: "https://example.supabase.co", serviceRoleKey: "test" } : null,
    createSupabaseAdminClient: () => mocks.client,
}));
vi.mock("@/lib/studentDirectLoginGateway.server", () => ({ resolveDirectStudentLogin: mocks.resolve }));
vi.mock("@/lib/durableRateLimit", () => ({ applyDurableRateLimitToSubjects: mocks.limiter }));
vi.mock("@/lib/studentGuestClaimGateway", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/studentGuestClaimGateway")>(),
    claimSignedGuestAttempts: mocks.claim,
}));
import { loginStudentWithStartCode } from "@/app/actions/studentSession";

const verified = {
    status: "verified",
    credential: {
        organizationId: "org-private",
        studentId: "student-1",
        studentName: "김학생",
        identityType: "registered",
        accountId: `student_credential_${"a".repeat(32)}`,
        credentialGeneration: 2,
    },
    group: { id: "class-1", name: "A반", region: "서울" },
};
const input = { studentId: "student-1", startCode: "ABC234" };

beforeEach(() => {
    vi.stubEnv("STUDENT_SESSION_SECRET", "student-direct-login-test-session-secret");
    mocks.configured = true;
    mocks.sameOrigin = true;
    mocks.cookie = "";
    mocks.cookieSet.mockReset();
    mocks.resolve.mockReset().mockResolvedValue(verified);
    mocks.limiter.mockReset().mockResolvedValue({ allowed: true });
    mocks.client.rpc.mockReset().mockResolvedValue({ data: true, error: null });
    mocks.claim.mockReset().mockResolvedValue({ status: "not_requested", acknowledgedAttemptIds: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("direct student login action", () => {
    it("issues a registered HttpOnly session with private scope only inside the cookie", async () => {
        const result = await loginStudentWithStartCode(input);
        expect(result).toMatchObject({ ok: true, status: "ok", identity: { studentId: "student-1", name: "김학생", groupId: "class-1" } });
        expect(JSON.stringify(result)).not.toMatch(/org-private|student_credential_|credentialGeneration/);
        const cookie = mocks.cookieSet.mock.calls.find(([name]) => name === "omr_student_server_session")!;
        expect(cookie[2]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
        expect(parseSignedStudentSessionCookie(cookie[1])).toMatchObject({ kind: "student", organizationId: "org-private", identityType: "registered", credentialGeneration: 2 });
        expect(mocks.limiter.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0]);
    });

    it("returns authenticated class choices without issuing a session", async () => {
        const groups = [{ id: "class-1", name: "A반" }, { id: "class-2", name: "B반" }];
        mocks.resolve.mockResolvedValue({ status: "group_required", groups });
        expect(await loginStudentWithStartCode(input)).toEqual({ ok: false, status: "group_required", groups });
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });

    it("clears the failed-login budget after valid credentials before class selection", async () => {
        const limiter = await vi.importActual<typeof import("@/lib/durableRateLimit")>("@/lib/durableRateLimit");
        const options = { env: { NODE_ENV: "development" }, client: null, store: limiter.createInMemoryDurableRateLimitStore(), now: 1_000 };
        mocks.limiter.mockImplementation(request => limiter.applyDurableRateLimitToSubjects(request, options));
        for (let failure = 0; failure < 4; failure += 1) {
            mocks.resolve.mockResolvedValueOnce({ status: "invalid_credentials" });
            expect(await loginStudentWithStartCode(input)).toMatchObject({ status: "invalid_credentials" });
        }
        mocks.resolve.mockResolvedValueOnce({ status: "group_required", groups: [
            { id: "class-1", name: "A반" }, { id: "class-2", name: "B반" },
        ] });
        expect(await loginStudentWithStartCode(input)).toMatchObject({ status: "group_required" });
        expect(await loginStudentWithStartCode({ ...input, groupId: "class-1" })).toMatchObject({ ok: true, status: "ok" });
    });

    it("rejects cross-origin calls before database access", async () => {
        mocks.sameOrigin = false;
        expect(await loginStudentWithStartCode(input)).toEqual({ ok: false, status: "unauthenticated" });
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.limiter).not.toHaveBeenCalled();
    });

    it("fails closed when the durable limiter refuses admission", async () => {
        mocks.limiter.mockResolvedValue({ allowed: false });
        expect(await loginStudentWithStartCode(input)).toMatchObject({ ok: false, status: "rate_limited" });
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });

    it("reports an unavailable durable limiter as a service error before account lookup", async () => {
        mocks.limiter.mockResolvedValue({ allowed: false, reason: "unavailable" });
        expect(await loginStudentWithStartCode(input)).toMatchObject({ ok: false, status: "error" });
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });

    it("never creates a local identity when server storage is unavailable", async () => {
        mocks.configured = false;
        expect(await loginStudentWithStartCode(input)).toEqual({ ok: false, status: "error" });
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });

    it("uses generic failures for rejected credentials and unavailable services", async () => {
        for (const status of ["invalid_credentials", "service_unavailable"]) {
            mocks.resolve.mockResolvedValue({ status });
            expect(await loginStudentWithStartCode({ ...input, studentId: `failure-${status}` })).toEqual({
                ok: false, status: status === "service_unavailable" ? "error" : "invalid_credentials",
            });
        }
        expect(mocks.cookieSet).not.toHaveBeenCalled();
    });

    it("keeps server-owned guest claims when connecting a guest to the account", async () => {
        mocks.cookie = createSignedStudentSessionCookie({ kind: "guest", guestId: "guest-1", name: "게스트", identityType: "guest" })!;
        mocks.claim.mockResolvedValue({ status: "claimed", acknowledgedAttemptIds: ["attempt-1"] });
        const result = await loginStudentWithStartCode({ ...input, guestAttemptIds: ["attempt-1"] });
        if (result.status === "group_required") throw new Error("Expected a completed student session");
        expect(result.guestClaim).toMatchObject({ status: "claimed", acknowledgedAttemptIds: ["attempt-1"] });
        expect(mocks.claim).toHaveBeenCalledWith(mocks.client, expect.objectContaining({
            guest: expect.objectContaining({ kind: "guest", guestId: "guest-1" }),
            student: expect.objectContaining({ studentId: "student-1", organizationId: "org-private" }),
            attemptIds: ["attempt-1"],
        }));
        expect(mocks.cookieSet.mock.calls.some(([name]) => name !== "omr_student_server_session")).toBe(true);
    });
});
