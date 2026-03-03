"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";

export async function analyzePdfCoordinates(imageParts: string[]) {
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
    You are an AI tasked with analyzing exam papers and finding the precise bounding box coordinates for every question number, AND its multiple-choice options (choices 1, 2, 3, 4, 5).
    Extract the bounding box [ymin, xmin, ymax, xmax] for every question number (1, 2, 3...) and for every choice (①, ②, ③, ④, ⑤ or 1), 2), 3), 4), 5)) in the provided images.

    Rules:
    1. Only locate the actual question numbers that start a new question (e.g. "1.", "1)", "[1]"). Do not locate numbers used inside the text.
    2. Coordinates must be strictly numeric values between 0.0 and 1.0, representing percentages of the image height/width from the top-left corner.
    3. Return ONLY a valid JSON array.
    4. Format:
    [
      {
        "questionNum": 1,
        "page": 1,
        "ymin": 0.1, "xmin": 0.1, "ymax": 0.15, "xmax": 0.2,
        "choices": [
          {"num": 1, "ymin": 0.16, "xmin": 0.1, "ymax": 0.18, "xmax": 0.15},
          {"num": 2, "ymin": 0.16, "xmin": 0.2, "ymax": 0.18, "xmax": 0.25}
        ]
      },
      ...
    ]
    5. 'page' should be the index matching the image provided (1-based index).
    6. Ensure that choices correctly map to their respective questions.
    `;

    try {
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
        console.log("Gemini Smart PDF BBox Raw Response:", text);

        const jsonMatch = text.match(/\[\s*{[\s\S]*}\s*\]/);
        const jsonStr = jsonMatch ? jsonMatch[0] : text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(jsonStr);
        } catch {
            console.error("JSON Parse Error. Raw Text:", text);
            throw new Error(`AI가 유효한 좌표 형식을 반환하지 않았습니다. 원본 응답:\n${text.substring(0, 100)}...`);
        }
    } catch (error: unknown) {
        console.error("Gemini API Error Object:", error);
        const err = error as Error;
        console.error("Error Message:", err.message);
        throw new Error(`문제 위치 AI 인식 실패: ${err.message || '알 수 없는 오류'}`);
    }
}
