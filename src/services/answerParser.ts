// Answer parsing utility using PDF text extraction and Gemini AI for OCR
import { analyzeAnswerImages } from '@/app/actions/analyzeKey';

export interface ParsedAnswer {
    questionNum: number;
    answer: number; // 1=A, 2=B...
    score?: number; // Optional point value if detected
    confidence: number; // 0-1
    rawText: string;
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
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let allText = '';

    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();

        // Sort items by Y (descending) then X (ascending) to approximate reading order
        // Note: PDF coordinates: (0,0) is bottom-left usually.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = textContent.items.map((item: any) => ({
            str: item.str,
            x: item.transform[4],
            y: item.transform[5]
        }));

        // Simple sort: Top to bottom, left to right
        items.sort((a, b) => {
            if (Math.abs(a.y - b.y) > 5) { // Threshold for same line
                return b.y - a.y; // Higher Y first
            }
            return a.x - b.x;
        });

        const pageText = items.map(item => item.str).join(' ');
        allText += ` ${pageText}`;
    }

    return extractAnswersFromText(allText);
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

    for (const token of Object.keys(ANSWER_MAP)) {
        if (trimmed.toUpperCase().includes(token.toUpperCase())) {
            return ANSWER_MAP[token];
        }
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

export function extractAnswersFromText(text: string): ParsedAnswer[] {
    const candidates = new Map<number, ParsedAnswer>();
    const answerToken = String.raw`([A-Ea-e①-⑤가나다라마ㄱㄴㄷㄹㅁ]|[1-5]\s*번?)`;

    const patterns: Array<{ regex: RegExp; confidence: number }> = [
        {
            regex: new RegExp(String.raw`(?:^|[^\d])(\d{1,3})\s*[\.\)\]\:：\-]\s*${answerToken}`, "g"),
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
        while ((match = regex.exec(text)) !== null) {
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

export async function parseAnswerKeyWithGemini(file: File, geminiApiKey?: string): Promise<ParsedAnswer[]> {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const maxPages = Math.min(pdf.numPages, 3); // Max 3 pages to prevent heavy payloads
    const images: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        // Decrease scale significantly to 1.0 down from 1.5. This keeps it around ~150kb per image.
        const viewport = page.getViewport({ scale: 1.0 });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await page.render({ canvasContext: context, viewport } as any).promise;
            // Heavily compress jpeg to drastically reduce size and avoid Next.js Body Size Limit
            images.push(canvas.toDataURL('image/jpeg', 0.5));
        }
    }

    try {
        const aiResults = await analyzeAnswerImages(images, geminiApiKey);

        if (!Array.isArray(aiResults)) {
            throw new Error("AI response is not an array");
        }

        return normalizeGeminiAnswerRows(aiResults);
    } catch (e: unknown) {
        console.error("AI Parsing failed:", e);
        const message = e instanceof Error ? e.message : '알 수 없는 오류';
        throw new Error(`AI 인식 실패: ${message}`);
    }
}
