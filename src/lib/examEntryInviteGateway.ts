import {
    createExamEntryInviteToken,
    examEntryInviteExpiry,
    hashExamEntryInviteToken,
    EXAM_ENTRY_INVITE_MIN_TTL_MS,
} from "@/lib/examEntryInvite";
import type { ExamEntryInviteMetadata } from "@/lib/examEntryInviteLifecycle";
import type { WorkspaceContext } from "@/lib/workspaceContext";

export interface ExamEntryInviteRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type ExamEntryInviteScope = {
    organizationId: string;
    examId: string;
    groupIds: string[];
    expiresAt: string;
};

export type ExamEntryInviteResolveResult =
    | { status: "resolved"; scope: ExamEntryInviteScope }
    | { status: "invalid" }
    | { status: "service_unavailable" };

export type ExamEntryInviteRotateResult =
    | { status: "issued"; token: string; expiresAt: string; metadata: ExamEntryInviteMetadata }
    | { status: "invalid_scope" | "unauthorized" | "service_unavailable" };

export type ExamEntryInviteMetadataResult =
    | { status: "found"; metadata: ExamEntryInviteMetadata }
    | { status: "not_found" | "invalid_scope" | "unauthorized" | "service_unavailable" };

export type ExamEntryInviteRevokeResult =
    | { status: "revoked"; metadata: ExamEntryInviteMetadata }
    | { status: "not_found" | "invalid_scope" | "unauthorized" | "service_unavailable" };

// The database measures the lower TTL bound with its own clock after network
// transit. Keep one minute of issuance headroom so a requested minimum invite
// cannot be rejected merely because the RPC arrived milliseconds later.
const RPC_MIN_TTL_TRANSIT_HEADROOM_MS = 60 * 1000;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : {};
}

function lifecycleRecord(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value) && value.length !== 1) return null;
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
        && allowed.every(key => Object.hasOwn(value, key));
}

function hasSecretNamedKey(value: unknown, depth = 0): boolean {
    if (depth > 4 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(item => hasSecretNamedKey(item, depth + 1));
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
        /token|hash/i.test(key) || hasSecretNamedKey(nested, depth + 1));
}

function boundedUniqueGroupIds(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
    const result = value.map(clean);
    if (result.some(item => !item || item.length > 128) || new Set(result).size !== result.length) return null;
    return result;
}

function parseInviteMetadata(value: unknown, expectedExamId: string): ExamEntryInviteMetadata | null {
    if (!value || typeof value !== "object" || Array.isArray(value) || hasSecretNamedKey(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (!hasOnlyKeys(candidate, [
        "inviteId", "examId", "targetType", "targetIds", "generation",
        "issuedAt", "expiresAt", "revokedAt",
    ])) return null;

    const inviteId = clean(candidate.inviteId);
    const examId = clean(candidate.examId);
    const targetIds = boundedUniqueGroupIds(candidate.targetIds);
    const issuedAt = clean(candidate.issuedAt);
    const expiresAt = clean(candidate.expiresAt);
    const issuedMs = Date.parse(issuedAt);
    const expiryMs = Date.parse(expiresAt);
    const revokedAt = candidate.revokedAt === null ? null : clean(candidate.revokedAt);
    const revokedMs = revokedAt === null ? null : Date.parse(revokedAt);
    const generation = candidate.generation;

    if (!/^exam_invite_[a-f0-9]{32}$/.test(inviteId)
        || examId !== expectedExamId
        || candidate.targetType !== "groups"
        || !targetIds
        || typeof generation !== "number"
        || !Number.isSafeInteger(generation)
        || generation < 1
        || generation > 2_147_483_646
        || !Number.isFinite(issuedMs)
        || !Number.isFinite(expiryMs)
        || issuedMs >= expiryMs
        || (revokedAt !== null && (!Number.isFinite(revokedMs) || (revokedMs as number) < issuedMs))) {
        return null;
    }

    return {
        inviteId,
        examId,
        targetType: "groups",
        targetIds,
        generation,
        issuedAt,
        expiresAt,
        revokedAt,
    };
}

function lifecycleScope(
    context: WorkspaceContext,
    examIdValue: unknown,
): { organizationId: string; actorUserId: string; examId: string } | null {
    const organizationId = clean(context.organizationId);
    const actorUserId = clean(context.actorUserId);
    const examId = clean(examIdValue);
    if (!organizationId || organizationId.length > 128
        || !actorUserId || actorUserId.length > 128
        || !examId || examId.length > 256) return null;
    return { organizationId, actorUserId, examId };
}

function lifecycleStatus(response: Record<string, unknown>):
    "not_found" | "invalid_scope" | "unauthorized" | null {
    if (!hasOnlyKeys(response, ["status"])) return null;
    if (response.status === "not_found") return "not_found";
    if (response.status === "invalid" || response.status === "invalid_scope") return "invalid_scope";
    if (response.status === "unauthorized") return "unauthorized";
    return null;
}

export async function rotateExamEntryInviteWithGateway(
    client: ExamEntryInviteRpcClient,
    context: WorkspaceContext,
    examIdValue: unknown,
    requestedTtlMs?: number,
    now = Date.now(),
): Promise<ExamEntryInviteRotateResult> {
    const scope = lifecycleScope(context, examIdValue);
    if (!scope) return { status: "invalid_scope" };
    const { organizationId, actorUserId, examId } = scope;
    const token = createExamEntryInviteToken();
    const tokenHash = hashExamEntryInviteToken(token);
    if (!tokenHash) return { status: "service_unavailable" };
    const expiresAt = new Date(examEntryInviteExpiry(
        now,
        typeof requestedTtlMs === "number"
            ? now + Math.max(requestedTtlMs, EXAM_ENTRY_INVITE_MIN_TTL_MS + RPC_MIN_TTL_TRANSIT_HEADROOM_MS)
            : undefined,
    )).toISOString();
    try {
        const result = await client.rpc("omr_rotate_exam_entry_invite_v1", {
            p_organization_id: organizationId,
            p_exam_id: examId,
            p_actor_user_id: actorUserId,
            p_token_hash: tokenHash,
            p_expires_at: expiresAt,
        });
        if (result.error) return { status: "service_unavailable" };
        const response = lifecycleRecord(result.data);
        if (!response || hasSecretNamedKey(response)) return { status: "service_unavailable" };
        const responseStatus = lifecycleStatus(response);
        if (responseStatus === "unauthorized") return { status: "unauthorized" };
        if (responseStatus === "invalid_scope") return { status: "invalid_scope" };
        if (!hasOnlyKeys(response, ["status", "metadata"])
            || response.status !== "issued") {
            return { status: "service_unavailable" };
        }
        const metadata = parseInviteMetadata(response.metadata, examId);
        if (!metadata) return { status: "service_unavailable" };
        return { status: "issued", token, expiresAt: metadata.expiresAt, metadata };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function getExamEntryInviteMetadataWithGateway(
    client: ExamEntryInviteRpcClient,
    context: WorkspaceContext,
    examIdValue: unknown,
): Promise<ExamEntryInviteMetadataResult> {
    const scope = lifecycleScope(context, examIdValue);
    if (!scope) return { status: "invalid_scope" };
    try {
        const result = await client.rpc("omr_get_exam_entry_invite_metadata_v1", {
            p_organization_id: scope.organizationId,
            p_exam_id: scope.examId,
            p_actor_user_id: scope.actorUserId,
        });
        if (result.error) return { status: "service_unavailable" };
        const response = lifecycleRecord(result.data);
        if (!response || hasSecretNamedKey(response)) return { status: "service_unavailable" };
        const status = lifecycleStatus(response);
        if (status) return { status };
        if (!hasOnlyKeys(response, ["status", "metadata"]) || response.status !== "found") {
            return { status: "service_unavailable" };
        }
        const metadata = parseInviteMetadata(response.metadata, scope.examId);
        return metadata ? { status: "found", metadata } : { status: "service_unavailable" };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function revokeExamEntryInviteWithGateway(
    client: ExamEntryInviteRpcClient,
    context: WorkspaceContext,
    examIdValue: unknown,
): Promise<ExamEntryInviteRevokeResult> {
    const scope = lifecycleScope(context, examIdValue);
    if (!scope) return { status: "invalid_scope" };
    try {
        const result = await client.rpc("omr_revoke_exam_entry_invite_v1", {
            p_organization_id: scope.organizationId,
            p_exam_id: scope.examId,
            p_actor_user_id: scope.actorUserId,
        });
        if (result.error) return { status: "service_unavailable" };
        const response = lifecycleRecord(result.data);
        if (!response || hasSecretNamedKey(response)) return { status: "service_unavailable" };
        const status = lifecycleStatus(response);
        if (status) return { status };
        if (!hasOnlyKeys(response, ["status", "metadata"]) || response.status !== "revoked") {
            return { status: "service_unavailable" };
        }
        const metadata = parseInviteMetadata(response.metadata, scope.examId);
        return metadata ? { status: "revoked", metadata } : { status: "service_unavailable" };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function resolveExamEntryInviteWithGateway(
    client: ExamEntryInviteRpcClient,
    examIdValue: unknown,
    tokenValue: unknown,
    now = Date.now(),
): Promise<ExamEntryInviteResolveResult> {
    const examId = clean(examIdValue);
    const tokenHash = hashExamEntryInviteToken(tokenValue);
    if (!examId || examId.length > 256 || !tokenHash) return { status: "invalid" };
    try {
        const result = await client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: tokenHash,
            p_exam_id: examId,
        });
        if (result.error) return { status: "service_unavailable" };
        const response = record(result.data);
        if (response.status !== "resolved") return { status: "invalid" };
        const organizationId = clean(response.organizationId);
        const responseExamId = clean(response.examId);
        const groupIds = boundedUniqueGroupIds(response.groupIds);
        const expiresAt = clean(response.expiresAt);
        const expiryMs = Date.parse(expiresAt);
        if (!organizationId || organizationId.length > 128 || responseExamId !== examId || !groupIds
            || !Number.isFinite(expiryMs) || expiryMs <= now) {
            return { status: "invalid" };
        }
        return { status: "resolved", scope: { organizationId, examId, groupIds, expiresAt } };
    } catch {
        return { status: "service_unavailable" };
    }
}
