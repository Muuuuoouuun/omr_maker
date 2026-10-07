import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: null };

const state = vi.hoisted(() => ({
    supabaseConfigured: true,
    rowsByTable: new Map<string, QueryRow[]>(),
    cookieWrites: [] as Array<{ name: string; value: string }>,
}));

class FakeQuery implements PromiseLike<QueryResult> {
    private filters: Array<{ column: string; value: string }> = [];

    constructor(private readonly table: string) {}

    select(): this { return this; }
    order(): this { return this; }
    limit(): this { return this; }

    eq(column: string, value: string): this {
        this.filters.push({ column, value });
        return this;
    }

    async maybeSingle(): Promise<QueryResult> {
        return { data: this.rows()[0] || null, error: null };
    }

    then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: this.rows(), error: null } as QueryResult).then(onfulfilled, onrejected);
    }

    private rows(): QueryRow[] {
        return (state.rowsByTable.get(this.table) || [])
            .filter(row => this.filters.every(filter => row[filter.column] === filter.value));
    }
}

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
    cookies: async () => ({
        get: () => undefined,
        set: (name: string, value: string) => { state.cookieWrites.push({ name, value }); },
        delete: vi.fn(),
    }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => true }));

vi.mock("@/lib/supabaseServerAdmin", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseServerAdmin")>();
    return {
        ...actual,
        getSupabaseServerConfigFromEnv: () => (state.supabaseConfigured
            ? { url: "https://example.supabase.co", serviceRoleKey: "test" }
            : null),
        createSupabaseAdminClient: () => ({
            from: (table: string) => new FakeQuery(table),
            rpc: vi.fn(),
        }),
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
    applyDurableRateLimitToSubjects: async () => ({ allowed: true, retryAfterMs: 0 }),
}));

vi.mock("@/lib/studentCredentialVerifier", () => ({
    verifyStudentCredentials: async () => ({
        status: "verified",
        identity: {
            organizationId: "default",
            studentId: "student-1",
            studentName: "김학생",
            identityType: "registered",
            accountId: `student_credential_${"a".repeat(32)}`,
            credentialGeneration: 1,
        },
    }),
    validateVerifiedStudentCredentialSession: async () => "active",
}));

vi.mock("@/lib/studentGuestClaimGateway", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/studentGuestClaimGateway")>();
    return {
        ...actual,
        claimSignedGuestAttempts: async () => ({ status: "not_requested", acknowledgedAttemptIds: [] }),
    };
});

import { issueStudentSession } from "@/app/actions/studentSession";
import { parseSignedStudentSessionCookie, STUDENT_SERVER_SESSION_COOKIE } from "@/lib/studentServerSession";

function signedSessionCookie() {
    const write = state.cookieWrites.find(entry => entry.name === STUDENT_SERVER_SESSION_COOKIE);
    return parseSignedStudentSessionCookie(write?.value);
}

describe("issued student identity carries the signed identityType (B0)", () => {
    beforeEach(() => {
        state.supabaseConfigured = true;
        state.rowsByTable.clear();
        state.cookieWrites.length = 0;
    });

    it("returns registered for a server-verified login, matching the signed cookie", async () => {
        state.rowsByTable.set("omr_student_profiles", [{
            id: "student-1",
            organization_id: "default",
            display_name: "김학생",
            external_id: "101",
            email: null,
            status: "active",
            metadata: {},
        }]);
        state.rowsByTable.set("omr_class_students", [{
            class_id: "class-1",
            organization_id: "default",
            student_profile_id: "student-1",
            enrollment_status: "active",
        }]);
        state.rowsByTable.set("omr_classes", [{
            id: "class-1",
            organization_id: "default",
            name: "A반",
            campus: "본원",
            status: "active",
        }]);

        const result = await issueStudentSession({
            workspaceId: "default",
            name: "김학생",
            groupId: "class-1",
            studentLookup: "101",
            startCode: "ABCDEF",
        });

        expect(result).toMatchObject({ ok: true, status: "ok" });
        expect(result.identity?.identityType).toBe("registered");
        expect(signedSessionCookie()).toMatchObject({ identityType: "registered", organizationId: "default" });
    });

    it("returns temporary for the degraded local (no Supabase) login, matching the signed cookie", async () => {
        state.supabaseConfigured = false;

        const result = await issueStudentSession({
            workspaceId: "default",
            studentId: "local-student-1",
            name: "김학생",
            groupId: "class-1",
            groupName: "A반",
        });

        expect(result).toMatchObject({ ok: true, status: "degraded_local" });
        expect(result.identity?.identityType).toBe("temporary");
        expect(signedSessionCookie()?.identityType).toBe("temporary");
    });

    it("the root login stores the server-issued identityType instead of a hard-coded value", () => {
        const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
        const serverBranch = page.slice(
            page.indexOf("const result = await issueStudentSession({\n          examId: inviteExamId"),
            page.indexOf("await finishStudentLogin(session, next, undefined, result.guestClaim);"),
        );
        expect(serverBranch).toContain("identityType: identity.identityType");
        expect(serverBranch).not.toContain('identityType: "temporary"');
    });
});
