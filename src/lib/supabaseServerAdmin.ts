import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { workspaceBootstrapRows, type WorkspaceContext } from "@/lib/workspaceContext";

type Env = Record<string, string | undefined>;

export interface SupabaseServerConfig {
    url: string;
    serviceRoleKey: string;
}

export interface SupabaseMutationResult {
    error: { message?: string } | null;
}

type SupabaseMutationCall = PromiseLike<SupabaseMutationResult>;

export interface SupabaseAdminClientLike {
    from(table: string): {
        upsert(row: unknown): SupabaseMutationCall;
        insert?(row: unknown): SupabaseMutationCall;
    };
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
    return { url, serviceRoleKey };
}

export function createSupabaseAdminClient(config: SupabaseServerConfig): SupabaseAdminClientLike {
    return createClient(config.url, config.serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
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

    const organizationResult = await client.from("omr_organizations").upsert(rows.organization);
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
