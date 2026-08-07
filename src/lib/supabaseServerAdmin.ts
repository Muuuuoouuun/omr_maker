import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { workspaceBootstrapRows, type WorkspaceContext } from "@/lib/workspaceContext";
import {
    SUPABASE_ATTEMPT_LIST_READ_COLUMNS,
    SUPABASE_ATTEMPT_READ_COLUMNS,
    SUPABASE_EXAM_LIST_READ_COLUMNS,
    SUPABASE_EXAM_READ_COLUMNS,
    SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS,
    SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS,
} from "@/lib/supabaseReadColumns";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
    normalizeBackendTimeoutMs,
} from "@/lib/initialOperationsPolicy";

type Env = Record<string, string | undefined>;

export interface SupabaseServerConfig {
    url: string;
    serviceRoleKey: string;
    backendTimeoutMs: number;
}

export interface SupabaseMutationResult {
    error: { message?: string } | null;
}

type SupabaseMutationCall = PromiseLike<SupabaseMutationResult>;

interface SupabaseAdminReadResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

export interface SupabaseAdminReadFilter {
    eq(column: string, value: string): SupabaseAdminReadFilter;
    gt(column: string, value: string): SupabaseAdminReadFilter;
    maybeSingle(): PromiseLike<SupabaseAdminReadResult<unknown>>;
    order(column: string, options?: { ascending?: boolean }): SupabaseAdminReadFilter;
    limit(value: number): PromiseLike<SupabaseAdminReadResult<unknown[]>>;
}

export interface SupabaseAdminClientLike {
    rpc(name: string, args: Record<string, unknown>): SupabaseMutationCall;
    from(table: string): {
        upsert(row: unknown): SupabaseMutationCall;
        insert?(row: unknown): SupabaseMutationCall;
        select?(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter };
    };
}

export interface SupabaseAdminReadClientLike {
    from(table: string): { select(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter } };
}

export interface WorkspaceBootstrapResult {
    ok: boolean;
    skipped?: boolean;
    error?: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function getSupabaseServerConfigFromEnv(env: Env = process.env): SupabaseServerConfig | null {
    const url = clean(env.SUPABASE_URL) || clean(env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.OMR_SUPABASE_SERVICE_ROLE_KEY);
    if (!url || !serviceRoleKey) return null;
    return {
        url,
        serviceRoleKey,
        backendTimeoutMs: normalizeBackendTimeoutMs(env.OMR_BACKEND_TIMEOUT_MS),
    };
}

function createDeadlineFetch(timeoutMs: number, fetchImplementation: typeof fetch): typeof fetch {
    const deadlineMs = normalizeBackendTimeoutMs(timeoutMs);

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const deadlineController = new AbortController();
        const requestSignal = typeof Request !== "undefined" && input instanceof Request
            ? input.signal
            : undefined;
        const callerSignal = init?.signal ?? requestSignal;
        const forwardCallerAbort = () => deadlineController.abort(callerSignal?.reason);

        if (callerSignal?.aborted) {
            forwardCallerAbort();
        } else {
            callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
        }

        const timer = callerSignal?.aborted
            ? undefined
            : setTimeout(() => {
                deadlineController.abort(new DOMException("Supabase backend request timed out", "TimeoutError"));
            }, deadlineMs);

        try {
            return await fetchImplementation(input, {
                ...init,
                signal: deadlineController.signal,
            });
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            callerSignal?.removeEventListener("abort", forwardCallerAbort);
        }
    };
}

export function createSupabaseAdminClient(config: SupabaseServerConfig): SupabaseAdminClientLike {
    const deadlineFetch = createDeadlineFetch(config.backendTimeoutMs, globalThis.fetch.bind(globalThis));
    return createClient(config.url, config.serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
        global: {
            fetch: deadlineFetch,
        },
    }) as unknown as SupabaseAdminClientLike;
}

function errorMessage(error: { message?: string } | null, fallback: string): string {
    return error?.message || fallback;
}

export async function bootstrapWorkspaceWithAdminClient(
    client: SupabaseAdminClientLike,
    context: WorkspaceContext,
    now = new Date().toISOString(),
): Promise<WorkspaceBootstrapResult> {
    const rows = workspaceBootstrapRows(context, now);

    // Keep the canonical plan entirely inside one database statement. The RPC
    // inserts new workspaces as Free, but its conflict branch deliberately has
    // no plan assignment, so a login race cannot overwrite billing state.
    const organizationResult = await client.rpc("omr_bootstrap_workspace_organization_v1", {
        p_organization_id: rows.organization.id,
        p_name: rows.organization.name,
        p_metadata: rows.organization.metadata,
        p_updated_at: now,
    });
    if (organizationResult.error) {
        return { ok: false, error: errorMessage(organizationResult.error, "Failed to bootstrap organization") };
    }

    if (rows.userProfile) {
        const userResult = await client.from("omr_user_profiles").upsert(rows.userProfile);
        if (userResult.error) {
            return { ok: false, error: errorMessage(userResult.error, "Failed to bootstrap user profile") };
        }
    }

    if (rows.member) {
        const memberResult = await client.from("omr_organization_members").upsert(rows.member);
        if (memberResult.error) {
            return { ok: false, error: errorMessage(memberResult.error, "Failed to bootstrap organization member") };
        }
    }

    if (rows.teacherProfile) {
        const teacherResult = await client.from("omr_teacher_profiles").upsert(rows.teacherProfile);
        if (teacherResult.error) {
            return { ok: false, error: errorMessage(teacherResult.error, "Failed to bootstrap teacher profile") };
        }
    }

    const auditTable = client.from("omr_audit_logs");
    if (auditTable.insert && context.actorUserId) {
        const auditResult = await auditTable.insert({
            id: `audit_${randomUUID()}`,
            organization_id: context.organizationId,
            actor_user_id: context.actorUserId,
            action: "workspace.bootstrap",
            entity_type: "organization",
            entity_id: context.organizationId,
            metadata: {
                source: "server_action",
                actorLabel: context.actorLabel || null,
            },
            created_at: now,
        });
        if (auditResult.error) {
            return { ok: false, error: errorMessage(auditResult.error, "Failed to write workspace bootstrap audit log") };
        }
    }

    return { ok: true };
}

export async function bootstrapWorkspaceWithServiceRole(
    context: WorkspaceContext,
    env: Env = process.env,
): Promise<WorkspaceBootstrapResult> {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return { ok: false, skipped: true, error: "Supabase service role is not configured" };

    const client = createSupabaseAdminClient(config);
    return bootstrapWorkspaceWithAdminClient(client, context);
}

export async function fetchExamRowById(
    client: SupabaseAdminReadClientLike,
    organizationId: string,
    examId: string,
): Promise<unknown | null> {
    const scope = clean(organizationId);
    const id = clean(examId);
    if (!scope || !id) return null;
    const { data, error } = await client.from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", scope)
        .eq("id", id)
        .maybeSingle();
    if (error) throw new Error(error.message || "Failed to read exam");
    return data ?? null;
}

export async function fetchAttemptRowsByOwner(
    client: SupabaseAdminReadClientLike,
    owner: { organizationId?: string; studentId?: string },
): Promise<unknown[]> {
    // Callers pass the canonical student_id (guests are already normalized to "guest:<id>").
    const key = owner.studentId || "";
    const organizationId = clean(owner.organizationId);
    if (!organizationId || !key) return [];
    const rows: unknown[] = [];
    const ceiling = INITIAL_OPERATIONS_LIMITS.studentAttempts;
    const pageSize = INITIAL_OPERATIONS_LIMITS.listPageSize;
    let cursorId = "";
    while (rows.length <= ceiling) {
        const requestSize = Math.min(pageSize, (ceiling + 1) - rows.length);
        let query = client.from("omr_attempts")
            .select(SUPABASE_ATTEMPT_LIST_READ_COLUMNS)
            .eq("organization_id", organizationId)
            .eq("student_id", key);
        if (cursorId) query = query.gt("id", cursorId);
        const { data, error } = await query
            .order("id", { ascending: true })
            .limit(requestSize);
        if (error) throw new Error(error.message || "Failed to read attempts");
        const page = data ?? [];
        if (page.length === 0) break;
        const pageIds = page.map(row => {
            const record = row as { id?: unknown; payload?: { id?: unknown } };
            return clean(record.id) || clean(record.payload?.id);
        });
        if (
            pageIds.some(id => !id || (cursorId && id <= cursorId))
            || pageIds.some((id, index) => index > 0 && id <= pageIds[index - 1])
        ) {
            throw new Error("Invalid canonical attempt pagination");
        }
        rows.push(...page);
        if (rows.length > ceiling) throw new Error(INITIAL_CAPACITY_EXCEEDED_ERROR);
        cursorId = pageIds[pageIds.length - 1];
        if (page.length < requestSize) break;
    }
    return rows.sort((left, right) => {
        const leftRecord = left as { id?: unknown; finished_at?: unknown; payload?: { id?: unknown; finishedAt?: unknown } };
        const rightRecord = right as { id?: unknown; finished_at?: unknown; payload?: { id?: unknown; finishedAt?: unknown } };
        const leftFinishedAt = clean(leftRecord.finished_at) || clean(leftRecord.payload?.finishedAt);
        const rightFinishedAt = clean(rightRecord.finished_at) || clean(rightRecord.payload?.finishedAt);
        const byFinishedAt = Date.parse(rightFinishedAt) - Date.parse(leftFinishedAt);
        const leftId = clean(leftRecord.id) || clean(leftRecord.payload?.id);
        const rightId = clean(rightRecord.id) || clean(rightRecord.payload?.id);
        return (Number.isFinite(byFinishedAt) ? byFinishedAt : 0) || leftId.localeCompare(rightId);
    });
}

export async function fetchStudentAttemptSummaryRowsByOwner(
    client: SupabaseAdminReadClientLike,
    owner: { organizationId?: string; studentId?: string },
): Promise<unknown[]> {
    const key = clean(owner.studentId);
    const organizationId = clean(owner.organizationId);
    if (!organizationId || !key) return [];
    const rows: unknown[] = [];
    const ceiling = INITIAL_OPERATIONS_LIMITS.studentAttempts;
    const pageSize = INITIAL_OPERATIONS_LIMITS.listPageSize;
    let cursorId = "";
    while (rows.length <= ceiling) {
        const requestSize = Math.min(pageSize, (ceiling + 1) - rows.length);
        let query = client.from("omr_attempts")
            .select(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS)
            .eq("organization_id", organizationId)
            .eq("student_id", key);
        if (cursorId) query = query.gt("id", cursorId);
        const { data, error } = await query
            .order("id", { ascending: true })
            .limit(requestSize);
        if (error) throw new Error(error.message || "Failed to read student attempt summaries");
        const page = data ?? [];
        if (page.length === 0) break;
        const pageIds = page.map(row => clean((row as { id?: unknown }).id));
        if (
            pageIds.some(id => !id || (cursorId && id <= cursorId))
            || pageIds.some((id, index) => index > 0 && id <= pageIds[index - 1])
        ) {
            throw new Error("Invalid student attempt summary pagination");
        }
        rows.push(...page);
        if (rows.length > ceiling) throw new Error(INITIAL_CAPACITY_EXCEEDED_ERROR);
        cursorId = pageIds[pageIds.length - 1];
        if (page.length < requestSize) break;
    }
    return rows.sort((left, right) => {
        const leftRecord = left as { id?: unknown; finished_at?: unknown };
        const rightRecord = right as { id?: unknown; finished_at?: unknown };
        const byFinishedAt = Date.parse(clean(rightRecord.finished_at)) - Date.parse(clean(leftRecord.finished_at));
        return (Number.isFinite(byFinishedAt) ? byFinishedAt : 0)
            || clean(leftRecord.id).localeCompare(clean(rightRecord.id));
    });
}

export async function fetchAttemptRowByOwnerAndId(
    client: SupabaseAdminReadClientLike,
    owner: { organizationId?: string; studentId?: string },
    attemptId: string,
): Promise<unknown | null> {
    const key = owner.studentId || "";
    const organizationId = clean(owner.organizationId);
    if (!organizationId || !key || !attemptId.trim()) return null;
    const { data, error } = await client.from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", organizationId)
        .eq("id", attemptId)
        .eq("student_id", key)
        .maybeSingle();
    if (error) throw new Error(error.message || "Failed to read attempt");
    return data ?? null;
}

export async function fetchExamRowsByOrganization(
    client: SupabaseAdminReadClientLike,
    organizationId: string,
): Promise<unknown[]> {
    if (!organizationId.trim()) return [];
    const { data, error } = await client.from("omr_exams")
        .select(SUPABASE_EXAM_LIST_READ_COLUMNS)
        .eq("organization_id", organizationId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(INITIAL_OPERATIONS_LIMITS.teacherExams + 1);
    if (error) throw new Error(error.message || "Failed to read organization exams");
    if ((data?.length || 0) > INITIAL_OPERATIONS_LIMITS.teacherExams) {
        throw new Error(INITIAL_CAPACITY_EXCEEDED_ERROR);
    }
    return data ?? [];
}

export async function fetchStudentExamRowsByOrganization(
    client: SupabaseAdminReadClientLike,
    organizationId: string,
): Promise<unknown[]> {
    const scope = clean(organizationId);
    if (!scope) return [];
    const { data, error } = await client.from("omr_exams")
        .select(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS)
        .eq("organization_id", scope)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(INITIAL_OPERATIONS_LIMITS.teacherExams + 1);
    if (error) throw new Error(error.message || "Failed to read student assignment previews");
    if ((data?.length || 0) > INITIAL_OPERATIONS_LIMITS.teacherExams) {
        throw new Error(INITIAL_CAPACITY_EXCEEDED_ERROR);
    }
    return data ?? [];
}
