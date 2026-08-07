import { createHash, randomUUID } from "node:crypto";
import {
    REMOTE_ASSET_BUCKET,
    buildRemoteAssetObjectPath,
    remoteAssetRecordFromRow,
    remoteAssetStoredDataRef,
    type RemoteAssetRecord,
    type RemoteAssetStoredDataRef,
} from "@/lib/remoteAssetContract.server";
import {
    uploadRemoteAssetWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";

export type StudentAttemptHandwritingArchiveResult =
    | { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | { status: "invalid_asset" | "service_unavailable" };

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function canonicalAttemptHandwritingAssetId(sessionId: string, generationId: string): string {
    return `asset_handwriting_${createHash("md5").update(sessionId.trim()).digest("hex")}_${generationId.trim().toLowerCase()}`;
}

function isCanonicalAttemptHandwritingAssetId(sessionId: string, assetId: string): boolean {
    const prefix = `asset_handwriting_${createHash("md5").update(sessionId.trim()).digest("hex")}_`;
    return assetId.startsWith(prefix)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(assetId.slice(prefix.length));
}

function observedStorageObjectMatches(value: unknown, asset: RemoteAssetRecord): boolean {
    const info = record(value);
    const metadata = record(info?.metadata);
    const rawSize = info?.size ?? metadata?.size ?? metadata?.contentLength;
    const mimeType = String(info?.contentType ?? metadata?.mimetype ?? "").trim();
    return rawSize === asset.byteSize && (!mimeType || mimeType === asset.mimeType);
}

async function discardReservation(
    client: RemoteAssetSupabaseGatewayClient,
    sessionId: string,
    assetId: string,
): Promise<void> {
    await client.rpc("omr_discard_attempt_handwriting_asset_v1", {
        p_session_id: sessionId,
        p_asset_id: assetId,
    }).catch(() => undefined);
}

export async function archiveStudentAttemptHandwritingWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: {
        sessionId: string;
        organizationId: string;
        attemptId: string;
        attachmentTicketId: string;
        body: Uint8Array;
        originalName?: string;
    },
): Promise<StudentAttemptHandwritingArchiveResult> {
    const sha256Hex = createHash("sha256").update(input.body).digest("hex");
    const assetId = canonicalAttemptHandwritingAssetId(input.sessionId, randomUUID());
    const objectPath = buildRemoteAssetObjectPath({
        organizationId: input.organizationId,
        kind: "attempt_handwriting",
        attemptId: input.attemptId,
        assetId,
    });
    if (!objectPath) return { status: "invalid_asset" };

    const prepared = await client.rpc("omr_prepare_attempt_handwriting_asset_v1", {
        p_session_id: input.sessionId,
        p_asset: {
            id: assetId,
            organization_id: input.organizationId,
            kind: "attempt_handwriting",
            attempt_id: input.attemptId,
            storage_bucket: REMOTE_ASSET_BUCKET,
            object_path: objectPath,
            mime_type: "application/json",
            byte_size: input.body.byteLength,
            sha256_hex: sha256Hex,
            original_name: input.originalName || null,
        },
    });
    const preparedBody = record(prepared.data);
    const asset = remoteAssetRecordFromRow(record(preparedBody?.asset) || {});
    const authoritativePath = asset && buildRemoteAssetObjectPath({
        organizationId: input.organizationId,
        kind: "attempt_handwriting",
        attemptId: input.attemptId,
        assetId: asset.id,
    });
    if (prepared.error || !preparedBody || !asset
        || !["reserved", "attached"].includes(String(preparedBody.status))
        || !isCanonicalAttemptHandwritingAssetId(input.sessionId, asset.id)
        || asset.organizationId !== input.organizationId
        || asset.kind !== "attempt_handwriting"
        || asset.attemptId !== input.attemptId
        || asset.objectPath !== authoritativePath
        || asset.sha256Hex !== sha256Hex
        || asset.byteSize !== input.body.byteLength) {
        return { status: prepared.error?.message?.includes("invalid canonical")
            ? "invalid_asset"
            : "service_unavailable" };
    }
    const ref = remoteAssetStoredDataRef(asset);
    if (preparedBody.status === "attached") return { status: "uploaded", ref };

    let objectReady = false;
    if (preparedBody.objectRequired === false) {
        const info = await client.storage.from(REMOTE_ASSET_BUCKET).info?.(asset.objectPath);
        objectReady = !!info && !info.error && observedStorageObjectMatches(info.data, asset);
    }
    if (!objectReady) {
        const uploaded = await uploadRemoteAssetWithGateway(client, {
            organizationId: input.organizationId,
            kind: "attempt_handwriting",
            attemptId: input.attemptId,
            body: input.body,
            originalName: input.originalName,
        }, { assetId: asset.id });
        if (uploaded.status === "uploaded") {
            objectReady = true;
        } else {
            // A concurrent/retried immutable upload may have won the same path.
            const info = await client.storage.from(REMOTE_ASSET_BUCKET).info?.(asset.objectPath);
            objectReady = !!info && !info.error && observedStorageObjectMatches(info.data, asset);
        }
    }
    if (!objectReady) {
        await discardReservation(client, input.sessionId, asset.id);
        return { status: "service_unavailable" };
    }

    const attached = await client.rpc("omr_attach_attempt_handwriting_v1", {
        p_ticket_id: input.attachmentTicketId,
        p_asset_id: asset.id,
        p_ref: ref,
    });
    if (attached.error) {
        await discardReservation(client, input.sessionId, asset.id);
        return { status: "service_unavailable" };
    }
    return { status: "uploaded", ref };
}
