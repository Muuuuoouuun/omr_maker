"use server";

import { cookies } from "next/headers";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { resolveGeminiApiKey } from "@/lib/geminiApiKey";
import { TEACHER_SERVER_SESSION_COOKIE, parseSignedTeacherSessionCookie } from "@/lib/teacherServerSession";
import {
    extractAnswerJsonArrayPayload,
    invalidAiJsonError,
    safeAiAnswerErrorMessage,
    safeAiAnswerLogMeta,
} from "@/lib/aiAnswerSafety";
import {
    AI_ANSWER_MODELS,
    evaluateAnswerRowsQuality,
    shouldUseHighAccuracyAnswerModel,
    type AiAnswerModelRoutingOptions,
} from "@/lib/aiAnswerModelRouting";

function buildAnswerImageParts(imageParts: string[]) {
    return imageParts.map(img => {
        const mimeMatch = img.match(/^data:(.*?);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
        const base64Data = img.indexOf('base64,') !== -1 ? img.split('base64,')[1] : img;

        return {
            inlineData: {
                data: base64Data,
                mimeType: mimeType
            }
        };
    });
}

async function generateAnswerRows(
    genAI: GoogleGenerativeAI,
    modelName: string,
    prompt: string,
    imageParts: string[],
): Promise<unknown[]> {
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            responseMimeType: "application/json",
        }
    });

    const generatedContent = await model.generateContent([
        prompt,
        ...buildAnswerImageParts(imageParts)
    ]);

    const response = await generatedContent.response;
    const text = response.text();
    const jsonStr = extractAnswerJsonArrayPayload(text);

    try {
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) {
            throw invalidAiJsonError(text.length);
        }
        return parsed;
    } catch (error) {
        if (error instanceof Error && error.name === "AIAnswerParseError") {
            throw error;
        }
        throw invalidAiJsonError(text.length);
    }
}

/** Hard server-side cap on images per call, so cost is bounded regardless of the client. */
const MAX_ANSWER_IMAGE_PARTS = 3;

export async function analyzeAnswerImages(
    imageParts: string[],
    personalApiKey?: string,
    options: AiAnswerModelRoutingOptions = {},
) {
    if (!Array.isArray(imageParts) || imageParts.length === 0) {
        throw new Error("분석할 이미지가 없습니다.");
    }
    const images = imageParts.slice(0, MAX_ANSWER_IMAGE_PARTS);

    // Auth gate: the shared server GEMINI_API_KEY may only be spent by an
    // authenticated teacher. This server action is a directly-invocable endpoint,
    // so without this check anyone could burn the platform key. Callers who bring
    // their own personal key are allowed through (they pay for their own usage).
    const hasPersonalKey = typeof personalApiKey === "string" && personalApiKey.trim().length > 0;
    if (!hasPersonalKey) {
        const session = parseSignedTeacherSessionCookie(
            (await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value,
        );
        if (!session) {
            throw new Error("AI 정답 인식은 교사 로그인 후 이용할 수 있습니다. 설정에서 개인 API 키를 등록하거나 로그인하세요.");
        }
    }

    const apiKey = resolveGeminiApiKey(personalApiKey, process.env.GEMINI_API_KEY);
    if (!apiKey) {
        throw new Error("Gemini API key is not configured");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const prompt = `
    You are an expert OMR answer key extractor. 
    Analyze the following images which contain an answer key for an exam.
    Extract the Question Number, the Correct Answer, and the Score (Point Value) if it exists.
    
    Rules:
    1. Answers might be numbers (1-5) or alphabets (A-E). Map alphabets to numbers: A=1, B=2, C=3, D=4, E=5.
    2. Ignore headers, footers, or irrelevant text.
    3. Return ONLY a valid JSON array of objects.
    4. Format: [{"questionNum": 1, "answer": 3, "score": 2}, {"questionNum": 2, "answer": 1, "score": 3}, ...]
    5. Ensure the questionNum and answer are integers.
    6. Ensure the score is a number. If a score/point value is not visible for a question, omit the "score" key or set it to null.
    7. Include "confidence" as a number from 0 to 1 for each row. If uncertain, use a value below 0.65 instead of guessing.
    8. Before returning, self-check for skipped question numbers, duplicate question numbers, and invalid answers.
    `;

    try {
        const firstModel = options.recognitionMode === "rerecognition"
            ? AI_ANSWER_MODELS.highAccuracy
            : AI_ANSWER_MODELS.default;

        let rows: unknown[];
        try {
            rows = await generateAnswerRows(genAI, firstModel, prompt, images);
        } catch (error: unknown) {
            console.warn("AI answer model failed; trying fallback model", safeAiAnswerLogMeta(error, {
                imageCount: images.length,
                model: firstModel,
                fallbackModel: AI_ANSWER_MODELS.fallback,
            }));
            return await generateAnswerRows(genAI, AI_ANSWER_MODELS.fallback, prompt, images);
        }

        if (firstModel === AI_ANSWER_MODELS.highAccuracy) {
            return rows;
        }

        const qualityReport = evaluateAnswerRowsQuality(rows);
        if (shouldUseHighAccuracyAnswerModel(options, qualityReport)) {
            try {
                return await generateAnswerRows(genAI, AI_ANSWER_MODELS.highAccuracy, prompt, images);
            } catch (error: unknown) {
                console.warn("High accuracy AI answer model failed; trying fallback model", safeAiAnswerLogMeta(error, {
                    imageCount: images.length,
                    model: AI_ANSWER_MODELS.highAccuracy,
                    fallbackModel: AI_ANSWER_MODELS.fallback,
                    qualityReason: qualityReport.reason,
                }));
                return await generateAnswerRows(genAI, AI_ANSWER_MODELS.fallback, prompt, images);
            }
        }

        return rows;
    } catch (error: unknown) {
        console.warn("AI answer analysis failed", safeAiAnswerLogMeta(error, {
            imageCount: images.length,
        }));
        throw new Error(safeAiAnswerErrorMessage(error));
    }
}
