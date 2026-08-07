import {
    createExamEntryInviteToken,
    examEntryInviteExpiry,
    hashExamEntryInviteToken,
    EXAM_ENTRY_INVITE_MIN_TTL_MS,
} from "@/lib/examEntryInvite";
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
    | { status: "issued"; token: string; expiresAt: string }
    | { status: "invalid_scope" | "unauthorized" | "service_unavailable" };

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

function boundedUniqueGroupIds(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
    const result = value.map(clean);
    if (result.some(item => !item || item.length > 128) || new Set(result).size !== result.length) return null;
    return result;
}

export async function rotateExamEntryInviteWithGateway(
    client: ExamEntryInviteRpcClient,
    context: WorkspaceContext,
    examIdValue: unknown,
    requestedTtlMs?: number,
    now = Date.now(),
): Promise<ExamEntryInviteRotateResult> {
    const organizationId = clean(context.organizationId);
    const actorUserId = clean(context.actorUserId);
    const examId = clean(examIdValue);
    if (!organizationId || !actorUserId || !examId || examId.length > 256) return { status: "invalid_scope" };
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
        const response = record(result.data);
        if (response.status === "unauthorized") return { status: "unauthorized" };
        if (response.status === "invalid" || response.status === "invalid_scope") return { status: "invalid_scope" };
        const responseExpiry = clean(response.expiresAt);
        if (response.status !== "issued" || !responseExpiry || !Number.isFinite(Date.parse(responseExpiry))) {
            return { status: "service_unavailable" };
        }
        return { status: "issued", token, expiresAt: responseExpiry };
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
