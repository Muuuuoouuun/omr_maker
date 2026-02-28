"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";

export async function analyzeAnswerImages(imageParts: string[]) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not defined in environment variables");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
    You are an expert OMR answer key extractor. 
    Analyze the following images which contain an answer key for an exam.
    Extract the Question Number and the Correct Answer.
    
    Rules:
    1. Answers might be numbers (1-5) or alphabets (A-E). Map alphabets to numbers: A=1, B=2, C=3, D=4, E=5.
    2. Ignore headers, footers, or irrelevant text.
    3. Return ONLY a valid JSON array of objects.
    4. Format: [{"questionNum": 1, "answer": 3}, {"questionNum": 2, "answer": 1}, ...]
    5. Ensure the numbers are integers.
    `;

    try {
        // Convert base64 strings to GenerativeContent parts
        const generatedContent = await model.generateContent([
            prompt,
            ...imageParts.map(img => {
                const mimeMatch = img.match(/^data:(.*?);base64,/);
                const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
                return {
                    inlineData: {
                        data: img.split(',')[1],
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
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (parseError) {
            console.error("JSON Parse Error. Raw Text:", text);
            throw new Error("AI가 유효한 정답 형식을 반환하지 않았습니다.");
        }
    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("Failed to analyze images with Gemini");
    }
}
