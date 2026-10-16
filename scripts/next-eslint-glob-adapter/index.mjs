import { isAbsolute } from "node:path";
import { globSync as tinyGlobSync } from "tinyglobby";

// Next 16.3.8 uses only this API for its configured application roots. Preserve
// fast-glob's absolute-pattern and non-expanding directory behavior explicitly.
// Reject a changed upstream call contract instead of silently skipping roots.
export function globSync(pattern, options) {
    if (typeof pattern !== "string" || !options || options.onlyDirectories !== true
        || Object.keys(options).some(key => key !== "onlyDirectories")) {
        throw new TypeError("Unsupported Next ESLint root glob contract");
    }
    return tinyGlobSync(pattern, {
        onlyDirectories: true,
        expandDirectories: false,
        absolute: isAbsolute(pattern),
    }).map(directory => directory.length > 1 ? directory.replace(/\/$/, "") : directory);
}
