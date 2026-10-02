import {
    REMOTE_ASSET_BUCKET,
    REMOTE_SIGNED_UPLOAD_TTL_SECONDS,
    REMOTE_STANDARD_UPLOAD_MAX_BYTES,
    buildTeacherRemoteAssetUploadIdentity,
    buildRemoteAssetObjectPath,
    normalizeRemoteAssetSignedUrlTtl,
    remoteAssetPathBelongsToOrganization,
    remoteAssetRecordFromRow,
    validateTeacherRemoteAssetUploadDeclaration,
    type RemoteAssetKind,
    type RemoteAssetRecord,
    type TeacherRemoteAssetUploadDeclaration,
} from "@/lib/remoteAssetContract.server";
import type { WorkspaceContext } from "@/lib/workspaceContext";

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface RemoteAssetMetadataQuery {
    eq(column: string, value: string): RemoteAssetMetadataQuery;
    maybeSingle(): Promise<GatewayResult<Record<string, unknown>>>;
}

interface RemoteAssetStorageBucket {
    upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; cacheControl: string; upsert: false },
    ): Promise<GatewayResult<unknown>>;
    createSignedUrl(
        path: string,
        expiresIn: number,
        options?: { download?: string },
    ): Promise<GatewayResult<{ signedUrl?: string }>>;
    remove(paths: string[]): Promise<GatewayResult<unknown>>;
    createSignedUploadUrl?(
        path: string,
        options: { upsert: false },
    ): Promise<GatewayResult<{ signedUrl?: string; token?: string; path?: string }>>;
    info?(path: string): Promise<GatewayResult<Record<string, unknown>>>;
}

export interface RemoteAssetSupabaseGatewayClient {
    storage: {
        from(bucket: string): RemoteAssetStorageBucket;
    };
    rpc(name: string, params: Record<string, unknown>): Promise<GatewayResult<unknown>>;
    from(table: "omr_remote_assets"): {
        select(columns: string): RemoteAssetMetadataQuery;
    };
}

export type TeacherRemoteAssetPreparedUpload = {
    status: "prepared";
    uploadId: string;
    assetId: string;
    organizationId: string;
    examId: string;
    kind: "problem_pdf" | "answer_key_pdf";
    bucket: typeof REMOTE_ASSET_BUCKET;
    objectPath: string;
    byteSize: number;
    mimeType: "application/pdf";
    sha256Hex: string;
    originalName?: string;
    signedUrl: string;
    token: string;
    mode: "standard" | "tus";
    expiresAt: string;
};

export type TeacherRemoteAssetPrepareResult =
    | TeacherRemoteAssetPreparedUpload
    | {
        status: "invalid_asset" | "metadata_unavailable" | "storage_unavailable";
        error?: string;
        errorCode?: TeacherUploadPublicErrorCode;
    };

export interface TeacherRemoteAssetFinalizeInput {
    uploadId: string;
    organizationId: string;
    examId: string;
    kind: "problem_pdf" | "answer_key_pdf";
    objectPath: string;
    byteSize: number;
    mimeType: "application/pdf";
    sha256Hex: string;
    originalName?: string;
    createdByUserId?: string;
}

export type TeacherRemoteAssetFinalizeResult =
    | { status: "finalized"; asset: RemoteAssetRecord }
    | {
        status: "invalid_object" | "storage_unavailable" | "metadata_unavailable";
        error?: string;
        errorCode?: TeacherUploadPublicErrorCode;
    };

export type TeacherUploadPublicErrorCode =
    | "upload_intent_expired"
    | "upload_request_conflict"
    | "upload_scope_denied"
    | "upload_rate_limited"
    | "upload_limit_exceeded"
    | "upload_reservation_required"
    | "upload_unavailable";

type TeacherAssetMutationIdentity = Pick<WorkspaceContext,
    "organizationId" | "actorUserId" | "accountId" | "accountSessionGeneration" | "sessionAuthority"
>;

export type RemoteAssetSignedUrlResult =
    | { status: "signed"; asset: RemoteAssetRecord; signedUrl: string; expiresIn: number }
    | { status: "not_found" | "scope_denied" | "storage_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: { message?: string } | null, fallback: string): string {
    return clean(error?.message) || fallback;
}

function publicTeacherUploadFailure(error: { message?: string } | null): {
    errorCode: TeacherUploadPublicErrorCode;
    error: string;
} {
    const raw = clean(error?.message).toLowerCase();
    if (raw.includes("expired")) {
        return { errorCode: "upload_intent_expired", error: "Teacher upload intent expired" };
    }
    if (raw.includes("idempotency") || raw.includes("another request")) {
        return { errorCode: "upload_request_conflict", error: "Teacher upload request conflicts with an earlier attempt" };
    }
    if (
        raw.includes("another organization")
        || raw.includes("another actor")
        || raw.includes("outside actor scope")
        || raw.includes("scope denied")
    ) {
        return { errorCode: "upload_scope_denied", error: "Teacher upload scope denied" };
    }
    if (raw.includes("rate exceeded") || raw.includes("rate limit")) {
        return { errorCode: "upload_rate_limited", error: "Teacher upload rate limit exceeded" };
    }
    if (raw.includes("active intent limit") || raw.includes("upload limit")) {
        return { errorCode: "upload_limit_exceeded", error: "Teacher upload active intent limit exceeded" };
    }
    if (raw.includes("reservation required") || raw.includes("plan reservation")) {
        return { errorCode: "upload_reservation_required", error: "Teacher upload requires an active exam reservation" };
    }
    return { errorCode: "upload_unavailable", error: "Teacher upload service unavailable" };
}

function teacherUploadScopeDenied(): {
    errorCode: TeacherUploadPublicErrorCode;
    error: string;
} {
    return { errorCode: "upload_scope_denied", error: "Teacher upload scope denied" };
}

function teacherUploadStorageUnavailable(): {
    errorCode: TeacherUploadPublicErrorCode;
    error: string;
} {
    return { errorCode: "upload_unavailable", error: "Teacher upload storage unavailable" };
}

function addSeconds(iso: string, seconds: number): string | null {
    const value = new Date(iso);
    if (!Number.isFinite(value.getTime())) return null;
    return new Date(value.getTime() + seconds * 1_000).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function storageObjectObservation(data: Record<string, unknown>): {
    size: number | null;
    contentType: string;
    sha256Hex: string;
} {
    // storage-js 2.108.x camelizes FileObjectV2. Custom upload metadata remains
    // inside `metadata`, alongside the provider's size/mimetype fields.
    const metadata = record(data.metadata);
    const rawSize = data.size ?? metadata?.size ?? metadata?.contentLength;
    const size = typeof rawSize === "number" && Number.isSafeInteger(rawSize) ? rawSize : null;
    const contentType = clean(data.contentType) || clean(metadata?.mimetype);
    const sha256Hex = (
        clean(metadata?.sha256Hex)
        || clean(metadata?.sha256_hex)
        || clean(record(metadata?.metadata)?.sha256Hex)
        || clean(record(metadata?.metadata)?.sha256_hex)
    ).toLowerCase();
    return { size, contentType, sha256Hex };
}

export async function prepareTeacherRemoteAssetUploadWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: TeacherRemoteAssetUploadDeclaration,
    options: { now?: string; identity?: TeacherAssetMutationIdentity } = {},
): Promise<TeacherRemoteAssetPrepareResult> {
    const validated = validateTeacherRemoteAssetUploadDeclaration(input);
    if (!validated.ok) return { status: "invalid_asset", error: validated.error };

    const now = clean(options.now) || new Date().toISOString();
    const expiresAt = addSeconds(now, REMOTE_SIGNED_UPLOAD_TTL_SECONDS);
    if (!expiresAt) return { status: "invalid_asset", error: "invalid_timestamp" };

    const identity = buildTeacherRemoteAssetUploadIdentity(validated);
    const declaration = {
        id: identity.uploadId,
        organization_id: validated.organizationId,
        exam_id: validated.examId,
        kind: validated.kind,
        created_by_user_id: validated.createdByUserId || null,
        idempotency_key: validated.idempotencyKey,
        storage_bucket: REMOTE_ASSET_BUCKET,
        object_path: identity.objectPath,
        mime_type: validated.mimeType,
        byte_size: validated.byteSize,
        sha256_hex: validated.sha256Hex,
        original_name: validated.originalName || null,
        expires_at: expiresAt,
    };
    const prepared = await client.rpc("omr_prepare_teacher_asset_upload_v2", {
        p_session_authority: options.identity?.sessionAuthority || "",
        p_account_id: clean(options.identity?.accountId),
        p_session_generation: options.identity?.accountSessionGeneration || 0,
        p_organization_id: validated.organizationId,
        p_actor_user_id: validated.createdByUserId || "",
        p_upload: declaration,
    });
    if (prepared.error) {
        return {
            status: "metadata_unavailable",
            ...publicTeacherUploadFailure(prepared.error),
        };
    }
    const preparedRow = record(prepared.data);
    const authoritativeExpiresAt = clean(preparedRow?.expires_at);
    if (
        !preparedRow
        || clean(preparedRow.id) !== identity.uploadId
        || clean(preparedRow.organization_id) !== validated.organizationId
        || clean(preparedRow.exam_id) !== validated.examId
        || clean(preparedRow.kind) !== validated.kind
        || clean(preparedRow.created_by_user_id) !== clean(validated.createdByUserId)
        || clean(preparedRow.idempotency_key) !== validated.idempotencyKey
        || clean(preparedRow.storage_bucket) !== REMOTE_ASSET_BUCKET
        || clean(preparedRow.object_path) !== identity.objectPath
        || clean(preparedRow.mime_type) !== validated.mimeType
        || preparedRow.byte_size !== validated.byteSize
        || clean(preparedRow.sha256_hex) !== validated.sha256Hex
        || !authoritativeExpiresAt
        || !Number.isFinite(new Date(authoritativeExpiresAt).getTime())
        || !["pending", "uploaded", "finalized"].includes(clean(preparedRow.status))
    ) {
        return { status: "metadata_unavailable", error: "Invalid authoritative upload intent" };
    }
    if (clean(preparedRow.status) === "finalized" && preparedRow.capabilityReplay === true) {
        return {
            status: "metadata_unavailable",
            error: "Teacher upload is already finalized",
            errorCode: "upload_request_conflict",
        };
    }

    const bucket = client.storage.from(REMOTE_ASSET_BUCKET);
    if (!bucket.createSignedUploadUrl) {
        return { status: "storage_unavailable", error: "Signed upload is unavailable" };
    }
    const signed = await bucket.createSignedUploadUrl(identity.objectPath, { upsert: false });
    const signedUrl = clean(signed.data?.signedUrl);
    const token = clean(signed.data?.token);
    if (signed.error || !signedUrl || !token) {
        return {
            status: "storage_unavailable",
            ...teacherUploadStorageUnavailable(),
        };
    }

    return {
        status: "prepared",
        uploadId: identity.uploadId,
        assetId: identity.assetId,
        organizationId: validated.organizationId,
        examId: validated.examId,
        kind: validated.kind,
        bucket: REMOTE_ASSET_BUCKET,
        objectPath: identity.objectPath,
        byteSize: validated.byteSize,
        mimeType: validated.mimeType,
        sha256Hex: validated.sha256Hex,
        originalName: validated.originalName,
        signedUrl,
        token,
        mode: validated.byteSize > REMOTE_STANDARD_UPLOAD_MAX_BYTES ? "tus" : "standard",
        expiresAt: authoritativeExpiresAt,
    };
}

async function verifyBoundedPdfMagic(
    bucket: RemoteAssetStorageBucket,
    objectPath: string,
    expectedByteSize: number,
    fetchImpl: typeof fetch,
): Promise<"valid" | "invalid" | "unavailable"> {
    const signed = await bucket.createSignedUrl(objectPath, 60);
    const signedUrl = clean(signed.data?.signedUrl);
    if (signed.error || !signedUrl) return "unavailable";
    try {
        const response = await fetchImpl(signedUrl, {
            method: "GET",
            headers: { Range: "bytes=0-4" },
            cache: "no-store",
        });
        const contentRange = clean(response.headers.get("content-range"));
        const match = /^bytes 0-4\/(\d+)$/.exec(contentRange);
        if (!response.ok || response.status !== 206 || !match || Number(match[1]) !== expectedByteSize) {
            return "unavailable";
        }
        const prefix = new Uint8Array(await response.arrayBuffer());
        if (prefix.byteLength !== 5) return "unavailable";
        return prefix[0] === 0x25
            && prefix[1] === 0x50
            && prefix[2] === 0x44
            && prefix[3] === 0x46
            && prefix[4] === 0x2d
            ? "valid"
            : "invalid";
    } catch {
        return "unavailable";
    }
}

export async function finalizeTeacherRemoteAssetUploadWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: TeacherRemoteAssetFinalizeInput,
    options: { now?: string; fetchImpl?: typeof fetch; identity?: TeacherAssetMutationIdentity } = {},
): Promise<TeacherRemoteAssetFinalizeResult> {
    const organizationId = clean(input.organizationId);
    const uploadId = clean(input.uploadId);
    const examId = clean(input.examId);
    const expectedPath = buildRemoteAssetObjectPath({
        organizationId,
        examId,
        kind: input.kind,
        assetId: uploadId,
    });
    const sha256Hex = clean(input.sha256Hex).toLowerCase();
    if (
        !expectedPath
        || clean(input.objectPath) !== expectedPath
        || input.mimeType !== "application/pdf"
        || !Number.isSafeInteger(input.byteSize)
        || input.byteSize <= 0
        || !/^[a-f0-9]{64}$/.test(sha256Hex)
    ) {
        return { status: "invalid_object", error: "invalid_declaration" };
    }


    // Resolve the exact actor-bound intent before touching Storage. This
    // service-role-only DB boundary prevents the object metadata endpoint from
    // becoming a cross-actor existence oracle.
    const authorized = await client.rpc("omr_authorize_teacher_asset_finalize_v2", {
        p_session_authority: options.identity?.sessionAuthority || "",
        p_account_id: clean(options.identity?.accountId),
        p_session_generation: options.identity?.accountSessionGeneration || 0,
        p_organization_id: organizationId,
        p_upload_id: uploadId,
        p_actor_user_id: clean(input.createdByUserId),
        p_declaration: {
            exam_id: examId,
            kind: input.kind,
            storage_bucket: REMOTE_ASSET_BUCKET,
            object_path: expectedPath,
            mime_type: input.mimeType,
            byte_size: input.byteSize,
            sha256_hex: sha256Hex,
        },
    });
    const authorizedRow = record(authorized.data);
    if (authorized.error) {
        return { status: "metadata_unavailable", ...publicTeacherUploadFailure(authorized.error) };
    }
    if (
        !authorizedRow
        || clean(authorizedRow.id) !== uploadId
        || clean(authorizedRow.organization_id) !== organizationId
        || clean(authorizedRow.exam_id) !== examId
        || clean(authorizedRow.kind) !== input.kind
        || clean(authorizedRow.created_by_user_id) !== clean(input.createdByUserId)
        || clean(authorizedRow.storage_bucket) !== REMOTE_ASSET_BUCKET
        || clean(authorizedRow.object_path) !== expectedPath
        || clean(authorizedRow.mime_type) !== input.mimeType
        || authorizedRow.byte_size !== input.byteSize
        || clean(authorizedRow.sha256_hex).toLowerCase() !== sha256Hex
        || !["pending", "uploaded", "finalized"].includes(clean(authorizedRow.status))
    ) {
        return { status: "metadata_unavailable", ...teacherUploadScopeDenied() };
    }
    if (clean(authorizedRow.status) === "finalized" && authorizedRow.capabilityReplay === true) {
        const replayed = remoteAssetRecordFromRow(authorizedRow);
        return replayed
            ? { status: "finalized", asset: replayed }
            : { status: "metadata_unavailable", ...teacherUploadScopeDenied() };
    }

    let bucket: ReturnType<RemoteAssetSupabaseGatewayClient["storage"]["from"]>;
    let info: Awaited<ReturnType<NonNullable<ReturnType<RemoteAssetSupabaseGatewayClient["storage"]["from"]>["info"]>>>;
    try {
        bucket = client.storage.from(REMOTE_ASSET_BUCKET);
        if (!bucket.info) {
            return { status: "storage_unavailable", ...teacherUploadStorageUnavailable() };
        }
        info = await bucket.info(expectedPath);
    } catch {
        return { status: "storage_unavailable", ...teacherUploadStorageUnavailable() };
    }
    if (info.error || !info.data) {
        return { status: "storage_unavailable", ...teacherUploadStorageUnavailable() };
    }
    const observed = storageObjectObservation(info.data);
    if (observed.size !== input.byteSize) {
        return { status: "invalid_object", error: "storage_size_mismatch" };
    }
    if (observed.contentType !== input.mimeType) {
        return { status: "invalid_object", error: "storage_content_type_mismatch" };
    }
    if (observed.sha256Hex !== sha256Hex) {
        return { status: "invalid_object", error: "storage_sha256_metadata_mismatch" };
    }
    let pdfMagic: Awaited<ReturnType<typeof verifyBoundedPdfMagic>>;
    try {
        pdfMagic = await verifyBoundedPdfMagic(
            bucket,
            expectedPath,
            input.byteSize,
            options.fetchImpl || fetch,
        );
    } catch {
        return { status: "storage_unavailable", ...teacherUploadStorageUnavailable() };
    }
    if (pdfMagic === "invalid") {
        return { status: "invalid_object", error: "storage_pdf_magic_mismatch" };
    }
    if (pdfMagic === "unavailable") {
        return { status: "storage_unavailable", error: "Bounded PDF verification failed" };
    }

    const finalized = await client.rpc("omr_finalize_teacher_asset_upload_v2", {
        p_session_authority: options.identity?.sessionAuthority || "",
        p_account_id: clean(options.identity?.accountId),
        p_session_generation: options.identity?.accountSessionGeneration || 0,
        p_organization_id: organizationId,
        p_upload_id: uploadId,
        p_actor_user_id: clean(input.createdByUserId),
        p_observation: {
            storage_bucket: REMOTE_ASSET_BUCKET,
            object_path: expectedPath,
            mime_type: observed.contentType,
            byte_size: observed.size,
            sha256_hex: observed.sha256Hex,
        },
    });
    if (finalized.error) {
        return {
            status: "metadata_unavailable",
            ...publicTeacherUploadFailure(finalized.error),
        };
    }

    const finalizedRow = record(finalized.data);
    const authoritativeAsset = finalizedRow ? remoteAssetRecordFromRow(finalizedRow) : null;
    if (
        !authoritativeAsset
        || authoritativeAsset.id !== uploadId
        || authoritativeAsset.organizationId !== organizationId
        || authoritativeAsset.examId !== examId
        || authoritativeAsset.kind !== input.kind
        || authoritativeAsset.objectPath !== expectedPath
        || authoritativeAsset.byteSize !== input.byteSize
        || authoritativeAsset.sha256Hex !== sha256Hex
        || clean(authoritativeAsset.createdByUserId) !== clean(input.createdByUserId)
    ) {
        return { status: "metadata_unavailable", error: "Invalid authoritative finalized intent" };
    }
    return {
        status: "finalized",
        asset: authoritativeAsset,
    };
}

async function loadScopedAssetResult(
    client: RemoteAssetSupabaseGatewayClient,
    input: { assetId: string; organizationId: string },
): Promise<{ asset: RemoteAssetRecord | null; error?: string }> {
    const result = await client
        .from("omr_remote_assets")
        .select("id, organization_id, kind, exam_id, attempt_id, storage_bucket, object_path, mime_type, byte_size, sha256_hex, original_name, created_by_user_id, created_at, updated_at")
        .eq("id", clean(input.assetId))
        .eq("organization_id", clean(input.organizationId))
        .maybeSingle();
    if (result.error) {
        return { asset: null, error: errorMessage(result.error, "Remote asset metadata lookup failed") };
    }
    if (!result.data) return { asset: null };
    try {
        return { asset: remoteAssetRecordFromRow(result.data) };
    } catch {
        return { asset: null, error: "Invalid remote asset metadata" };
    }
}

async function loadScopedAsset(
    client: RemoteAssetSupabaseGatewayClient,
    input: { assetId: string; organizationId: string },
): Promise<RemoteAssetRecord | null> {
    return (await loadScopedAssetResult(client, input)).asset;
}

async function signScopedAsset(
    client: RemoteAssetSupabaseGatewayClient,
    asset: RemoteAssetRecord,
    expiresIn?: number,
): Promise<RemoteAssetSignedUrlResult> {
    if (
        asset.bucket !== REMOTE_ASSET_BUCKET
        || !remoteAssetPathBelongsToOrganization(asset.objectPath, asset.organizationId)
    ) {
        return { status: "scope_denied" };
    }

    const ttl = normalizeRemoteAssetSignedUrlTtl(expiresIn);
    const signed = await client.storage.from(REMOTE_ASSET_BUCKET).createSignedUrl(
        asset.objectPath,
        ttl,
        asset.originalName ? { download: asset.originalName } : undefined,
    );
    const signedUrl = clean(signed.data?.signedUrl);
    if (signed.error || !signedUrl) {
        return { status: "storage_unavailable", error: errorMessage(signed.error, "Signed URL creation failed") };
    }
    return { status: "signed", asset, signedUrl, expiresIn: ttl };
}

export async function createStudentProblemPdfSignedUrlWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: { assetId: string; organizationId: string; examId: string; expiresIn?: number },
): Promise<RemoteAssetSignedUrlResult> {
    const asset = await loadScopedAsset(client, input);
    if (!asset) return { status: "not_found" };
    if (asset.kind !== "problem_pdf" || asset.examId !== clean(input.examId)) {
        return { status: "scope_denied" };
    }
    return signScopedAsset(client, asset, input.expiresIn);
}

export async function createStaffRemoteAssetSignedUrlWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: {
        assetId: string;
        organizationId: string;
        kind: RemoteAssetKind;
        examId?: string;
        attemptId?: string;
        expiresIn?: number;
    },
): Promise<RemoteAssetSignedUrlResult> {
    const asset = await loadScopedAsset(client, input);
    if (!asset) return { status: "not_found" };
    if (
        asset.kind !== input.kind
        || clean(asset.examId) !== clean(input.examId)
        || clean(asset.attemptId) !== clean(input.attemptId)
    ) {
        return { status: "scope_denied" };
    }
    return signScopedAsset(client, asset, input.expiresIn);
}
