"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";

export async function analyzeAnswerImages(imageParts: string[]) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not defined in environment variables");
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
        console.log("Gemini Raw Response:", text);

        // More robust JSON extraction
        const jsonMatch = text.match(/\[\s*{[\s\S]*}\s*\]/);
        const jsonStr = jsonMatch ? jsonMatch[0] : text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(jsonStr);
        } catch {
            console.error("JSON Parse Error. Raw Text:", text);
            throw new Error(`AI가 유효한 정답 형식을 반환하지 않았습니다. 원본 응답:\n${text.substring(0, 100)}...`);
        }
    } catch (error: unknown) {
        console.error("Gemini API Error Object:", error);
        const err = error as Error;
        console.error("Error Message:", err.message);
        throw new Error(`AI 인식 실패: ${err.message || '알 수 없는 오류'}`);
    }
}
