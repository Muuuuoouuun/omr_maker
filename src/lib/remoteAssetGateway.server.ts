import { createHash, randomUUID } from "node:crypto";
import {
    REMOTE_ASSET_BUCKET,
    buildRemoteAssetObjectPath,
    normalizeRemoteAssetSignedUrlTtl,
    remoteAssetPathBelongsToOrganization,
    remoteAssetRecordFromRow,
    validateRemoteAssetUpload,
    type RemoteAssetKind,
    type RemoteAssetRecord,
    type RemoteAssetUploadInput,
} from "@/lib/remoteAssetContract.server";

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
}

export interface RemoteAssetSupabaseGatewayClient {
    storage: {
        from(bucket: string): RemoteAssetStorageBucket;
    };
    rpc(name: "omr_save_remote_asset_metadata_v1", params: {
        p_asset: Record<string, unknown>;
    }): Promise<GatewayResult<unknown>>;
    from(table: "omr_remote_assets"): {
        select(columns: string): RemoteAssetMetadataQuery;
    };
}

export type RemoteAssetUploadResult =
    | { status: "uploaded"; asset: RemoteAssetRecord }
    | {
        status: "invalid_asset" | "storage_unavailable" | "metadata_unavailable";
        error?: string;
    };

export type RemoteAssetSignedUrlResult =
    | { status: "signed"; asset: RemoteAssetRecord; signedUrl: string; expiresIn: number }
    | { status: "not_found" | "scope_denied" | "storage_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: { message?: string } | null, fallback: string): string {
    return clean(error?.message) || fallback;
}

function metadataRow(asset: RemoteAssetRecord): Record<string, unknown> {
    return {
        id: asset.id,
        organization_id: asset.organizationId,
        kind: asset.kind,
        exam_id: asset.examId || null,
        attempt_id: asset.attemptId || null,
        storage_bucket: asset.bucket,
        object_path: asset.objectPath,
        mime_type: asset.mimeType,
        byte_size: asset.byteSize,
        sha256_hex: asset.sha256Hex,
        original_name: asset.originalName || null,
        created_by_user_id: asset.createdByUserId || null,
        created_at: asset.createdAt,
        updated_at: asset.updatedAt,
    };
}

export async function uploadRemoteAssetWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: RemoteAssetUploadInput,
    options: { assetId?: string; now?: string } = {},
): Promise<RemoteAssetUploadResult> {
    const validated = validateRemoteAssetUpload(input);
    if (!validated.ok) return { status: "invalid_asset", error: validated.error };

    const assetId = clean(options.assetId) || `asset_${randomUUID()}`;
    const objectPath = buildRemoteAssetObjectPath({
        organizationId: validated.organizationId,
        kind: validated.kind,
        assetId,
        examId: validated.examId,
        attemptId: validated.attemptId,
    });
    if (!objectPath) return { status: "invalid_asset", error: "invalid_object_path" };

    const now = clean(options.now) || new Date().toISOString();
    const asset: RemoteAssetRecord = {
        id: assetId,
        organizationId: validated.organizationId,
        kind: validated.kind,
        ...(validated.examId ? { examId: validated.examId } : {}),
        ...(validated.attemptId ? { attemptId: validated.attemptId } : {}),
        bucket: REMOTE_ASSET_BUCKET,
        objectPath,
        mimeType: validated.mimeType,
        byteSize: input.body.byteLength,
        sha256Hex: createHash("sha256").update(input.body).digest("hex"),
        originalName: validated.originalName,
        createdByUserId: validated.createdByUserId,
        createdAt: now,
        updatedAt: now,
    };

    const bucket = client.storage.from(REMOTE_ASSET_BUCKET);
    const upload = await bucket.upload(objectPath, input.body, {
        contentType: asset.mimeType,
        cacheControl: "300",
        upsert: false,
    });
    if (upload.error) {
        return { status: "storage_unavailable", error: errorMessage(upload.error, "Remote asset upload failed") };
    }

    const metadata = await client.rpc("omr_save_remote_asset_metadata_v1", {
        p_asset: metadataRow(asset),
    });
    if (metadata.error) {
        await bucket.remove([objectPath]).catch(() => undefined);
        return { status: "metadata_unavailable", error: errorMessage(metadata.error, "Remote asset metadata save failed") };
    }

    return { status: "uploaded", asset };
}

async function loadScopedAsset(
    client: RemoteAssetSupabaseGatewayClient,
    input: { assetId: string; organizationId: string },
): Promise<RemoteAssetRecord | null> {
    const result = await client
        .from("omr_remote_assets")
        .select("id, organization_id, kind, exam_id, attempt_id, storage_bucket, object_path, mime_type, byte_size, sha256_hex, original_name, created_by_user_id, created_at, updated_at")
        .eq("id", clean(input.assetId))
        .eq("organization_id", clean(input.organizationId))
        .maybeSingle();
    if (result.error || !result.data) return null;
    return remoteAssetRecordFromRow(result.data);
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
