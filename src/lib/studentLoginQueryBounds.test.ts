import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";

type QueryRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: null };

const state = vi.hoisted(() => ({
    rowsByTable: new Map<string, QueryRow[]>(),
    calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
    credentialChecks: 0,
}));

class FakeQuery implements PromiseLike<QueryResult> {
    private filters: Array<{ column: string; value: string }> = [];
    private rowLimit: number | null = null;

    constructor(private readonly table: string) {}

    select(...args: unknown[]): this {
        state.calls.push({ table: this.table, method: "select", args });
        return this;
    }

    eq(column: string, value: string): this {
        state.calls.push({ table: this.table, method: "eq", args: [column, value] });
        this.filters.push({ column, value });
        return this;
    }

    order(...args: unknown[]): this {
        state.calls.push({ table: this.table, method: "order", args });
        return this;
    }

    limit(value: number): this {
        state.calls.push({ table: this.table, method: "limit", args: [value] });
        this.rowLimit = value;
        return this;
    }

    async maybeSingle(): Promise<QueryResult> {
        const rows = this.resultRows();
        return { data: rows[0] || null, error: null };
    }

    then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: this.resultRows(), error: null } as QueryResult).then(onfulfilled, onrejected);
    }

    private resultRows(): QueryRow[] {
        const rows = (state.rowsByTable.get(this.table) || []).filter(row => (
            this.filters.every(filter => row[filter.column] === filter.value)
        ));
        return this.rowLimit === null ? rows : rows.slice(0, this.rowLimit);
    }
}

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
    verifyStudentCredentials: async () => {
        state.credentialChecks += 1;
        return { status: "verified" };
    },
}));

import { issueStudentSession, loadStudentLoginDirectory } from "@/app/actions/studentSession";

function activeClass(index: number): QueryRow {
    return {
        id: `class-${index}`,
        organization_id: "default",
        name: `반 ${index}`,
        campus: "본원",
        status: "active",
    };
}

function activeProfile(index: number): QueryRow {
    return {
        id: `student-${index}`,
        organization_id: "default",
        display_name: "김학생",
        external_id: index === 0 ? "101" : `duplicate-${index}`,
        email: null,
        status: "active",
        metadata: {},
    };
}

describe("student login query bounds", () => {
    beforeEach(() => {
        state.rowsByTable.clear();
        state.calls.length = 0;
        state.credentialChecks = 0;
    });

    it("bounds the active public class directory and rejects capacity overflow", async () => {
        state.rowsByTable.set(
            "omr_classes",
            Array.from({ length: INITIAL_OPERATIONS_LIMITS.classes + 1 }, (_, index) => activeClass(index)),
        );

        await expect(loadStudentLoginDirectory("default")).resolves.toEqual({
            status: "error",
            error: INITIAL_CAPACITY_EXCEEDED_ERROR,
        });
        expect(state.calls).toContainEqual({
            table: "omr_classes",
            method: "eq",
            args: ["status", "active"],
        });
        expect(state.calls).toContainEqual({
            table: "omr_classes",
            method: "limit",
            args: [INITIAL_OPERATIONS_LIMITS.classes + 1],
        });
    });

    it("bounds exact-name profiles and active class enrollments before credential work", async () => {
        state.rowsByTable.set(
            "omr_student_profiles",
            Array.from({ length: INITIAL_OPERATIONS_LIMITS.activeStudents + 1 }, (_, index) => activeProfile(index)),
        );
        state.rowsByTable.set("omr_class_students", [{
            class_id: "class-1",
            organization_id: "default",
            student_profile_id: "student-0",
            enrollment_status: "active",
        }]);
        state.rowsByTable.set("omr_classes", [activeClass(1)]);

        await expect(issueStudentSession({
            workspaceId: "default",
            name: "김학생",
            groupId: "class-1",
            studentLookup: "101",
            startCode: "123456",
        })).resolves.toEqual({
            ok: false,
            status: "error",
            error: INITIAL_CAPACITY_EXCEEDED_ERROR,
        });

        expect(state.calls).toContainEqual({
            table: "omr_student_profiles",
            method: "limit",
            args: [INITIAL_OPERATIONS_LIMITS.activeStudents + 1],
        });
        expect(state.calls).toContainEqual({
            table: "omr_class_students",
            method: "eq",
            args: ["enrollment_status", "active"],
        });
        expect(state.calls).toContainEqual({
            table: "omr_class_students",
            method: "limit",
            args: [INITIAL_OPERATIONS_LIMITS.activeStudents + 1],
        });
        expect(state.credentialChecks).toBe(0);
    });
});
