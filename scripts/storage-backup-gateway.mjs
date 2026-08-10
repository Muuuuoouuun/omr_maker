import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

import { REMOTE_ASSET_BUCKET } from "./backup-restore-core.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_OBJECTS = 100_000;
const DEFAULT_MAX_DIRECTORIES = 4 * DEFAULT_MAX_OBJECTS + 2;
const MAX_CANONICAL_RESTORE_LISTED_OBJECTS = 10_001;
const MAX_LIST_PAGES = 100_000;

function boundedInteger(value, fallback, min, max, label) {
    const resolved = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
        throw new Error(`${label} is outside the allowed range`);
    }
    return resolved;
}

function assertBucket(bucket) {
    if (bucket !== REMOTE_ASSET_BUCKET) throw new Error(`backup bucket must be ${REMOTE_ASSET_BUCKET}`);
}

function canonicalContentType(path) {
    if (typeof path !== "string" || path.includes("\\") || path.includes("..") || path.startsWith("/")) return null;
    const segments = path.split("/");
    if (segments.length !== 6 || segments[0] !== "organizations") return null;
    if (!SAFE_SEGMENT.test(segments[1]) || !SAFE_SEGMENT.test(segments[3])) return null;
    if (
        segments[2] === "exams"
        && (segments[4] === "problem" || segments[4] === "answer-key")
        && segments[5].endsWith(".pdf")
        && SAFE_SEGMENT.test(segments[5].slice(0, -4))
    ) return "application/pdf";
    if (
        segments[2] === "attempts"
        && segments[4] === "handwriting"
        && segments[5].endsWith(".json")
        && SAFE_SEGMENT.test(segments[5].slice(0, -5))
    ) return "application/json";
    return null;
}

function normalizeInventoryObject(value, label, enforceCanonicalMime, requireSha = true) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
    const { path, bytes, sha256, contentType } = value;
    const expectedContentType = canonicalContentType(path);
    if (!expectedContentType) throw new Error(`${label} path is not canonical`);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${label} bytes are invalid`);
    if (requireSha && (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))) {
        throw new Error(`${label} SHA-256 is invalid`);
    }
    if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))) {
        throw new Error(`${label} SHA-256 is invalid`);
    }
    if (contentType !== "application/pdf" && contentType !== "application/json") {
        throw new Error(`${label} content type is invalid`);
    }
    if (enforceCanonicalMime && contentType !== expectedContentType) {
        throw new Error(`${label} content type does not match its path`);
    }
    return { path, bytes, ...(sha256 === undefined ? {} : { sha256 }), contentType };
}

function safeChildPath(parent, name) {
    if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error("Storage inventory returned an unsafe path segment");
    }
    return parent ? `${parent}/${name}` : name;
}

function listedMetadata(entry, path) {
    const metadata = entry?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("Storage inventory object metadata is missing");
    }
    const customMetadata = metadata.metadata && typeof metadata.metadata === "object" && !Array.isArray(metadata.metadata)
        ? metadata.metadata
        : null;
    return normalizeInventoryObject({
        path,
        bytes: metadata.size ?? metadata.contentLength,
        sha256: metadata.sha256Hex ?? metadata.sha256_hex ?? customMetadata?.sha256Hex ?? customMetadata?.sha256_hex,
        contentType: metadata.mimetype ?? metadata.contentType,
    }, "Storage inventory object", false, false);
}

function isFolderEntry(entry) {
    return entry?.id == null && entry?.metadata == null;
}

async function listOneInventoryPass(client, bucket, options) {
    const storage = client?.storage?.from?.(bucket);
    if (!storage || typeof storage.list !== "function") throw new Error("Storage inventory client is unavailable");
    const directories = [""];
    const discoveredDirectories = new Set([""]);
    const visited = new Set();
    const objects = [];
    let pageCount = 0;

    while (directories.length > 0) {
        const directory = directories.shift();
        if (visited.has(directory)) throw new Error("Storage inventory contains a directory cycle");
        visited.add(directory);
        if (visited.size > options.maxDirectories) throw new Error("Storage inventory directory limit exceeded");

        for (let offset = 0; ; offset += options.pageSize) {
            pageCount += 1;
            if (pageCount > options.maxListPages) throw new Error("Storage inventory page limit exceeded");
            let result;
            try {
                result = await storage.list(directory, {
                    limit: options.pageSize,
                    offset,
                    sortBy: { column: "name", order: "asc" },
                });
            } catch {
                throw new Error("Storage inventory listing failed");
            }
            if (result?.error || !Array.isArray(result?.data)) throw new Error("Storage inventory listing failed");
            for (const entry of result.data) {
                const path = safeChildPath(directory, entry?.name);
                if (isFolderEntry(entry)) {
                    if (!discoveredDirectories.has(path)) {
                        discoveredDirectories.add(path);
                        if (discoveredDirectories.size > options.maxDirectories) {
                            throw new Error("Storage inventory directory limit exceeded");
                        }
                        directories.push(path);
                    }
                } else {
                    objects.push(listedMetadata(entry, path));
                    if (objects.length > options.maxObjects) throw new Error("Storage inventory object limit exceeded");
                }
            }
            if (result.data.length < options.pageSize) break;
        }
    }

    objects.sort((left, right) => left.path.localeCompare(right.path));
    const paths = new Set(objects.map((object) => object.path));
    if (paths.size !== objects.length) throw new Error("Storage inventory contains duplicate object paths");
    return objects;
}

function inventoryFingerprint(objects) {
    return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

export function deriveCanonicalStorageTraversalBounds(maximumObjects, pageSize = DEFAULT_PAGE_SIZE) {
    const maxObjects = boundedInteger(
        maximumObjects,
        undefined,
        1,
        MAX_CANONICAL_RESTORE_LISTED_OBJECTS,
        "canonical restore object limit",
    );
    const boundedPageSize = boundedInteger(pageSize, DEFAULT_PAGE_SIZE, 1, DEFAULT_PAGE_SIZE, "pageSize");
    const maxDirectories = 2 + 4 * maxObjects;
    const maxListPages = maxDirectories + Math.ceil(maxObjects / boundedPageSize);
    if (maxListPages > MAX_LIST_PAGES) throw new Error("canonical restore page limit is outside the allowed range");
    return {
        pageSize: boundedPageSize,
        maxObjects,
        maxDirectories,
        maxListPages,
    };
}

export async function listStorageObjectsToFixedPoint(client, bucket, options = {}) {
    assertBucket(bucket);
    const settings = {
        pageSize: boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, 1000, "pageSize"),
        maxPasses: boundedInteger(options.maxPasses, 3, 2, 10, "maxPasses"),
        maxObjects: boundedInteger(options.maxObjects, DEFAULT_MAX_OBJECTS, 1, 1_000_000, "maxObjects"),
        maxDirectories: boundedInteger(options.maxDirectories, DEFAULT_MAX_DIRECTORIES, 1, 4_000_002, "maxDirectories"),
        maxListPages: boundedInteger(options.maxListPages, 10_000, 1, MAX_LIST_PAGES, "maxListPages"),
    };
    let previousFingerprint = null;
    for (let pass = 0; pass < settings.maxPasses; pass += 1) {
        const objects = await listOneInventoryPass(client, bucket, settings);
        const fingerprint = inventoryFingerprint(objects);
        if (previousFingerprint === fingerprint) return objects;
        previousFingerprint = fingerprint;
    }
    throw new Error("Storage inventory did not converge to a fixed point");
}

async function bodyToBuffer(body) {
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (body && typeof body.arrayBuffer === "function") return Buffer.from(await body.arrayBuffer());
    throw new Error("Storage download returned an unsupported body");
}

function containedOutputPath(root, objectPath) {
    const target = resolve(root, ...objectPath.split("/"));
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Storage backup path escapes the output root");
    return target;
}

async function safeParentDirectory(root, rootReal, objectPath) {
    const segments = objectPath.split("/").slice(0, -1);
    let current = root;
    for (const segment of segments) {
        current = resolve(current, segment);
        let info;
        try {
            info = await lstat(current);
        } catch (error) {
            if (error?.code !== "ENOENT") throw new Error("Storage backup path inspection failed");
            try {
                await mkdir(current, { mode: 0o700 });
            } catch (mkdirError) {
                if (mkdirError?.code !== "EEXIST") throw new Error("Storage backup directory creation failed");
            }
            try {
                info = await lstat(current);
            } catch {
                throw new Error("Storage backup path inspection failed");
            }
        }
        if (info.isSymbolicLink()) throw new Error("Storage backup path escapes the output root");
        if (!info.isDirectory()) throw new Error("Storage backup path is not a directory");
        let currentReal;
        try {
            currentReal = await realpath(current);
        } catch {
            throw new Error("Storage backup path resolution failed");
        }
        if (currentReal !== rootReal && !currentReal.startsWith(`${rootReal}${sep}`)) {
            throw new Error("Storage backup path escapes the output root");
        }
    }
    return current;
}

export async function downloadAndHashStorageObjects(client, bucket, objects, outputDir, options = {}) {
    assertBucket(bucket);
    if (!isAbsolute(outputDir)) throw new Error("Storage backup output directory must be absolute");
    if (!Array.isArray(objects)) throw new Error("Storage backup objects must be an array");
    const normalized = objects.map((object, index) => normalizeInventoryObject(object, `objects[${index}]`, true, false));
    const paths = new Set(normalized.map((object) => object.path));
    if (paths.size !== normalized.length) throw new Error("Storage backup objects contain duplicate paths");
    const concurrency = boundedInteger(options.concurrency, 3, 1, 8, "concurrency");
    const root = resolve(outputDir);
    if (root === parse(root).root || root === resolve(homedir()) || root === resolve(process.cwd())) {
        throw new Error("Storage backup refuses a broad output root");
    }
    const storage = client?.storage?.from?.(bucket);
    if (!storage || typeof storage.download !== "function") throw new Error("Storage download client is unavailable");
    try {
        await mkdir(root, { recursive: true, mode: 0o700 });
    } catch {
        throw new Error("Storage backup output directory creation failed");
    }
    try {
        if ((await lstat(root)).isSymbolicLink()) throw new Error("symlink");
    } catch {
        throw new Error("Storage backup path escapes the output root");
    }
    let rootReal;
    try {
        rootReal = await realpath(root);
    } catch {
        throw new Error("Storage backup output directory resolution failed");
    }
    if (rootReal === parse(rootReal).root || rootReal === resolve(homedir()) || rootReal === resolve(process.cwd())) {
        throw new Error("Storage backup refuses a broad output root");
    }

    let cursor = 0;
    let totalBytes = 0;
    let stopped = false;
    const downloaded = new Array(normalized.length);
    async function worker() {
        try {
            while (!stopped) {
                const index = cursor;
                cursor += 1;
                if (index >= normalized.length) return;
                const object = normalized[index];
                let result;
                try {
                    result = await storage.download(object.path);
                } catch {
                    throw new Error("Storage object download failed");
                }
                if (result?.error || !result?.data) throw new Error("Storage object download failed");
                if (stopped) return;
                const body = await bodyToBuffer(result.data);
                const digest = createHash("sha256").update(body).digest("hex");
                if (body.byteLength !== object.bytes || (object.sha256 !== undefined && digest !== object.sha256)) {
                    throw new Error("Storage object body mismatch");
                }
                if (stopped) return;
                const target = containedOutputPath(root, object.path);
                const parentReal = await safeParentDirectory(root, rootReal, object.path);
                if (parentReal !== dirname(target)) throw new Error("Storage backup path resolution failed");
                if (stopped) return;
                try {
                    await writeFile(target, body, { flag: "wx", mode: 0o600 });
                } catch {
                    throw new Error("Storage backup file write failed");
                }
                totalBytes += body.byteLength;
                if (!Number.isSafeInteger(totalBytes)) throw new Error("Storage backup total byte count overflowed");
                downloaded[index] = { ...object, sha256: digest };
            }
        } catch (error) {
            stopped = true;
            throw error;
        }
    }
    const workerResults = await Promise.allSettled(
        Array.from({ length: Math.min(concurrency, Math.max(1, normalized.length)) }, () => worker()),
    );
    const failedWorker = workerResults.find((result) => result.status === "rejected");
    if (failedWorker?.status === "rejected") throw failedWorker.reason;
    return { objectCount: normalized.length, totalBytes, objects: downloaded };
}

export async function readRemoteAssetRegistry(client, options = {}) {
    const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, 1000, "pageSize");
    const maxRows = boundedInteger(options.maxRows, DEFAULT_MAX_OBJECTS, 1, 1_000_000, "maxRows");
    const rows = [];
    for (let from = 0; ; from += pageSize) {
        let result;
        try {
            result = await client
                .from("omr_remote_assets")
                .select("object_path,byte_size,sha256_hex,mime_type")
                .order("object_path", { ascending: true })
                .range(from, from + pageSize - 1);
        } catch {
            throw new Error("Remote asset registry read failed");
        }
        if (result?.error || !Array.isArray(result?.data)) throw new Error("Remote asset registry read failed");
        for (const row of result.data) {
            rows.push(normalizeInventoryObject({
                path: row?.object_path,
                bytes: row?.byte_size,
                sha256: row?.sha256_hex,
                contentType: row?.mime_type,
            }, `remote asset registry row ${rows.length}`, true));
            if (rows.length > maxRows) throw new Error("Remote asset registry row limit exceeded");
        }
        if (result.data.length < pageSize) break;
    }
    const paths = new Set(rows.map((row) => row.path));
    if (paths.size !== rows.length) throw new Error("Remote asset registry contains duplicate paths");
    return rows;
}

function difference(left, right) {
    return [...left].filter((path) => !right.has(path)).sort();
}

export function compareRegistryToStorage(registry, storageObjects) {
    if (!Array.isArray(registry) || !Array.isArray(storageObjects)) throw new Error("registry comparison inputs must be arrays");
    const expected = registry.map((object, index) => normalizeInventoryObject(object, `registry[${index}]`, true));
    const actual = storageObjects.map((object, index) => normalizeInventoryObject(object, `storage[${index}]`, false, false));
    const expectedByPath = new Map(expected.map((object) => [object.path, object]));
    const actualByPath = new Map(actual.map((object) => [object.path, object]));
    if (expectedByPath.size !== expected.length || actualByPath.size !== actual.length) {
        throw new Error("registry comparison contains duplicate paths");
    }
    const common = [...expectedByPath.keys()].filter((path) => actualByPath.has(path)).sort();
    const result = {
        ok: false,
        missingRegistryObjects: difference(new Set(expectedByPath.keys()), new Set(actualByPath.keys())),
        orphanStorageObjects: difference(new Set(actualByPath.keys()), new Set(expectedByPath.keys())),
        sizeMismatch: common
            .filter((path) => expectedByPath.get(path).bytes !== actualByPath.get(path).bytes)
            .map((path) => ({ path, expected: expectedByPath.get(path).bytes, actual: actualByPath.get(path).bytes })),
        hashMismatch: common
            .filter((path) => actualByPath.get(path).sha256 !== undefined && expectedByPath.get(path).sha256 !== actualByPath.get(path).sha256)
            .map((path) => ({ path, expected: expectedByPath.get(path).sha256, actual: actualByPath.get(path).sha256 })),
        contentTypeMismatch: common
            .filter((path) => expectedByPath.get(path).contentType !== actualByPath.get(path).contentType)
            .map((path) => ({
                path,
                expected: expectedByPath.get(path).contentType,
                actual: actualByPath.get(path).contentType,
            })),
        hashUnavailable: common.filter((path) => actualByPath.get(path).sha256 === undefined),
    };
    result.ok = Object.entries(result).every(([key, value]) => key === "ok" || value.length === 0);
    return result;
}
