export function parseStrictJson(text) {
    let offset = 0;
    const skipWhitespace = () => {
        while (/\s/.test(text[offset] ?? "")) offset += 1;
    };
    const parseString = () => {
        if (text[offset] !== "\"") throw new Error("Invalid JSON string");
        const start = offset;
        offset += 1;
        let escaped = false;
        while (offset < text.length) {
            const character = text[offset];
            offset += 1;
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === "\"") {
                return JSON.parse(text.slice(start, offset));
            }
        }
        throw new Error("Unterminated JSON string");
    };
    const parseValue = () => {
        skipWhitespace();
        if (text[offset] === "{") {
            offset += 1;
            const object = Object.create(null);
            const keys = new Set();
            skipWhitespace();
            if (text[offset] === "}") {
                offset += 1;
                return object;
            }
            while (offset < text.length) {
                skipWhitespace();
                const key = parseString();
                if (keys.has(key)) throw new Error("Duplicate JSON key");
                keys.add(key);
                skipWhitespace();
                if (text[offset] !== ":") throw new Error("Invalid JSON object");
                offset += 1;
                Object.defineProperty(object, key, {
                    value: parseValue(),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
                skipWhitespace();
                if (text[offset] === "}") {
                    offset += 1;
                    return object;
                }
                if (text[offset] !== ",") throw new Error("Invalid JSON object");
                offset += 1;
            }
            throw new Error("Unterminated JSON object");
        }
        if (text[offset] === "[") {
            offset += 1;
            const array = [];
            skipWhitespace();
            if (text[offset] === "]") {
                offset += 1;
                return array;
            }
            while (offset < text.length) {
                array.push(parseValue());
                skipWhitespace();
                if (text[offset] === "]") {
                    offset += 1;
                    return array;
                }
                if (text[offset] !== ",") throw new Error("Invalid JSON array");
                offset += 1;
            }
            throw new Error("Unterminated JSON array");
        }
        if (text[offset] === "\"") return parseString();
        for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
            if (text.startsWith(literal, offset)) {
                offset += literal.length;
                return value;
            }
        }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
        if (!number) throw new Error("Invalid JSON value");
        offset += number[0].length;
        const value = Number(number[0]);
        if (!Number.isFinite(value)) throw new Error("Invalid JSON number");
        return value;
    };
    const value = parseValue();
    skipWhitespace();
    if (offset !== text.length) throw new Error("Trailing JSON content");
    return value;
}
