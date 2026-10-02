import type { WorkspaceContext } from "./workspaceContext";

const KAKAO_ID_MAX_BYTES = 256;
const KAKAO_TITLE_MAX_BYTES = 512;
const KAKAO_MESSAGE_MAX_BYTES = 4 * 1024;
const KAKAO_REASON_MAX_BYTES = 2 * 1024;
const KAKAO_HREF_MAX_BYTES = 2 * 1024;
const KAKAO_ARRAY_ITEM_MAX_BYTES = 256;
const KAKAO_TARGET_MAX_COUNT = 100;
const KAKAO_REVIEW_COMMAND_MAX_BYTES = 64 * 1024;
const KAKAO_DISPATCH_COMMAND_MAX_BYTES = 8 * 1024;

type GatewayResult<T> = { data: T | null; error: { message?: string } | null };

export interface KakaoReminderGatewayClient {
    rpc(name: string, args: Record<string, unknown>): Promise<GatewayResult<unknown>>;
}

export type KakaoReminderMutationStatus =
    | "saved"
    | "unauthorized"
    | "plan_denied"
    | "legacy_reconciliation_required"
    | "invalid_request"
    | "scope_conflict"
    | "not_found"
    | "invalid_transition"
    | "service_unavailable";

export type KakaoReminderMutationResult = { status: KakaoReminderMutationStatus };

type TeacherMutationIdentity = {
    authority: "account" | "legacy_account";
    accountId: string;
    generation: number;
    organizationId: string;
    actorUserId: string;
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, maximumBytes: number): string | null {
    const normalized = clean(value);
    return normalized && byteLength(normalized) <= maximumBytes ? normalized : null;
}

function boundedNullableString(value: unknown, maximumBytes: number): string | null | undefined {
    if (value === null || value === undefined || value === "") return null;
    const normalized = boundedString(value, maximumBytes);
    return normalized ?? undefined;
}

function boundedLocalHref(value: unknown): string | null | undefined {
    const href = boundedNullableString(value, KAKAO_HREF_MAX_BYTES);
    if (href === null || href === undefined) return href;
    const unsafeCharacter = [...href].some(character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return character === "\\" || /\s/u.test(character) || codePoint < 32 || codePoint === 127;
    });
    return href.startsWith("/") && !href.startsWith("//") && !unsafeCharacter
        ? href
        : undefined;
}

function boundedStringArray(value: unknown, requireUnique = false): string[] | null {
    if (!Array.isArray(value) || value.length > KAKAO_TARGET_MAX_COUNT) return null;
    const normalized = value.map(item => boundedString(item, KAKAO_ARRAY_ITEM_MAX_BYTES));
    if (normalized.some(item => item === null)) return null;
    const strings = normalized as string[];
    return !requireUnique || new Set(strings).size === strings.length ? strings : null;
}

function serializedWithin(value: unknown, maximumBytes: number): boolean {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximumBytes;
    } catch {
        return false;
    }
}

function teacherMutationIdentity(context: WorkspaceContext): TeacherMutationIdentity | null {
    const authority = context.sessionAuthority;
    const accountId = clean(context.accountId);
    const organizationId = clean(context.organizationId);
    const actorUserId = clean(context.actorUserId);
    const generation = context.accountSessionGeneration;
    if ((authority !== "account" && authority !== "legacy_account")
        || !accountId || !organizationId || !actorUserId
        || !Number.isSafeInteger(generation) || (generation ?? 0) < 1
        || !["owner", "admin", "teacher", "assistant"].includes(context.memberRole || "")) return null;
    return {
        authority,
        accountId,
        generation: generation as number,
        organizationId,
        actorUserId,
    };
}

function reviewCommand(value: unknown): Record<string, unknown> | null {
    const row = record(value);
    if (!row || row.channel !== "kakao") return null;
    const id = boundedString(row.id, KAKAO_ID_MAX_BYTES);
    const examId = boundedString(row.exam_id, KAKAO_ID_MAX_BYTES);
    const title = boundedString(row.title, KAKAO_TITLE_MAX_BYTES);
    const messagePreview = boundedString(row.message_preview, KAKAO_MESSAGE_MAX_BYTES);
    const studentIds = boundedStringArray(row.student_ids, true);
    const studentNames = boundedStringArray(row.student_names);
    const groupNames = boundedStringArray(row.group_names);
    const regionNames = boundedStringArray(row.region_names);
    const targetCount = row.target_count;
    const reason = boundedNullableString(row.reason, KAKAO_REASON_MAX_BYTES);
    const href = boundedLocalHref(row.href);
    if (!id || !examId || !title || !messagePreview
        || !studentIds || !studentNames || !groupNames || !regionNames
        || !Number.isSafeInteger(targetCount) || (targetCount as number) < 0
        || (targetCount as number) > KAKAO_TARGET_MAX_COUNT
        || (targetCount as number) !== studentIds.length
        || studentNames.length !== studentIds.length
        || reason === undefined || href === undefined
        || !["missing_exam", "retake_recommendation", "class_retake_recommendation"].includes(clean(row.candidate_kind))
        || !["ready", "hold", "excluded"].includes(clean(row.status))) return null;
    const command = {
        id,
        examId,
        candidateKind: clean(row.candidate_kind),
        status: clean(row.status),
        title,
        targetCount,
        studentIds,
        studentNames,
        groupNames,
        regionNames,
        messagePreview,
        reason,
        href,
    };
    return serializedWithin(command, KAKAO_REVIEW_COMMAND_MAX_BYTES) ? command : null;
}

function dispatchCommand(value: unknown): Record<string, unknown> | null {
    const row = record(value);
    if (!row || row.channel !== "kakao" || row.provider !== "simulation") return null;
    const id = boundedString(row.id, KAKAO_ID_MAX_BYTES);
    const reviewId = boundedString(row.review_id, KAKAO_ID_MAX_BYTES);
    const examId = boundedString(row.exam_id, KAKAO_ID_MAX_BYTES);
    const status = clean(row.status);
    const providerMessageId = boundedNullableString(row.provider_message_id, KAKAO_TITLE_MAX_BYTES);
    const errorMessage = boundedNullableString(row.error_message, KAKAO_REASON_MAX_BYTES);
    if (!id || !reviewId || !examId
        || !["queued", "sent", "failed", "cancelled", "skipped"].includes(status)
        || providerMessageId === undefined || errorMessage === undefined) return null;
    const command = { id, reviewId, examId, status, providerMessageId, errorMessage };
    return serializedWithin(command, KAKAO_DISPATCH_COMMAND_MAX_BYTES) ? command : null;
}

function mutationStatus(value: unknown): KakaoReminderMutationResult {
    const status = clean(record(value)?.status);
    if ([
        "saved",
        "unauthorized",
        "plan_denied",
        "legacy_reconciliation_required",
        "invalid_request",
        "scope_conflict",
        "not_found",
        "invalid_transition",
    ].includes(status)) return { status: status as KakaoReminderMutationStatus };
    return { status: "service_unavailable" };
}

async function mutate(
    client: KakaoReminderGatewayClient,
    rpc: "omr_save_kakao_candidate_review_v1" | "omr_save_kakao_simulation_dispatch_v1",
    payloadName: "p_review" | "p_dispatch",
    payload: Record<string, unknown>,
    identity: TeacherMutationIdentity,
): Promise<KakaoReminderMutationResult> {
    try {
        const result = await client.rpc(rpc, {
            p_session_authority: identity.authority,
            p_account_id: identity.accountId,
            p_session_generation: identity.generation,
            p_organization_id: identity.organizationId,
            p_actor_user_id: identity.actorUserId,
            [payloadName]: payload,
        });
        return result.error ? { status: "service_unavailable" } : mutationStatus(result.data);
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function saveKakaoCandidateReviewWithGateway(
    client: KakaoReminderGatewayClient,
    row: unknown,
    context: WorkspaceContext,
): Promise<KakaoReminderMutationResult> {
    const identity = teacherMutationIdentity(context);
    const payload = reviewCommand(row);
    if (!identity || !payload) return { status: "invalid_request" };
    return mutate(client, "omr_save_kakao_candidate_review_v1", "p_review", payload, identity);
}

export async function saveKakaoSimulationDispatchWithGateway(
    client: KakaoReminderGatewayClient,
    row: unknown,
    context: WorkspaceContext,
): Promise<KakaoReminderMutationResult> {
    const identity = teacherMutationIdentity(context);
    const payload = dispatchCommand(row);
    if (!identity || !payload) return { status: "invalid_request" };
    return mutate(client, "omr_save_kakao_simulation_dispatch_v1", "p_dispatch", payload, identity);
}
