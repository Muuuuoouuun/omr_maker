"use server";

import { randomUUID } from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { cookies, headers } from "next/headers";
import { resolveGeminiApiKey } from "@/lib/geminiApiKey";
import { authorizeSharedAiRecognition, releaseSharedAiRecognition } from "@/app/actions/premiumAccess";
import {
    extractAnswerJsonArrayPayload,
    invalidAiJsonError,
    safeAiAnswerErrorMessage,
    safeAiAnswerLogMeta,
    validateAnswerImageParts,
    type ValidatedAnswerImagePart,
} from "@/lib/aiAnswerSafety";
import {
    AI_ANSWER_MODELS,
    evaluateAnswerRowsQuality,
    shouldUseHighAccuracyAnswerModel,
    type AiAnswerModelRoutingOptions,
} from "@/lib/aiAnswerModelRouting";
import {
    authorizeTeacherAiActionRequest,
} from "@/lib/aiActionSecurity";
import { TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";

async function requireTeacherAiAccess(): Promise<void> {
    const headerStore = await headers();
    const cookieStore = await cookies();
    const authorization = authorizeTeacherAiActionRequest(
        headerStore,
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!authorization.allowed) {
        throw new Error(authorization.error);
    }
}

function buildAnswerImageParts(imageParts: ValidatedAnswerImagePart[]) {
    return imageParts.map(img => {
        return {
            inlineData: {
                data: img.data,
                mimeType: img.mimeType
            }
        };
    });
}

async function generateAnswerRows(
    genAI: GoogleGenerativeAI,
    modelName: string,
    prompt: string,
    imageParts: ValidatedAnswerImagePart[],
    onProviderCall: () => void,
): Promise<unknown[]> {
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            responseMimeType: "application/json",
        }
    });

    onProviderCall();
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

/** Keep shared and personal model calls predictably bounded per request. */
const MAX_ANSWER_IMAGE_PARTS = 3;

export async function analyzeAnswerImages(
    imageParts: string[],
    personalApiKey?: string,
    options: AiAnswerModelRoutingOptions = {},
) {
    let validatedImageParts: ValidatedAnswerImagePart[] = [];
    let sharedAiRequestId: string | null = null;
    let providerCallStarted = false;
    let providerCallCount = 0;
    const markProviderCallStarted = () => {
        providerCallStarted = true;
        providerCallCount += 1;
    };

    try {
        await requireTeacherAiAccess();
        validatedImageParts = validateAnswerImageParts(imageParts).slice(0, MAX_ANSWER_IMAGE_PARTS);

        const apiKey = resolveGeminiApiKey(personalApiKey, process.env.GEMINI_API_KEY);
        if (!apiKey) {
            throw new Error("Gemini API key is not configured");
        }

        // A personal key is caller-funded. Shared-key requests additionally reserve
        // the authenticated teacher's plan quota before any model call is made.
        const hasPersonalKey = typeof personalApiKey === "string" && personalApiKey.trim().length > 0;
        if (!hasPersonalKey) {
            sharedAiRequestId = randomUUID();
            const authorization = await authorizeSharedAiRecognition(sharedAiRequestId);
            if (!authorization.ok) {
                throw new Error(authorization.error || "AI 정답 인식 사용량을 확인할 수 없습니다.");
            }
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
        const firstModel = options.recognitionMode === "rerecognition"
            ? AI_ANSWER_MODELS.highAccuracy
            : AI_ANSWER_MODELS.default;

        let rows: unknown[];
        try {
            rows = await generateAnswerRows(genAI, firstModel, prompt, validatedImageParts, markProviderCallStarted);
        } catch (error: unknown) {
            console.warn("AI answer model failed; trying fallback model", safeAiAnswerLogMeta(error, {
                imageCount: validatedImageParts.length,
                model: firstModel,
                fallbackModel: AI_ANSWER_MODELS.fallback,
            }));
            return await generateAnswerRows(genAI, AI_ANSWER_MODELS.fallback, prompt, validatedImageParts, markProviderCallStarted);
        }

        if (firstModel === AI_ANSWER_MODELS.highAccuracy) {
            return rows;
        }

        const qualityReport = evaluateAnswerRowsQuality(rows);
        if (shouldUseHighAccuracyAnswerModel(options, qualityReport)) {
            try {
                return await generateAnswerRows(genAI, AI_ANSWER_MODELS.highAccuracy, prompt, validatedImageParts, markProviderCallStarted);
            } catch (error: unknown) {
                console.warn("High accuracy AI answer model failed; trying fallback model", safeAiAnswerLogMeta(error, {
                    imageCount: validatedImageParts.length,
                    model: AI_ANSWER_MODELS.highAccuracy,
                    fallbackModel: AI_ANSWER_MODELS.fallback,
                    qualityReason: qualityReport.reason,
                }));
                return await generateAnswerRows(genAI, AI_ANSWER_MODELS.fallback, prompt, validatedImageParts, markProviderCallStarted);
            }
        }

        return rows;
    } catch (error: unknown) {
        // Once a provider request starts, real shared-key cost may have been
        // incurred even if parsing or a later retry fails. Keep that usage.
        if (sharedAiRequestId && !providerCallStarted) {
            const release = await releaseSharedAiRecognition(sharedAiRequestId);
            if (!release.ok) {
                console.warn("AI plan reservation release failed", {
                    requestId: sharedAiRequestId,
                    error: release.error,
                });
            }
        }
        console.warn("AI answer analysis failed", safeAiAnswerLogMeta(error, {
            imageCount: validatedImageParts.length || (Array.isArray(imageParts) ? imageParts.length : 0),
            providerCallCount,
        }));
        throw new Error(safeAiAnswerErrorMessage(error));
    }
}
