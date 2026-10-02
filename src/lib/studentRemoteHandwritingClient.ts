import type { PdfDrawings } from "@/types/omr";
import { isPdfDrawings } from "@/lib/draftRecovery";

export const REMOTE_HANDWRITING_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

type FetchLike = (
    input: string,
    init: { cache: "no-store"; credentials: "omit" },
) => Promise<Response>;

export async function downloadRemoteStudentHandwriting(
    signedUrl: string,
    fetcher: FetchLike = fetch,
): Promise<PdfDrawings | null> {
    if (!/^https?:\/\//i.test(signedUrl.trim())) return null;
    try {
        const response = await fetcher(signedUrl, {
            cache: "no-store",
            credentials: "omit",
        });
        if (!response.ok) return null;
        const contentType = response.headers.get("content-type")?.toLowerCase() || "";
        if (!contentType.includes("application/json")) return null;
        const declaredSize = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > REMOTE_HANDWRITING_DOWNLOAD_MAX_BYTES) return null;
        const body = await response.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > REMOTE_HANDWRITING_DOWNLOAD_MAX_BYTES) return null;
        const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
        return isPdfDrawings(parsed) ? parsed : null;
    } catch {
        return null;
    }
}
