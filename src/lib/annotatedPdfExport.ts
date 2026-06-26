import type { PdfDrawings } from "@/types/omr";

type DrawPoint = { x: number; y: number };
type DrawingMode = "click" | "pen" | "highlighter" | "eraser";

interface DrawingPathPayload {
    mode?: DrawingMode;
    color?: string;
    width?: number;
    points?: DrawPoint[];
}

interface RasterPdfPage {
    jpegBytes: Uint8Array;
    imageWidth: number;
    imageHeight: number;
    pageWidth: number;
    pageHeight: number;
}

interface AnnotatedPdfOptions {
    scale?: number;
    jpegQuality?: number;
    maxCanvasSide?: number;
}

function isFinitePoint(value: unknown): value is DrawPoint {
    if (!value || typeof value !== "object") return false;
    const point = value as { x?: unknown; y?: unknown };
    return typeof point.x === "number"
        && typeof point.y === "number"
        && Number.isFinite(point.x)
        && Number.isFinite(point.y);
}

function parseDrawingPath(path: string): DrawingPathPayload | null {
    try {
        const parsed = JSON.parse(path) as DrawingPathPayload;
        if (!Array.isArray(parsed.points)) return null;
        const points = parsed.points.filter(isFinitePoint).map(point => ({
            x: Math.min(1, Math.max(0, point.x)),
            y: Math.min(1, Math.max(0, point.y)),
        }));
        if (points.length === 0) return null;
        return {
            mode: parsed.mode === "highlighter" || parsed.mode === "eraser" || parsed.mode === "pen" ? parsed.mode : "pen",
            color: typeof parsed.color === "string" && parsed.color.trim() ? parsed.color : undefined,
            width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? Math.max(0.5, parsed.width) : undefined,
            points,
        };
    } catch {
        return null;
    }
}

function drawSmoothPath(
    ctx: CanvasRenderingContext2D,
    points: DrawPoint[],
    width: number,
    height: number,
) {
    if (points.length === 0) return;
    ctx.beginPath();
    const first = points[0];
    ctx.moveTo(first.x * width, first.y * height);

    if (points.length === 1) {
        ctx.lineTo(first.x * width + 0.01, first.y * height + 0.01);
        ctx.stroke();
        return;
    }

    for (let index = 1; index < points.length - 1; index += 1) {
        const current = points[index];
        const next = points[index + 1];
        const midX = ((current.x + next.x) / 2) * width;
        const midY = ((current.y + next.y) / 2) * height;
        ctx.quadraticCurveTo(current.x * width, current.y * height, midX, midY);
    }

    const last = points[points.length - 1];
    ctx.lineTo(last.x * width, last.y * height);
    ctx.stroke();
}

export function drawPdfDrawingsToCanvas(
    ctx: CanvasRenderingContext2D,
    paths: string[],
    width: number,
    height: number,
    scale = 1,
) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const path of paths) {
        const parsed = parseDrawingPath(path);
        if (!parsed) continue;
        const mode = parsed.mode || "pen";
        ctx.globalCompositeOperation = mode === "eraser" ? "destination-out" : "source-over";
        ctx.strokeStyle = parsed.color || (mode === "highlighter" ? "rgba(250, 204, 21, 0.38)" : "#ef4444");
        ctx.lineWidth = (parsed.width || (mode === "highlighter" ? 12 : mode === "eraser" ? 22 : 2)) * scale;
        drawSmoothPath(ctx, parsed.points || [], width, height);
    }

    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function encodeAscii(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

export function buildRasterPdfFromJpegPages(pages: RasterPdfPage[]): Blob {
    if (pages.length === 0) {
        throw new Error("At least one page is required to build a PDF");
    }

    const objectChunks = new Map<number, Array<string | Uint8Array>>();
    const addObject = (objectNumber: number, chunks: Array<string | Uint8Array>) => {
        objectChunks.set(objectNumber, [`${objectNumber} 0 obj\n`, ...chunks, "\nendobj\n"]);
    };

    const pageObjectNumbers: number[] = [];
    let nextObjectNumber = 3;

    for (const page of pages) {
        const pageObject = nextObjectNumber++;
        const contentObject = nextObjectNumber++;
        const imageObject = nextObjectNumber++;
        pageObjectNumbers.push(pageObject);

        addObject(pageObject, [
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pageWidth.toFixed(2)} ${page.pageHeight.toFixed(2)}] `,
            `/Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
        ]);

        const content = `q\n${page.pageWidth.toFixed(2)} 0 0 ${page.pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ`;
        addObject(contentObject, [
            `<< /Length ${encodeAscii(content).length} >>\nstream\n`,
            content,
            "\nendstream",
        ]);

        addObject(imageObject, [
            `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} `,
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`,
            page.jpegBytes,
            "\nendstream",
        ]);
    }

    addObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    addObject(2, [`<< /Type /Pages /Kids [${pageObjectNumbers.map(number => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`]);

    const chunks: Uint8Array[] = [];
    const offsets = new Map<number, number>();
    let length = 0;
    const push = (chunk: string | Uint8Array) => {
        const bytes = typeof chunk === "string" ? encodeAscii(chunk) : chunk;
        chunks.push(bytes);
        length += bytes.length;
    };

    push("%PDF-1.4\n");
    for (let objectNumber = 1; objectNumber < nextObjectNumber; objectNumber += 1) {
        const object = objectChunks.get(objectNumber);
        if (!object) continue;
        offsets.set(objectNumber, length);
        object.forEach(push);
    }

    const xrefOffset = length;
    push(`xref\n0 ${nextObjectNumber}\n`);
    push("0000000000 65535 f \n");
    for (let objectNumber = 1; objectNumber < nextObjectNumber; objectNumber += 1) {
        const offset = offsets.get(objectNumber) || 0;
        push(`${offset.toString().padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${nextObjectNumber} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const blobParts: BlobPart[] = chunks.map(chunk => {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        return copy.buffer;
    });
    return new Blob(blobParts, { type: "application/pdf" });
}

export async function buildAnnotatedPdfBlob(
    file: File,
    drawings: PdfDrawings,
    options: AnnotatedPdfOptions = {},
): Promise<Blob> {
    if (typeof document === "undefined") {
        throw new Error("Annotated PDF export requires a browser environment");
    }

    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: RasterPdfPage[] = [];
    const baseScale = options.scale || 1.5;
    const maxCanvasSide = options.maxCanvasSide || 1800;
    const jpegQuality = options.jpegQuality ?? 0.88;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const boundedScale = Math.min(baseScale, maxCanvasSide / Math.max(baseViewport.width, baseViewport.height));
        const renderScale = Math.max(0.5, boundedScale);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas rendering is not available");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        const pageDrawings = drawings[pageNumber] || [];
        if (pageDrawings.length > 0) {
            const overlay = document.createElement("canvas");
            overlay.width = canvas.width;
            overlay.height = canvas.height;
            const overlayCtx = overlay.getContext("2d");
            if (overlayCtx) {
                drawPdfDrawingsToCanvas(overlayCtx, pageDrawings, overlay.width, overlay.height, renderScale);
                ctx.drawImage(overlay, 0, 0);
            }
        }

        pages.push({
            jpegBytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", jpegQuality)),
            imageWidth: canvas.width,
            imageHeight: canvas.height,
            pageWidth: baseViewport.width,
            pageHeight: baseViewport.height,
        });
    }

    await pdf.destroy();
    return buildRasterPdfFromJpegPages(pages);
}
