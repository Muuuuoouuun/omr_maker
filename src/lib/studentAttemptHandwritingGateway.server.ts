import { createHash, randomUUID } from "node:crypto";
import {
    REMOTE_ASSET_BUCKET,
    buildRemoteAssetObjectPath,
    remoteAssetRecordFromRow,
    type RemoteAssetRecord,
    type RemoteAssetStoredDataRef,
} from "@/lib/remoteAssetContract.server";
import type { RemoteAssetSupabaseGatewayClient } from "@/lib/remoteAssetGateway.server";

export type StudentAttemptHandwritingArchiveResult =
    | { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | { status: "invalid_asset" | "service_unavailable" };

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function exactAuthoritativeDrawingsRef(
    value: unknown,
    asset: RemoteAssetRecord,
): RemoteAssetStoredDataRef | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
        const prototype = Object.getPrototypeOf(value);
        if ((prototype !== Object.prototype && prototype !== null)
            || Object.getOwnPropertySymbols(value).length > 0) return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const expected = [
            "attemptId", "key", "kind", "mimeType", ...(asset.originalName ? ["name"] : []),
            "organizationId", "size", "store", "updatedAt",
        ].sort();
        const actual = Object.keys(descriptors).sort();
        if (actual.length !== expected.length
            || actual.some((key, index) => key !== expected[index])) return null;
        for (const key of expected) {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        }
        const snapshot = Object.fromEntries(expected.map(key => [key, descriptors[key]!.value]));
        if (snapshot.store !== "remote"
            || snapshot.key !== asset.id
            || snapshot.organizationId !== asset.organizationId
            || snapshot.kind !== "attempt_handwriting"
            || snapshot.attemptId !== asset.attemptId
            || snapshot.mimeType !== "application/json"
            || snapshot.size !== asset.byteSize
            || (asset.originalName ? snapshot.name !== asset.originalName : "name" in snapshot)
            || typeof snapshot.updatedAt !== "string"
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(snapshot.updatedAt)
        ) return null;
        return snapshot as unknown as RemoteAssetStoredDataRef;
    } catch {
        return null;
    }
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

async function uploadPreparedHandwritingObject(
    client: RemoteAssetSupabaseGatewayClient,
    asset: RemoteAssetRecord,
    body: Uint8Array,
): Promise<boolean> {
    if (
        asset.kind !== "attempt_handwriting"
        || asset.bucket !== REMOTE_ASSET_BUCKET
        || asset.mimeType !== "application/json"
        || asset.byteSize !== body.byteLength
        || asset.sha256Hex !== createHash("sha256").update(body).digest("hex")
    ) return false;
    const uploaded = await client.storage.from(asset.bucket).upload(asset.objectPath, body, {
        contentType: asset.mimeType,
        cacheControl: "300",
        upsert: false,
    });
    return !uploaded.error;
}

export async function archiveStudentAttemptHandwritingWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    input: {
        sessionId: string;
        organizationId: string;
        ownerStudentId: string;
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

    const prepared = await client.rpc("omr_prepare_attempt_handwriting_asset_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
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
    if (preparedBody.status === "attached") {
        const authoritativeRef = exactAuthoritativeDrawingsRef(preparedBody.drawingsRef, asset);
        return authoritativeRef
            ? { status: "uploaded", ref: authoritativeRef }
            : { status: "service_unavailable" };
    }

    let objectReady = false;
    if (preparedBody.objectRequired === false) {
        const info = await client.storage.from(REMOTE_ASSET_BUCKET).info?.(asset.objectPath);
        objectReady = !!info && !info.error && observedStorageObjectMatches(info.data, asset);
    }
    if (!objectReady) {
        const uploaded = await uploadPreparedHandwritingObject(client, asset, input.body);
        if (uploaded) {
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

    const attached = await client.rpc("omr_attach_attempt_handwriting_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_ticket_id: input.attachmentTicketId,
        p_asset_id: asset.id,
    });
    if (attached.error) {
        // The DB transaction may have committed and only the response may have
        // been lost. Never discard here; the next exact prepare replays the
        // authoritative attached ref, while an unattached reservation expires
        // into the cleanup outbox.
        return { status: "service_unavailable" };
    }
    const attachedBody = record(attached.data);
    const authoritativeRef = exactAuthoritativeDrawingsRef(attachedBody?.drawingsRef, asset);
    return authoritativeRef
        ? { status: "uploaded", ref: authoritativeRef }
        : { status: "service_unavailable" };
}
