export const REMOTE_ASSET_BUCKET = "omr-private-assets";
export const REMOTE_ASSET_SIGNED_URL_TTL_SECONDS = 5 * 60;
export const REMOTE_ASSET_MAX_SIGNED_URL_TTL_SECONDS = 15 * 60;
export const REMOTE_PDF_MAX_BYTES = 50 * 1024 * 1024;
export const REMOTE_HANDWRITING_MAX_BYTES = 10 * 1024 * 1024;

export type RemoteAssetKind = "problem_pdf" | "answer_key_pdf" | "attempt_handwriting";

export interface RemoteAssetRecord {
    id: string;
    organizationId: string;
    kind: RemoteAssetKind;
    examId?: string;
    attemptId?: string;
    bucket: typeof REMOTE_ASSET_BUCKET;
    objectPath: string;
    mimeType: "application/pdf" | "application/json";
    byteSize: number;
    sha256Hex: string;
    originalName?: string;
    createdByUserId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface RemoteAssetUploadInput {
    organizationId: string;
    kind: RemoteAssetKind;
    body: Uint8Array;
    examId?: string;
    attemptId?: string;
    originalName?: string;
    createdByUserId?: string;
}

export interface RemoteAssetStoredDataRef {
    store: "remote";
    key: string;
    organizationId: string;
    kind: RemoteAssetKind;
    examId?: string;
    attemptId?: string;
    name?: string;
    mimeType: "application/pdf" | "application/json";
    size: number;
    updatedAt: string;
}

export type RemoteAssetValidationResult =
    | {
        ok: true;
        organizationId: string;
        kind: RemoteAssetKind;
        examId?: string;
        attemptId?: string;
        mimeType: RemoteAssetRecord["mimeType"];
        extension: "pdf" | "json";
        originalName?: string;
        createdByUserId?: string;
    }
    | {
        ok: false;
        error:
            | "invalid_organization"
            | "invalid_owner"
            | "invalid_body"
            | "asset_too_large";
    };

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function isSafeRemoteAssetScopeSegment(value: unknown): value is string {
    return SAFE_SCOPE_SEGMENT.test(clean(value));
}

export function isRemoteAssetUploadByteSizeAllowed(kind: RemoteAssetKind, byteSize: number): boolean {
    const maxBytes = kind === "problem_pdf" || kind === "answer_key_pdf"
        ? REMOTE_PDF_MAX_BYTES
        : REMOTE_HANDWRITING_MAX_BYTES;
    return Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= maxBytes;
}

function cleanOriginalName(value: unknown): string | undefined {
    const normalized = clean(value)
        .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
        .slice(0, 180);
    return normalized || undefined;
}

export function validateRemoteAssetUpload(input: RemoteAssetUploadInput): RemoteAssetValidationResult {
    const organizationId = clean(input.organizationId);
    if (!isSafeRemoteAssetScopeSegment(organizationId)) {
        return { ok: false, error: "invalid_organization" };
    }
    if (!(input.body instanceof Uint8Array) || input.body.byteLength === 0) {
        return { ok: false, error: "invalid_body" };
    }

    const isPdf = input.kind === "problem_pdf" || input.kind === "answer_key_pdf";
    const examId = clean(input.examId);
    const attemptId = clean(input.attemptId);
    if (
        (isPdf && (!isSafeRemoteAssetScopeSegment(examId) || !!attemptId))
        || (!isPdf && (!isSafeRemoteAssetScopeSegment(attemptId) || !!examId))
    ) {
        return { ok: false, error: "invalid_owner" };
    }

    if (!isRemoteAssetUploadByteSizeAllowed(input.kind, input.body.byteLength)) {
        return { ok: false, error: "asset_too_large" };
    }

    return {
        ok: true,
        organizationId,
        kind: input.kind,
        ...(isPdf ? { examId } : { attemptId }),
        mimeType: isPdf ? "application/pdf" : "application/json",
        extension: isPdf ? "pdf" : "json",
        originalName: cleanOriginalName(input.originalName),
        createdByUserId: clean(input.createdByUserId) || undefined,
    };
}

export function buildRemoteAssetObjectPath(input: {
    organizationId: string;
    kind: RemoteAssetKind;
    assetId: string;
    examId?: string;
    attemptId?: string;
}): string | null {
    const organizationId = clean(input.organizationId);
    const assetId = clean(input.assetId);
    if (!isSafeRemoteAssetScopeSegment(organizationId) || !isSafeRemoteAssetScopeSegment(assetId)) return null;

    if (input.kind === "problem_pdf" || input.kind === "answer_key_pdf") {
        const examId = clean(input.examId);
        if (!isSafeRemoteAssetScopeSegment(examId) || clean(input.attemptId)) return null;
        const slot = input.kind === "problem_pdf" ? "problem" : "answer-key";
        return `organizations/${organizationId}/exams/${examId}/${slot}/${assetId}.pdf`;
    }

    const attemptId = clean(input.attemptId);
    if (!isSafeRemoteAssetScopeSegment(attemptId) || clean(input.examId)) return null;
    return `organizations/${organizationId}/attempts/${attemptId}/handwriting/${assetId}.json`;
}

export function remoteAssetPathBelongsToOrganization(objectPath: string, organizationId: string): boolean {
    if (!isSafeRemoteAssetScopeSegment(organizationId)) return false;
    return objectPath.startsWith(`organizations/${organizationId}/`)
        && !objectPath.includes("..")
        && !objectPath.includes("\\");
}

export function normalizeRemoteAssetSignedUrlTtl(seconds?: number): number {
    if (seconds === undefined) return REMOTE_ASSET_SIGNED_URL_TTL_SECONDS;
    if (!Number.isFinite(seconds)) return REMOTE_ASSET_SIGNED_URL_TTL_SECONDS;
    return Math.min(
        REMOTE_ASSET_MAX_SIGNED_URL_TTL_SECONDS,
        Math.max(60, Math.floor(seconds)),
    );
}

export function remoteAssetRecordFromRow(row: Record<string, unknown>): RemoteAssetRecord | null {
    const kind = clean(row.kind) as RemoteAssetKind;
    const organizationId = clean(row.organization_id);
    const bucket = clean(row.storage_bucket);
    const objectPath = clean(row.object_path);
    const mimeType = clean(row.mime_type) as RemoteAssetRecord["mimeType"];
    const examId = clean(row.exam_id);
    const attemptId = clean(row.attempt_id);
    if (
        !isSafeRemoteAssetScopeSegment(row.id)
        || !isSafeRemoteAssetScopeSegment(organizationId)
        || !(kind === "problem_pdf" || kind === "answer_key_pdf" || kind === "attempt_handwriting")
        || bucket !== REMOTE_ASSET_BUCKET
        || !remoteAssetPathBelongsToOrganization(objectPath, organizationId)
        || !(mimeType === "application/pdf" || mimeType === "application/json")
        || !Number.isFinite(row.byte_size)
        || (row.byte_size as number) <= 0
        || !/^[a-f0-9]{64}$/.test(clean(row.sha256_hex))
    ) {
        return null;
    }

    const isPdf = kind === "problem_pdf" || kind === "answer_key_pdf";
    if ((isPdf && (!examId || attemptId)) || (!isPdf && (!attemptId || examId))) return null;

    return {
        id: clean(row.id),
        organizationId,
        kind,
        ...(examId ? { examId } : {}),
        ...(attemptId ? { attemptId } : {}),
        bucket: REMOTE_ASSET_BUCKET,
        objectPath,
        mimeType,
        byteSize: row.byte_size as number,
        sha256Hex: clean(row.sha256_hex),
        originalName: clean(row.original_name) || undefined,
        createdByUserId: clean(row.created_by_user_id) || undefined,
        createdAt: clean(row.created_at),
        updatedAt: clean(row.updated_at),
    };
}

export function remoteAssetStoredDataRef(asset: RemoteAssetRecord): RemoteAssetStoredDataRef {
    return {
        store: "remote",
        key: asset.id,
        organizationId: asset.organizationId,
        kind: asset.kind,
        ...(asset.examId ? { examId: asset.examId } : {}),
        ...(asset.attemptId ? { attemptId: asset.attemptId } : {}),
        ...(asset.originalName ? { name: asset.originalName } : {}),
        mimeType: asset.mimeType,
        size: asset.byteSize,
        updatedAt: asset.updatedAt,
    };
}

export function isRemoteAssetStoredDataRef(value: unknown): value is RemoteAssetStoredDataRef {
    if (!value || typeof value !== "object") return false;
    const ref = value as Partial<RemoteAssetStoredDataRef>;
    const kind = clean(ref.kind) as RemoteAssetKind;
    const organizationId = clean(ref.organizationId);
    const key = clean(ref.key);
    const examId = clean(ref.examId);
    const attemptId = clean(ref.attemptId);
    return ref.store === "remote"
        && isSafeRemoteAssetScopeSegment(key)
        && isSafeRemoteAssetScopeSegment(organizationId)
        && (kind === "problem_pdf" || kind === "answer_key_pdf" || kind === "attempt_handwriting")
        && (
            ((kind === "problem_pdf" || kind === "answer_key_pdf") && isSafeRemoteAssetScopeSegment(examId) && !attemptId)
            || (kind === "attempt_handwriting" && isSafeRemoteAssetScopeSegment(attemptId) && !examId)
        );
}
