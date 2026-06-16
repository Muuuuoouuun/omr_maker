"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { resolveGeminiApiKey } from "@/lib/geminiApiKey";
import {
    extractAnswerJsonArrayPayload,
    invalidAiJsonError,
    safeAiAnswerErrorMessage,
    safeAiAnswerLogMeta,
} from "@/lib/aiAnswerSafety";

export async function analyzeAnswerImages(imageParts: string[], personalApiKey?: string) {
    const apiKey = resolveGeminiApiKey(personalApiKey, process.env.GEMINI_API_KEY);
    if (!apiKey) {
        throw new Error("Gemini API key is not configured");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
        }
    });

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
    `;

    try {
        // Convert base64 strings to GenerativeContent parts
        const generatedContent = await model.generateContent([
            prompt,
            ...imageParts.map(img => {
                const mimeMatch = img.match(/^data:(.*?);base64,/);
                const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
                const base64Data = img.indexOf('base64,') !== -1 ? img.split('base64,')[1] : img;

                return {
                    inlineData: {
                        data: base64Data,
                        mimeType: mimeType
                    }
                };
            })
        ]);

        const response = await generatedContent.response;
        const text = response.text();

        const jsonStr = extractAnswerJsonArrayPayload(text);

        try {
            return JSON.parse(jsonStr);
        } catch {
            throw invalidAiJsonError(text.length);
        }
    } catch (error: unknown) {
        console.warn("AI answer analysis failed", safeAiAnswerLogMeta(error, {
            imageCount: imageParts.length,
        }));
        throw new Error(safeAiAnswerErrorMessage(error));
    }
}
