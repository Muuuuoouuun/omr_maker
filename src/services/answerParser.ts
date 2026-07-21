// Answer parsing utility using PDF text extraction and Gemini AI for OCR
import { analyzeAnswerImages } from '@/app/actions/analyzeKey';
import { safeAiAnswerErrorMessage, safeAiAnswerLogMeta } from '@/lib/aiAnswerSafety';
import type { AiAnswerModelRoutingOptions } from '@/lib/aiAnswerModelRouting';

export interface ParsedAnswer {
    questionNum: number;
    answer: number; // 1=A, 2=B...
    score?: number; // Optional point value if detected
    confidence: number; // 0-1
    rawText: string;
}

const MAX_ANSWER_PDF_BYTES = 50 * 1024 * 1024;
const TEXT_PAGE_CONCURRENCY = 4;
const IMAGE_PAGE_CONCURRENCY = 2;

function assertUsableAnswerPdf(file: File): void {
    const hasPdfExtension = file.name.toLowerCase().endsWith(".pdf");
    const hasPdfMimeType = file.type.toLowerCase() === "application/pdf";
    if (!hasPdfExtension && !hasPdfMimeType) {
        throw new Error("PDF 형식의 답지를 선택해주세요.");
    }
    if (file.size <= 0) {
        throw new Error("빈 답지 파일은 인식할 수 없습니다.");
    }
    if (file.size > MAX_ANSWER_PDF_BYTES) {
        throw new Error("답지 PDF는 50MB 이하 파일만 인식할 수 있습니다.");
    }
}

async function mapInBatches<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = [];
    for (let index = 0; index < values.length; index += concurrency) {
        const batch = values.slice(index, index + concurrency);
        results.push(...await Promise.all(batch.map(mapper)));
    }
    return results;
}

function safePageFailureMeta(error: unknown, pageNumber: number) {
    return {
        pageNumber,
        errorName: error instanceof Error ? error.name : typeof error,
    };
}

const ANSWER_MAP: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    D: 4,
    E: 5,
    "①": 1,
    "②": 2,
    "③": 3,
    "④": 4,
    "⑤": 5,
    "가": 1,
    "나": 2,
    "다": 3,
    "라": 4,
    "마": 5,
    "ㄱ": 1,
    "ㄴ": 2,
    "ㄷ": 3,
    "ㄹ": 4,
    "ㅁ": 5,
};

async function getPdfJs() {
    const pdfjsLib = await import('pdfjs-dist');
    // Ensure worker is set up
    if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    }
    return pdfjsLib;
}

export async function parseAnswerKeyPdf(file: File): Promise<ParsedAnswer[]> {
    assertUsableAnswerPdf(file);
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    try {
        const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
        const pageTexts = await mapInBatches(pageNumbers, TEXT_PAGE_CONCURRENCY, async pageNumber => {
            let page: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
            try {
                page = await pdf.getPage(pageNumber);
                const textContent = await page.getTextContent();
                const items = textContent.items
                    .map(rawItem => {
                        const item = rawItem as { str?: unknown; transform?: unknown };
                        const transform = Array.isArray(item.transform) ? item.transform : [];
                        return {
                            str: typeof item.str === "string" ? item.str : "",
                            x: typeof transform[4] === "number" ? transform[4] : 0,
                            y: typeof transform[5] === "number" ? transform[5] : 0,
                        };
                    })
                    .sort((a, b) => Math.abs(a.y - b.y) > 5 ? b.y - a.y : a.x - b.x);

                return items.map(item => item.str).join(" ");
            } catch (error: unknown) {
                console.warn("Answer PDF text page skipped", safePageFailureMeta(error, pageNumber));
                return "";
            } finally {
                page?.cleanup();
            }
        });

        return extractAnswersFromText(pageTexts.join(" "));
    } finally {
        try {
            await pdf.destroy();
        } catch (error: unknown) {
            console.warn("Answer PDF cleanup failed", safePageFailureMeta(error, 0));
        }
    }
}

export function normalizeAnswerValue(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
    }
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const mapped = ANSWER_MAP[trimmed.toUpperCase()] ?? ANSWER_MAP[trimmed];
    if (mapped) return mapped;

    const numeric = trimmed.match(/[1-5](?=\s*번|\s*$|[^0-9])/);
    if (numeric) return Number(numeric[0]);

    // Last resort: only map an isolated single answer token (optionally with a
    // trailing "번"). A substring scan would coerce placeholders like "N/A",
    // "unknown answer", or "가답안 참조" into a confident numeric answer.
    const stripped = trimmed.replace(/\s*번$/, "").trim();
    if (stripped.length === 1) {
        return ANSWER_MAP[stripped.toUpperCase()] ?? ANSWER_MAP[stripped] ?? null;
    }

    return null;
}

function parseNumberValue(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    }
    if (typeof value !== "string") return null;
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
}

function addCandidate(
    candidates: Map<number, ParsedAnswer>,
    questionNum: number,
    answer: number | null,
    confidence: number,
    rawText: string,
    score?: number,
) {
    if (!questionNum || !answer) return;
    const candidate: ParsedAnswer = {
        questionNum,
        answer,
        score,
        confidence,
        rawText: rawText.trim(),
    };
    const previous = candidates.get(questionNum);
    if (!previous || candidate.confidence > previous.confidence) {
        candidates.set(questionNum, candidate);
    }
}

const HORIZONTAL_ANSWER_TABLE_PATTERN = new RegExp(
    String.raw`(?:문항\s*번호|문항|번호)\s*[:：]?\s*([0-9번\s,|/·]+?)\s*(?:정답|답)\s*[:：]?\s*([A-Ea-e①-⑤가나다라마ㄱㄴㄷㄹㅁ1-5번\s,|/·]+?)(?=\s*(?:배점|점수|해설|문항\s*번호|문항|번호)|$)`,
    "g",
);

function answerTokensFromTable(value: string): number[] {
    const tokens = value.match(/[A-Ea-e①-⑤가나다라마ㄱㄴㄷㄹㅁ]|(?<!\d)[1-5](?:\s*번)?(?!\d)/g) || [];
    return tokens
        .map(token => normalizeAnswerValue(token))
        .filter((answer): answer is number => answer !== null);
}

/**
 * Korean answer keys frequently use a transposed table such as:
 * "문항 1 2 3 / 정답 ③ ④ ⑤". Generic adjacent-token parsing cannot
 * safely understand that layout and can turn the question-number row into
 * fake answers, so table spans are recognized (and removed) first.
 */
function extractHorizontalAnswerTables(text: string, candidates: Map<number, ParsedAnswer>): string {
    const consumedRanges: Array<{ start: number; end: number }> = [];
    HORIZONTAL_ANSWER_TABLE_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = HORIZONTAL_ANSWER_TABLE_PATTERN.exec(text)) !== null) {
        const questionNumbers = (match[1].match(/\d{1,3}/g) || []).map(Number);
        const answers = answerTokensFromTable(match[2]);

        if (questionNumbers.length < 2) continue;
        consumedRanges.push({ start: match.index, end: match.index + match[0].length });

        // A shifted/missing cell is more dangerous than returning no result:
        // require exact column alignment and let the teacher use AI/manual review.
        if (questionNumbers.length !== answers.length) continue;

        questionNumbers.forEach((questionNum, index) => {
            addCandidate(candidates, questionNum, answers[index], 0.98, match?.[0] || "");
        });
    }

    if (consumedRanges.length === 0) return text;

    // RegExp match indices use UTF-16 code units, so split the same way.
    const chars = text.split("");
    for (const range of consumedRanges) {
        for (let index = range.start; index < range.end; index++) chars[index] = " ";
    }
    return chars.join("");
}

export function extractAnswersFromText(text: string): ParsedAnswer[] {
    const candidates = new Map<number, ParsedAnswer>();
    const residualText = extractHorizontalAnswerTables(text, candidates);
    // The digit alternative is guarded with a negative lookahead so a decimal
    // fragment ("2.5점" → "5") or a two-digit run is not read as an answer.
    const answerToken = String.raw`([A-Ea-e①-⑤가나다라마ㄱㄴㄷㄹㅁ]|[1-5](?:\s*번)?(?![0-9.점%]))`;

    const patterns: Array<{ regex: RegExp; confidence: number }> = [
        {
            regex: new RegExp(String.raw`(?:^|[^\d])(\d{1,3})\s*번\s*[\.\)\]\:：\-]?\s*${answerToken}`, "g"),
            confidence: 0.93,
        },
        {
            // (?!\d*\.\d) rejects a question number that is really the integer part
            // of a decimal score ("각 2.5점", "배점 1.5") whose "." is the separator.
            regex: new RegExp(String.raw`(?:^|[^\d])(\d{1,3})(?!\d*\.\d)\s*[\.\)\]\:：\-]\s*${answerToken}`, "g"),
            confidence: 0.95,
        },
        {
            regex: new RegExp(String.raw`(?:^|[^\d])(\d{1,3})\s*(?:번|문항)?\s*정답\s*[:：]?\s*${answerToken}`, "g"),
            confidence: 0.86,
        },
        {
            regex: new RegExp(String.raw`(?:^|[^\d])(\d{1,3})\s+${answerToken}(?=\s|$)`, "g"),
            confidence: 0.7,
        },
    ];

    for (const { regex, confidence } of patterns) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(residualText)) !== null) {
            addCandidate(
                candidates,
                Number(match[1]),
                normalizeAnswerValue(match[2]),
                confidence,
                match[0],
            );
        }
    }

    return [...candidates.values()].sort((a, b) => a.questionNum - b.questionNum);
}

export function normalizeGeminiAnswerRows(rows: unknown[]): ParsedAnswer[] {
    const candidates = new Map<number, ParsedAnswer>();

    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        const questionNum = parseNumberValue(
            item.questionNum ?? item.question ?? item.number ?? item.id ?? item.no ?? item.q,
        );
        const answer = normalizeAnswerValue(
            item.answer ?? item.correctAnswer ?? item.correct ?? item.value ?? item.val ?? item.choice,
        );
        const rawScore = item.score ?? item.points ?? item.point;
        const score = rawScore === undefined || rawScore === null || rawScore === ""
            ? undefined
            : Number(rawScore);
        const confidence = typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1
            ? item.confidence
            : 0.95;

        addCandidate(
            candidates,
            questionNum || 0,
            answer,
            confidence,
            JSON.stringify(item),
            Number.isFinite(score) ? score : undefined,
        );
    }

    return [...candidates.values()].sort((a, b) => a.questionNum - b.questionNum);
}

export async function parseAnswerKeyWithGemini(
    file: File,
    geminiApiKey?: string,
    options: AiAnswerModelRoutingOptions = {},
): Promise<ParsedAnswer[]> {
    assertUsableAnswerPdf(file);
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    // Answer keys are often split by subject. Keep the request bounded while
    // covering the same eight-image ceiling enforced by the server action.
    const maxPages = Math.min(pdf.numPages, 8);
    const maxTotalBase64Chars = 8_800_000;
    const maxSingleBase64Chars = 4_800_000;
    const images: string[] = [];

    try {
        const pageNumbers = Array.from({ length: maxPages }, (_, index) => index + 1);
        const renderedPages = await mapInBatches(pageNumbers, IMAGE_PAGE_CONCURRENCY, async pageNumber => {
            let page: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
            const canvas = document.createElement('canvas');
            try {
                page = await pdf.getPage(pageNumber);
                const viewport = page.getViewport({
                    scale: options.recognitionMode === "rerecognition" ? 1.75 : 1.5,
                });
                const context = canvas.getContext('2d');
                canvas.height = Math.ceil(viewport.height);
                canvas.width = Math.ceil(viewport.width);

                if (!context) throw new Error("canvas_context_unavailable");

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await page.render({ canvasContext: context, viewport } as any).promise;
                let image = canvas.toDataURL('image/jpeg', 0.72);
                let base64Chars = image.slice(image.indexOf(",") + 1).length;
                if (base64Chars > maxSingleBase64Chars) {
                    image = canvas.toDataURL('image/jpeg', 0.52);
                    base64Chars = image.slice(image.indexOf(",") + 1).length;
                }
                return { image, base64Chars };
            } catch (error: unknown) {
                console.warn("Answer PDF image page skipped", safePageFailureMeta(error, pageNumber));
                return null;
            } finally {
                page?.cleanup();
                canvas.width = 0;
                canvas.height = 0;
            }
        });

        let totalBase64Chars = 0;
        for (const rendered of renderedPages) {
            if (!rendered || rendered.base64Chars > maxSingleBase64Chars) continue;
            if (totalBase64Chars + rendered.base64Chars > maxTotalBase64Chars) break;
            images.push(rendered.image);
            totalBase64Chars += rendered.base64Chars;
        }
    } finally {
        try {
            await pdf.destroy();
        } catch (error: unknown) {
            console.warn("Answer PDF cleanup failed", safePageFailureMeta(error, 0));
        }
    }

    if (images.length === 0) throw new Error("정답 PDF 이미지를 준비하지 못했습니다.");

    try {
        const aiResults = await analyzeAnswerImages(images, geminiApiKey, options);

        if (!Array.isArray(aiResults)) {
            throw new Error("AI response is not an array");
        }

        return normalizeGeminiAnswerRows(aiResults);
    } catch (e: unknown) {
        console.warn("AI answer parsing failed", safeAiAnswerLogMeta(e, {
            pageCount: images.length,
        }));
        throw new Error(`AI 인식 실패: ${safeAiAnswerErrorMessage(e)}`);
    }
}
