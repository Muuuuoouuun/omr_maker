const INVALID_JSON_CODE = "AI_INVALID_JSON_RESPONSE";
const INVALID_IMAGE_INPUT_CODE = "AI_INVALID_IMAGE_INPUT";

const ALLOWED_ANSWER_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const AI_ANSWER_IMAGE_LIMITS = {
    maxImages: 8,
    maxSingleBase64Chars: 5_000_000,
    maxTotalBase64Chars: 9_000_000,
} as const;

export interface ValidatedAnswerImagePart {
    data: string;
    mimeType: string;
}

export function extractAnswerJsonArrayPayload(text: string): string {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\[\s*{[\s\S]*}\s*\]/);
    return jsonMatch ? jsonMatch[0] : cleaned;
}

export function invalidAiJsonError(responseLength: number): Error {
    const error = new Error(INVALID_JSON_CODE) as Error & { responseLength?: number };
    error.name = "AIAnswerParseError";
    error.responseLength = Math.max(0, Math.floor(Number.isFinite(responseLength) ? responseLength : 0));
    return error;
}

function invalidAnswerImageInputError(): Error {
    const error = new Error(INVALID_IMAGE_INPUT_CODE);
    error.name = "AIAnswerInputError";
    return error;
}

function normalizeAnswerImageMimeType(mimeType: string): string {
    const normalized = mimeType.trim().toLowerCase();
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function splitAnswerImagePart(rawImage: string): ValidatedAnswerImagePart {
    const value = rawImage.trim();
    if (!value) throw invalidAnswerImageInputError();

    let mimeType = "image/jpeg";
    let base64Data = value;

    if (value.toLowerCase().startsWith("data:")) {
        const commaIndex = value.indexOf(",");
        if (commaIndex < 0) throw invalidAnswerImageInputError();

        const metadata = value.slice(5, commaIndex).toLowerCase();
        const metadataParts = metadata.split(";").map(part => part.trim()).filter(Boolean);
        if (!metadataParts.includes("base64")) throw invalidAnswerImageInputError();

        mimeType = normalizeAnswerImageMimeType(metadataParts[0] || "");
        base64Data = value.slice(commaIndex + 1);
    }

    const compactData = base64Data.replace(/\s+/g, "");
    if (
        !ALLOWED_ANSWER_IMAGE_MIME_TYPES.has(mimeType)
        || !compactData
        || compactData.length > AI_ANSWER_IMAGE_LIMITS.maxSingleBase64Chars
        || compactData.length % 4 === 1
        || !BASE64_PAYLOAD_PATTERN.test(compactData)
    ) {
        throw invalidAnswerImageInputError();
    }

    return {
        data: compactData,
        mimeType,
    };
}

export function validateAnswerImageParts(imageParts: unknown): ValidatedAnswerImagePart[] {
    if (
        !Array.isArray(imageParts)
        || imageParts.length === 0
        || imageParts.length > AI_ANSWER_IMAGE_LIMITS.maxImages
    ) {
        throw invalidAnswerImageInputError();
    }

    let totalBase64Chars = 0;
    return imageParts.map(imagePart => {
        if (typeof imagePart !== "string") throw invalidAnswerImageInputError();

        const validated = splitAnswerImagePart(imagePart);
        totalBase64Chars += validated.data.length;
        if (totalBase64Chars > AI_ANSWER_IMAGE_LIMITS.maxTotalBase64Chars) {
            throw invalidAnswerImageInputError();
        }

        return validated;
    });
}

function categorizeAiAnswerError(message: string): string {
    const lower = message.toLowerCase();
    if (message === INVALID_IMAGE_INPUT_CODE) return "invalid_image_input";
    if (message === INVALID_JSON_CODE || lower.includes("유효한 정답 형식")) return "invalid_json";
    if (lower.includes("api key") || lower.includes("apikey") || lower.includes("api 키") || lower.includes("권한") || lower.includes("401") || lower.includes("403")) return "auth";
    if (lower.includes("quota") || lower.includes("rate") || lower.includes("429") || lower.includes("resource_exhausted") || lower.includes("사용량") || lower.includes("요청 제한")) return "quota";
    if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout") || lower.includes("네트워크")) return "network";
    return "unknown";
}

export function safeAiAnswerErrorMessage(error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const category = categorizeAiAnswerError(rawMessage);

    if (category === "invalid_image_input") {
        return "정답 이미지 형식 또는 용량을 확인해주세요.";
    }
    if (category === "invalid_json") {
        return "AI가 유효한 정답 형식을 반환하지 않았습니다. 이미지가 선명한지 확인해주세요.";
    }
    if (category === "auth") {
        return "Gemini API 키 또는 권한을 확인해주세요.";
    }
    if (category === "quota") {
        return "Gemini API 사용량 또는 요청 제한을 확인해주세요.";
    }
    if (category === "network") {
        return "네트워크 연결 상태를 확인한 뒤 다시 시도해주세요.";
    }

    return "AI 인식 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
}

export function safeAiAnswerLogMeta(error: unknown, extra: Record<string, unknown> = {}) {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const responseLength = typeof (error as { responseLength?: unknown } | null)?.responseLength === "number"
        ? (error as { responseLength: number }).responseLength
        : undefined;

    return {
        ...extra,
        category: categorizeAiAnswerError(rawMessage),
        errorName: error instanceof Error ? error.name : typeof error,
        messageLength: rawMessage.length,
        ...(responseLength !== undefined ? { responseLength } : {}),
    };
}
