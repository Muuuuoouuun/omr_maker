// Answer parsing utility using PDF text extraction and Gemini AI for OCR
import { analyzeAnswerImages } from '@/app/actions/analyzeKey';

export interface ParsedAnswer {
    questionNum: number;
    answer: number; // 1=A, 2=B...
    confidence: number; // 0-1
    rawText: string;
}

async function getPdfJs() {
    const pdfjsLib = await import('pdfjs-dist');
    // Ensure worker is set up
    if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
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
        // item.transform[5] is Y, item.transform[4] is X
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

function extractAnswersFromText(text: string): ParsedAnswer[] {
    const results: ParsedAnswer[] = [];
    const mapAnswerToNum = (ans: string): number => {
        ans = ans.toUpperCase().trim();
        const map: Record<string, number> = { 'A': 1, 'B': 2, 'C': 3, 'D': 4, 'E': 5, '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5 };
        return map[ans] || 0;
    };

    // Strategy 1: "1. A", "2) B", "3-C" patterns
    // Regex explanation:
    // (\d+) : Question number
    // \s*[\.\)\-]?\s* : Separator (dot, parenthesis, hyphen, or just space)
    // ([A-E①-⑤]) : Answer (A-E or circled numbers)
    const regex1 = /(\d+)\s*[\.\)\-]\s*([A-E①-⑤])/gi;

    let match;
    while ((match = regex1.exec(text)) !== null) {
        const qNum = parseInt(match[1], 10);
        const ansStr = match[2];
        const ansNum = mapAnswerToNum(ansStr);

        if (qNum > 0 && ansNum > 0) {
            // Check if duplicate, keep the one with higher confidence (or just overwrite)
            // Here we assume sequential parsing is mostly correct
            results.push({
                questionNum: qNum,
                answer: ansNum,
                confidence: 0.9,
                rawText: match[0]
            });
        }
    }

    // Strategy 2: Table format "1 A", "2 B" (if Strategy 1 failed for many)
    if (results.length < 5) {
        const regex2 = /(\d+)\s+([A-E])/gi;
        while ((match = regex2.exec(text)) !== null) {
            const qNum = parseInt(match[1], 10);
            const ansNum = mapAnswerToNum(match[2]);
            // Avoid duplicates
            if (!results.find(r => r.questionNum === qNum)) {
                results.push({
                    questionNum: qNum,
                    answer: ansNum,
                    confidence: 0.7, // Lower confidence for just space separation
                    rawText: match[0]
                });
            }
        }
    }

    return results.sort((a, b) => a.questionNum - b.questionNum);
}

export async function parseAnswerKeyWithGemini(file: File): Promise<ParsedAnswer[]> {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const maxPages = Math.min(pdf.numPages, 3); // Limit to 3 pages
    const images: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
            await page.render({ canvasContext: context, viewport } as any).promise;
            // Use JPEG instead of PNG to save bandwidth and stay under limits
            images.push(canvas.toDataURL('image/jpeg', 0.8));
        }
    }

    try {
        const aiResults = await analyzeAnswerImages(images);

        if (!Array.isArray(aiResults)) {
            throw new Error("AI response is not an array");
        }

        // Convert to ParsedAnswer format
        return aiResults.map((item: any) => ({
            questionNum: parseInt(item.questionNum || item.id || item.number),
            answer: parseInt(item.answer || item.val),
            confidence: 0.95,
            rawText: JSON.stringify(item)
        })).filter((item: any) => !isNaN(item.questionNum) && !isNaN(item.answer))
            .sort((a: any, b: any) => a.questionNum - b.questionNum);
    } catch (e) {
        console.error("AI Parsing failed:", e);
        throw e;
    }
}
