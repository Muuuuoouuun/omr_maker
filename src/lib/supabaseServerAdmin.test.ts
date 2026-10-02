import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";

const supabaseJsMock = vi.hoisted(() => ({
    createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
    createClient: supabaseJsMock.createClient,
}));

import {
    bootstrapWorkspaceWithAdminClient,
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminClientLike,
} from "./supabaseServerAdmin";
import { fetchAttemptRowByOwnerAndId, fetchAttemptRowsByOwner, fetchExamRowById, fetchExamRowsByOrganization, fetchStudentExamRowsByOrganization } from "./supabaseServerAdmin";
import { workspaceContextFromIdentity } from "./workspaceContext";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    supabaseJsMock.createClient.mockReset();
});

function mockAdminClient(failTable?: string): { client: SupabaseAdminClientLike; writes: { table: string; op: string; row: unknown }[] } {
    const writes: { table: string; op: string; row: unknown }[] = [];
    return {
        writes,
        client: {
            async rpc(name: string, args: Record<string, unknown>) {
                writes.push({ table: name, op: "rpc", row: args });
                return { error: name === failTable ? { message: `${name} failed` } : null };
            },
            from(table: string) {
                return {
                    async upsert(row: unknown) {
                        writes.push({ table, op: "upsert", row });
                        return { error: table === failTable ? { message: `${table} failed` } : null };
                    },
                    async insert(row: unknown) {
                        writes.push({ table, op: "insert", row });
                        return { error: table === failTable ? { message: `${table} failed` } : null };
                    },
                };
            },
        },
    };
}

describe("Supabase server admin workspace bootstrap", () => {
    it("requires a server-only service role key and URL", () => {
        expect(getSupabaseServerConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
        })).toBeNull();
        expect(getSupabaseServerConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: " service-role ",
        })).toEqual({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        });
        expect(getSupabaseServerConfigFromEnv({
            SUPABASE_URL: "https://private.supabase.co",
            OMR_SUPABASE_SERVICE_ROLE_KEY: "omr-service-role",
            OMR_BACKEND_TIMEOUT_MS: "12000",
        })).toEqual({
            url: "https://private.supabase.co",
            serviceRoleKey: "omr-service-role",
            backendTimeoutMs: 12_000,
        });
    });

    it("upserts workspace rows before writing an audit log", async () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            email: "teacher-a@example.com",
            displayName: "Teacher A",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
        });
        const { client, writes } = mockAdminClient();

        await expect(bootstrapWorkspaceWithAdminClient(client, context, "2026-06-18T10:00:00.000Z")).resolves.toEqual({ ok: true });

        expect(writes.map(write => [write.table, write.op])).toEqual([
            ["omr_bootstrap_workspace_organization_v1", "rpc"],
            ["omr_user_profiles", "upsert"],
            ["omr_organization_members", "upsert"],
            ["omr_teacher_profiles", "upsert"],
            ["omr_audit_logs", "insert"],
        ]);
        expect(writes[2].row).toMatchObject({
            organization_id: context.organizationId,
            user_id: context.actorUserId,
            role: "teacher",
            status: "active",
        });
        expect(writes[4].row).toMatchObject({
            organization_id: context.organizationId,
            actor_user_id: context.actorUserId,
            action: "workspace.bootstrap",
            entity_type: "organization",
            entity_id: context.organizationId,
        });
    });

    it("never reads or writes the canonical plan during workspace bootstrap", async () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
            organizationId: "teacher_sharedqa",
            memberRole: "teacher",
        });
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client: SupabaseAdminClientLike = {
            async rpc(name, args) {
                calls.push({ name, args });
                return { error: null };
            },
            from(table) {
                if (table === "omr_organizations") {
                    throw new Error("workspace bootstrap must not SELECT or UPSERT the plan row");
                }
                return {
                    async upsert() { return { error: null }; },
                    async insert() { return { error: null }; },
                };
            },
        };

        await expect(bootstrapWorkspaceWithAdminClient(client, context, "2026-06-18T10:00:00.000Z"))
            .resolves.toEqual({ ok: true });
        expect(calls).toEqual([{
            name: "omr_bootstrap_workspace_organization_v1",
            args: {
                p_organization_id: context.organizationId,
                p_name: context.organizationName,
                p_metadata: {
                    source: "omr_maker_workspace",
                    authSource: "teacher_session",
                },
                p_updated_at: "2026-06-18T10:00:00.000Z",
            },
        }]);
        expect(JSON.stringify(calls)).not.toContain('"plan"');
    });

    it("returns the first bootstrap write error without continuing", async () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const { client, writes } = mockAdminClient("omr_organization_members");

        await expect(bootstrapWorkspaceWithAdminClient(client, context, "2026-06-18T10:00:00.000Z")).resolves.toEqual({
            ok: false,
            error: "omr_organization_members failed",
        });

        expect(writes.map(write => write.table)).toEqual([
            "omr_bootstrap_workspace_organization_v1",
            "omr_user_profiles",
            "omr_organization_members",
        ]);
    });
});

describe("Supabase server admin transport", () => {
    function capturedFetch(): typeof fetch {
        const options = supabaseJsMock.createClient.mock.calls[0]?.[2] as {
            global?: { fetch?: typeof fetch };
        };
        if (!options.global?.fetch) throw new Error("Supabase custom fetch was not configured");
        return options.global.fetch;
    }

    it("aborts requests at the configured backend deadline", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            expect(signal).toBeInstanceOf(AbortSignal);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        vi.stubGlobal("fetch", fetchMock);
        supabaseJsMock.createClient.mockReturnValue({});

        createSupabaseAdminClient({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 3_000,
        });
        const request = capturedFetch()("https://example.supabase.co/rest/v1/omr_exams");
        const timeoutExpectation = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2_999);
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await timeoutExpectation;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cleans up the deadline timer when fetch resolves", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal("fetch", fetchMock);
        supabaseJsMock.createClient.mockReturnValue({});

        createSupabaseAdminClient({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        });

        await expect(capturedFetch()("https://example.supabase.co/rest/v1/omr_exams")).resolves.toBeInstanceOf(Response);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not retry PostgREST insert, update, or delete mutations", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockRejectedValue(new Error("network unavailable"));
        vi.stubGlobal("fetch", fetchMock);
        const { createClient: actualCreateClient } = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
        const invokeActualCreateClient = actualCreateClient as unknown as (...args: unknown[]) => unknown;
        supabaseJsMock.createClient.mockImplementation((...args: unknown[]) => invokeActualCreateClient(...args));

        const client = createSupabaseAdminClient({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        }) as unknown as {
            from(table: string): {
                insert(row: unknown): PromiseLike<unknown>;
                update(row: unknown): { eq(column: string, value: string): PromiseLike<unknown> };
                delete(): { eq(column: string, value: string): PromiseLike<unknown> };
            };
        };

        const mutations = [
            {
                method: "POST",
                execute: () => client.from("omr_attempts").insert({ id: "attempt-a" }),
            },
            {
                method: "PATCH",
                execute: () => client.from("omr_attempts").update({ status: "completed" }).eq("id", "attempt-a"),
            },
            {
                method: "DELETE",
                execute: () => client.from("omr_attempts").delete().eq("id", "attempt-a"),
            },
        ];

        for (const mutation of mutations) {
            fetchMock.mockClear();

            await mutation.execute();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(mutation.method);
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves caller abort semantics and removes the deadline timer", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        vi.stubGlobal("fetch", fetchMock);
        supabaseJsMock.createClient.mockReturnValue({});
        const callerController = new AbortController();

        createSupabaseAdminClient({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        });
        const request = capturedFetch()("https://example.supabase.co/rest/v1/omr_exams", {
            signal: callerController.signal,
        });
        const callerReason = new DOMException("caller cancelled", "AbortError");
        callerController.abort(callerReason);

        await expect(request).rejects.toBe(callerReason);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves an AbortSignal carried by a Request object", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        vi.stubGlobal("fetch", fetchMock);
        supabaseJsMock.createClient.mockReturnValue({});
        const callerController = new AbortController();
        const callerReason = new DOMException("request cancelled", "AbortError");

        createSupabaseAdminClient({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        });
        const pending = capturedFetch()(new Request("https://example.supabase.co/rest/v1/omr_exams", {
            signal: callerController.signal,
        }));
        const rejectionExpectation = expect(pending).rejects.toBe(callerReason);
        callerController.abort(callerReason);

        await rejectionExpectation;
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.reason).toBe(callerReason);
        expect(vi.getTimerCount()).toBe(0);
    });
});

function mockReadClient(
    rows: Record<string, unknown[]>,
    calls: Array<[string, string, ...unknown[]]> = [],
) {
    return {
        from(table: string) {
            const data = rows[table] || [];
            const filtered: unknown[] = [...data];
            let afterId = "";
            const builder = {
                _rows: filtered,
                select() { return builder; },
                eq(column: string, value: string) {
                    calls.push([table, "eq", column, value]);
                    builder._rows = builder._rows.filter(
                        row => (row as Record<string, unknown>)[column] === value,
                    );
                    return builder;
                },
                gt(column: string, value: string) {
                    calls.push([table, "gt", column, value]);
                    afterId = value;
                    return builder;
                },
                order(column: string, options?: { ascending?: boolean }) {
                    calls.push([table, "order", column, options]);
                    return builder;
                },
                async limit(value: number) {
                    calls.push([table, "limit", value]);
                    return {
                        data: builder._rows.filter(row => String((row as { id?: unknown }).id || "") > afterId).slice(0, value),
                        error: null,
                    };
                },
                async maybeSingle() { return { data: builder._rows[0] ?? null, error: null }; },
            };
            return builder;
        },
    };
}

describe("Supabase server admin reads", () => {
    it("fetches a single exam row by organization and id", async () => {
        const calls: Array<[string, string, ...unknown[]]> = [];
        const client = mockReadClient({ omr_exams: [
            { id: "shared", organization_id: "org-a", title: "A" },
            { id: "shared", organization_id: "org-b", title: "B" },
        ] }, calls);
        expect(await fetchExamRowById(client, "org-b", "shared"))
            .toEqual({ id: "shared", organization_id: "org-b", title: "B" });
        expect(calls.slice(0, 2)).toEqual([
            ["omr_exams", "eq", "organization_id", "org-b"],
            ["omr_exams", "eq", "id", "shared"],
        ]);
        expect(await fetchExamRowById(client, "", "shared")).toBeNull();
    });

    it("fetches only exams in the signed student's organization", async () => {
        const calls: Array<[string, string, ...unknown[]]> = [];
        const client = mockReadClient({
            omr_exams: [
                { id: "e1", organization_id: "teacher_a" },
                { id: "e2", organization_id: "teacher_b" },
            ],
        }, calls);
        expect(await fetchExamRowsByOrganization(client, "teacher_b"))
            .toEqual([{ id: "e2", organization_id: "teacher_b" }]);
        expect(calls).toEqual([
            ["omr_exams", "eq", "organization_id", "teacher_b"],
            ["omr_exams", "order", "updated_at", { ascending: false }],
            ["omr_exams", "order", "id", { ascending: true }],
            ["omr_exams", "limit", INITIAL_OPERATIONS_LIMITS.teacherExams + 1],
        ]);
    });

    it("fetches bounded student assignment previews in the signed organization", async () => {
        const calls: Array<[string, string, ...unknown[]]> = [];
        const client = mockReadClient({
            omr_exams: [
                { id: "e1", organization_id: "teacher_a", title: "A" },
                { id: "e2", organization_id: "teacher_b", title: "B" },
            ],
        }, calls);

        await expect(fetchStudentExamRowsByOrganization(client, "teacher_b")).resolves.toEqual([
            { id: "e2", organization_id: "teacher_b", title: "B" },
        ]);
        expect(calls).toEqual([
            ["omr_exams", "eq", "organization_id", "teacher_b"],
            ["omr_exams", "order", "updated_at", { ascending: false }],
            ["omr_exams", "order", "id", { ascending: true }],
            ["omr_exams", "limit", INITIAL_OPERATIONS_LIMITS.teacherExams + 1],
        ]);
    });

    it("fetches attempt rows scoped to a guest owner", async () => {
        const calls: Array<[string, string, ...unknown[]]> = [];
        const client = mockReadClient({
            omr_attempts: [
                { id: "a1", organization_id: "org-1", student_id: "guest:g1", exam_id: "e1" },
                { id: "a2", organization_id: "org-1", student_id: "guest:g2", exam_id: "e1" },
            ],
        }, calls);
        const rows = await fetchAttemptRowsByOwner(client, { organizationId: "org-1", studentId: "guest:g1" });
        expect(rows.map(r => (r as { id: string }).id)).toEqual(["a1"]);
        expect(calls).toEqual([
            ["omr_attempts", "eq", "organization_id", "org-1"],
            ["omr_attempts", "eq", "student_id", "guest:g1"],
            ["omr_attempts", "order", "id", { ascending: true }],
            ["omr_attempts", "limit", INITIAL_OPERATIONS_LIMITS.listPageSize],
        ]);
    });

    it("throws the stable capacity error for oversized owner attempt history", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentAttempts + 1 }, (_, index) => ({
            id: `a${String(index).padStart(4, "0")}`,
            organization_id: "org-1",
            student_id: "student-a",
            finished_at: new Date(index).toISOString(),
        }));
        const calls: Array<[string, string, ...unknown[]]> = [];
        const client = mockReadClient({ omr_attempts: rows }, calls);

        await expect(fetchAttemptRowsByOwner(client, { organizationId: "org-1", studentId: "student-a" }))
            .rejects.toThrow("initial_capacity_exceeded");
        expect(calls.filter(([, method]) => method === "gt").at(-1)).toEqual([
            "omr_attempts",
            "gt",
            "id",
            "a0249",
        ]);
        expect(calls.filter(([, method]) => method === "limit").map(([, , value]) => value)).toEqual([
            INITIAL_OPERATIONS_LIMITS.listPageSize,
            1,
        ]);
    });

    it("keeps the owner traversal stable when an earlier row is deleted between keyset pages", async () => {
        let dataset = Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentAttempts }, (_, index) => ({
            id: `a${String(index).padStart(4, "0")}`,
            organization_id: "org-1",
            student_id: "student-a",
            finished_at: new Date(index).toISOString(),
        }));
        let page = 0;
        const client = {
            from() {
                let afterId = "";
                const query = {
                    select() { return query; },
                    eq() { return query; },
                    gt(_column: string, value: string) { afterId = value; return query; },
                    order() { return query; },
                    async limit(value: number) {
                        const selected = dataset.filter(row => row.id > afterId).slice(0, value);
                        page += 1;
                        if (page === 1) dataset = dataset.filter(row => row.id !== "a0000");
                        return { data: selected, error: null };
                    },
                };
                return query;
            },
        };

        const rows = await fetchAttemptRowsByOwner(client as never, { organizationId: "org-1", studentId: "student-a" });
        const ids = rows.map(row => (row as { id: string }).id);
        expect(ids).toHaveLength(INITIAL_OPERATIONS_LIMITS.studentAttempts);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain("a0249");
    });

    it("throws the stable capacity error for oversized organization exam lists", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherExams + 1 }, (_, index) => ({
            id: `e${index}`,
            organization_id: "teacher_a",
        }));
        const client = mockReadClient({ omr_exams: rows });

        await expect(fetchExamRowsByOrganization(client, "teacher_a"))
            .rejects.toThrow("initial_capacity_exceeded");
    });

    it("fetches one retry attempt by organization, id, and owner", async () => {
        const client = mockReadClient({
            omr_attempts: [
                { id: "same", organization_id: "org-a", student_id: "student-b", exam_id: "e1" },
                { id: "same", organization_id: "org-b", student_id: "student-b", exam_id: "e1" },
            ],
        });
        expect(await fetchAttemptRowByOwnerAndId(client, { organizationId: "org-b", studentId: "student-b" }, "same"))
            .toEqual({ id: "same", organization_id: "org-b", student_id: "student-b", exam_id: "e1" });
        expect(await fetchAttemptRowByOwnerAndId(client, { organizationId: "org-c", studentId: "student-b" }, "same"))
            .toBeNull();
        expect(await fetchAttemptRowByOwnerAndId(client, { organizationId: "", studentId: "student-b" }, "same"))
            .toBeNull();
    });

    it("does not let another organization pollute an owner's attempt capacity", async () => {
        const rows = [
            ...Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentAttempts + 1 }, (_, index) => ({
                id: `foreign-${String(index).padStart(4, "0")}`,
                organization_id: "org-foreign",
                student_id: "student-a",
            })),
            { id: "own", organization_id: "org-own", student_id: "student-a" },
        ];
        const client = mockReadClient({ omr_attempts: rows });

        await expect(fetchAttemptRowsByOwner(client, {
            organizationId: "org-own",
            studentId: "student-a",
        })).resolves.toEqual([{ id: "own", organization_id: "org-own", student_id: "student-a" }]);
    });
});
