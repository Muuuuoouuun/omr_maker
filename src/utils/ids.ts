/**
 * Generates an unguessable, URL-safe identifier.
 *
 * Replaces `Date.now().toString(36)`-style ids, which are monotonic and therefore
 * trivially enumerable (an attacker can guess adjacent exam ids). Prefers
 * `crypto.randomUUID`, falls back to 128 bits from `crypto.getRandomValues`
 * (available in non-secure contexts too), and only as a last resort uses a
 * non-crypto value that still avoids a purely monotonic id.
 */
export function secureRandomId(): string {
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
        return cryptoObj.randomUUID();
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
