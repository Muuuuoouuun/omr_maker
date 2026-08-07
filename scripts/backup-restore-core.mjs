import { createHash } from "node:crypto";

export const BACKUP_FORMAT_VERSION = 1;

export const CANONICAL_BACKUP_TABLES = Object.freeze([
    "omr_organizations",
    "omr_plan_usage",
    "omr_plan_usage_reservations",
    "omr_user_profiles",
    "omr_organization_members",
    "omr_teacher_profiles",
    "omr_student_profiles",
    "omr_student_start_credentials",
    "omr_classes",
    "omr_roster_invites",
    "omr_class_teachers",
    "omr_class_students",
    "omr_materials",
    "omr_exams",
    "omr_exam_entry_invites",
    "omr_exam_questions",
    "omr_exam_materials",
    "omr_assignments",
    "omr_assignment_targets",
    "omr_attempts",
    "omr_question_results",
    "omr_assignment_submissions",
    "omr_attempt_feedback",
    "omr_kakao_candidate_reviews",
    "omr_kakao_dispatch_logs",
    "omr_comments",
    "omr_audit_logs",
    "omr_remote_assets",
    "omr_remote_asset_upload_intents",
    "omr_remote_asset_cleanup_queue",
    "omr_attempt_sessions",
    "omr_rate_limit_buckets",
    "omr_exam_mutations",
    "omr_feedback_mutations",
    "omr_initial_ops_metrics",
    "omr_teacher_accounts",
    "omr_teacher_account_tokens",
    "omr_teacher_notification_states",
]);

export const REMOTE_ASSET_BUCKET = "omr-private-assets";

const CANONICAL_TABLE_SET = new Set(CANONICAL_BACKUP_TABLES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PROJECT_REF_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/i;
const FILE_NAMES = Object.freeze({
    roles: "roles.sql",
    schema: "schema.sql",
    data: "data.sql",
});

function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function assertExactKeys(value, expectedKeys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${label} has unexpected or missing fields`);
    }
}

function assertNonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function assertPositiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function assertSha256(value, label) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }
    return value;
}

function validateSqlArtifact(value, kind) {
    const artifact = assertPlainObject(value, `database.${kind}`);
    assertExactKeys(artifact, ["file", "bytes", "sha256"], `database.${kind}`);
    if (artifact.file !== FILE_NAMES[kind]) {
        throw new Error(`database.${kind}.file must be ${FILE_NAMES[kind]}`);
    }
    return {
        file: artifact.file,
        bytes: assertPositiveSafeInteger(artifact.bytes, `database.${kind}.bytes`),
        sha256: assertSha256(artifact.sha256, `database.${kind}.sha256`),
    };
}

function validateObjectPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
        throw new Error("storage object path must be a non-empty bounded string");
    }
    if (
        value.startsWith("/")
        || value.includes("\\")
        || /[\u0000-\u001f\u007f]/.test(value)
        || value.includes("://")
    ) {
        throw new Error("storage object path is unsafe");
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error("storage object path contains unsafe traversal");
    }
    return value;
}

function canonicalAssetContentType(path) {
    const segments = path.split("/");
    if (segments.length !== 6 || segments[0] !== "organizations") return null;
    const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    if (!safeSegment.test(segments[1]) || !safeSegment.test(segments[3])) return null;

    if (
        segments[2] === "exams"
        && (segments[4] === "problem" || segments[4] === "answer-key")
        && segments[5].endsWith(".pdf")
        && safeSegment.test(segments[5].slice(0, -4))
    ) {
        return "application/pdf";
    }
    if (
        segments[2] === "attempts"
        && segments[4] === "handwriting"
        && segments[5].endsWith(".json")
        && safeSegment.test(segments[5].slice(0, -5))
    ) {
        return "application/json";
    }
    return null;
}

function validateStorageObject(value, index) {
    const object = assertPlainObject(value, `storage.objects[${index}]`);
    assertExactKeys(object, ["path", "bytes", "sha256", "contentType"], `storage.objects[${index}]`);
    const path = validateObjectPath(object.path);
    const expectedContentType = canonicalAssetContentType(path);
    if (!expectedContentType) throw new Error(`storage.objects[${index}].path is not a canonical remote asset path`);
    if (object.contentType !== expectedContentType) {
        throw new Error(`storage.objects[${index}].contentType does not match its canonical path`);
    }
    return {
        path,
        bytes: assertPositiveSafeInteger(object.bytes, `storage.objects[${index}].bytes`),
        sha256: assertSha256(object.sha256, `storage.objects[${index}].sha256`),
        contentType: object.contentType,
    };
}

export function validateBackupManifest(value) {
    const manifest = assertPlainObject(value, "manifest");
    assertExactKeys(
        manifest,
        ["formatVersion", "createdAt", "gitCommit", "sourceProjectRefHash", "database", "storage"],
        "manifest",
    );
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
        throw new Error(`manifest formatVersion must be ${BACKUP_FORMAT_VERSION}`);
    }
    if (
        typeof manifest.createdAt !== "string"
        || Number.isNaN(Date.parse(manifest.createdAt))
        || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
    ) {
        throw new Error("manifest createdAt must be a canonical ISO timestamp");
    }
    if (typeof manifest.gitCommit !== "string" || !GIT_COMMIT_PATTERN.test(manifest.gitCommit)) {
        throw new Error("manifest gitCommit must be a lowercase 40-character SHA");
    }

    const database = assertPlainObject(manifest.database, "database");
    assertExactKeys(database, ["roles", "schema", "data", "tableCounts"], "database");
    const tableCounts = assertPlainObject(database.tableCounts, "database.tableCounts");
    const tableNames = Object.keys(tableCounts);
    if (
        tableNames.length !== CANONICAL_BACKUP_TABLES.length
        || CANONICAL_BACKUP_TABLES.some((table) => !Object.hasOwn(tableCounts, table))
        || tableNames.some((table) => !CANONICAL_TABLE_SET.has(table))
    ) {
        throw new Error("database.tableCounts must contain the exact canonical table allowlist");
    }
    const validatedTableCounts = Object.fromEntries(CANONICAL_BACKUP_TABLES.map((table) => [
        table,
        assertNonNegativeSafeInteger(tableCounts[table], `database.tableCounts.${table}`),
    ]));

    const storage = assertPlainObject(manifest.storage, "storage");
    assertExactKeys(storage, ["bucket", "objectCount", "totalBytes", "objects"], "storage");
    if (storage.bucket !== REMOTE_ASSET_BUCKET) {
        throw new Error(`storage.bucket must be ${REMOTE_ASSET_BUCKET}`);
    }
    if (!Array.isArray(storage.objects)) {
        throw new Error("storage.objects must be an array");
    }
    const objects = storage.objects.map(validateStorageObject);
    const paths = new Set();
    for (const object of objects) {
        if (paths.has(object.path)) throw new Error(`duplicate storage object path: ${object.path}`);
        paths.add(object.path);
    }
    const objectCount = assertNonNegativeSafeInteger(storage.objectCount, "storage.objectCount");
    const totalBytes = assertNonNegativeSafeInteger(storage.totalBytes, "storage.totalBytes");
    if (objectCount !== objects.length) throw new Error("storage.objectCount does not match objects");
    if (totalBytes !== objects.reduce((sum, object) => sum + object.bytes, 0)) {
        throw new Error("storage.totalBytes does not match objects");
    }

    return {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: manifest.createdAt,
        gitCommit: manifest.gitCommit,
        sourceProjectRefHash: assertSha256(manifest.sourceProjectRefHash, "sourceProjectRefHash"),
        database: {
            roles: validateSqlArtifact(database.roles, "roles"),
            schema: validateSqlArtifact(database.schema, "schema"),
            data: validateSqlArtifact(database.data, "data"),
            tableCounts: validatedTableCounts,
        },
        storage: {
            bucket: REMOTE_ASSET_BUCKET,
            objectCount,
            totalBytes,
            objects,
        },
    };
}

function parseCopyIdentifier(raw) {
    if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replaceAll('""', '"');
    return raw;
}

export function parseCopyTableCounts(dataSqlText) {
    if (typeof dataSqlText !== "string") throw new Error("data SQL must be a string");
    const lines = dataSqlText.split(/\r?\n/);
    const counts = {};
    let active = null;

    for (const line of lines) {
        if (active) {
            if (line === "\\.") {
                if (active.record) counts[active.table] = active.count;
                active = null;
            } else {
                active.count += 1;
            }
            continue;
        }

        if (!line.startsWith("COPY ")) continue;
        const match = line.match(/^COPY\s+(?<schema>"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)\.(?<table>"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)\s+\(.+\)\s+FROM\s+stdin;$/i);
        if (!match?.groups) throw new Error("malformed COPY block header");
        const schema = parseCopyIdentifier(match.groups.schema);
        const table = parseCopyIdentifier(match.groups.table);
        const canonical = schema === "public" && CANONICAL_TABLE_SET.has(table);
        if (schema === "public" && table.startsWith("omr_") && !canonical) {
            throw new Error(`non-canonical public OMR table in dump: ${table}`);
        }
        if (canonical && Object.hasOwn(counts, table)) throw new Error(`duplicate COPY block: ${table}`);
        active = { table, count: 0, record: canonical };
    }

    if (active) throw new Error(`unterminated COPY block: ${active.table}`);
    return counts;
}

export function assertDifferentProjectRefs(sourceProjectRef, targetProjectRef) {
    if (
        typeof sourceProjectRef !== "string"
        || typeof targetProjectRef !== "string"
    ) {
        throw new Error("source and target project refs are required");
    }
    const source = sourceProjectRef.trim();
    const target = targetProjectRef.trim();
    if (!PROJECT_REF_PATTERN.test(source) || !PROJECT_REF_PATTERN.test(target)) {
        throw new Error("source and target project refs are invalid");
    }
    if (source.toLowerCase() === target.toLowerCase()) {
        throw new Error("restore target must be a different project");
    }
    return { sourceProjectRef: source, targetProjectRef: target };
}

export function hashProjectRef(projectRef) {
    if (typeof projectRef !== "string") throw new Error("project ref is required");
    const normalized = projectRef.trim().toLowerCase();
    if (!PROJECT_REF_PATTERN.test(normalized)) throw new Error("project ref is invalid");
    return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function assertTargetProjectDiffers(sourceProjectRefHash, targetProjectRef) {
    const sourceHash = assertSha256(sourceProjectRefHash, "sourceProjectRefHash");
    if (typeof targetProjectRef !== "string") throw new Error("target project ref is required");
    const target = targetProjectRef.trim();
    const targetHash = hashProjectRef(target);
    if (sourceHash === targetHash) throw new Error("restore target must be a different project");
    return { targetProjectRef: target, targetProjectRefHash: targetHash };
}

function sortedDifference(left, right) {
    return [...left].filter((key) => !right.has(key)).sort();
}

function validateInventoryTableCounts(value, label, requireExactCanonical) {
    const counts = assertPlainObject(value, label);
    const names = Object.keys(counts);
    if (
        requireExactCanonical
        && (
            names.length !== CANONICAL_BACKUP_TABLES.length
            || CANONICAL_BACKUP_TABLES.some((table) => !Object.hasOwn(counts, table))
            || names.some((table) => !CANONICAL_TABLE_SET.has(table))
        )
    ) {
        throw new Error(`${label} must contain the exact canonical table allowlist`);
    }
    for (const table of names) {
        if (!/^omr_[a-z0-9_]+$/.test(table)) throw new Error(`${label} contains an invalid table name`);
        assertNonNegativeSafeInteger(counts[table], `${label}.${table}`);
    }
    return counts;
}

function validateInventoryObjects(value, label, enforceCanonicalContentType) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const paths = new Set();
    return value.map((item, index) => {
        const object = assertPlainObject(item, `${label}[${index}]`);
        assertExactKeys(object, ["path", "bytes", "sha256", "contentType"], `${label}[${index}]`);
        const path = validateObjectPath(object.path);
        const expectedContentType = canonicalAssetContentType(path);
        if (!expectedContentType) throw new Error(`${label}[${index}].path is not canonical`);
        if (paths.has(path)) throw new Error(`${label} contains duplicate paths`);
        paths.add(path);
        if (object.contentType !== "application/pdf" && object.contentType !== "application/json") {
            throw new Error(`${label}[${index}].contentType is invalid`);
        }
        if (enforceCanonicalContentType && object.contentType !== expectedContentType) {
            throw new Error(`${label}[${index}].contentType does not match its canonical path`);
        }
        return {
            path,
            bytes: assertPositiveSafeInteger(object.bytes, `${label}[${index}].bytes`),
            sha256: assertSha256(object.sha256, `${label}[${index}].sha256`),
            contentType: object.contentType,
        };
    });
}

export function compareRestoredInventory(expected, actual) {
    const expectedTables = validateInventoryTableCounts(expected?.tableCounts, "expected.tableCounts", true);
    const actualTables = validateInventoryTableCounts(actual?.tableCounts, "actual.tableCounts", false);
    const expectedTableNames = new Set(Object.keys(expectedTables));
    const actualTableNames = new Set(Object.keys(actualTables));
    const commonTables = [...expectedTableNames].filter((table) => actualTableNames.has(table)).sort();

    const expectedObjects = validateInventoryObjects(expected?.objects, "expected.objects", true);
    const actualObjects = validateInventoryObjects(actual?.objects, "actual.objects", false);
    const expectedByPath = new Map(expectedObjects.map((object) => [object.path, object]));
    const actualByPath = new Map(actualObjects.map((object) => [object.path, object]));
    if (expectedByPath.size !== expectedObjects.length || actualByPath.size !== actualObjects.length) {
        throw new Error("inventory objects must have unique paths");
    }
    const commonPaths = [...expectedByPath.keys()].filter((path) => actualByPath.has(path)).sort();

    const result = {
        ok: false,
        tables: {
            missing: sortedDifference(expectedTableNames, actualTableNames),
            extra: sortedDifference(actualTableNames, expectedTableNames),
            countMismatch: commonTables
                .filter((table) => expectedTables[table] !== actualTables[table])
                .map((table) => ({ table, expected: expectedTables[table], actual: actualTables[table] })),
        },
        storage: {
            missing: sortedDifference(new Set(expectedByPath.keys()), new Set(actualByPath.keys())),
            extra: sortedDifference(new Set(actualByPath.keys()), new Set(expectedByPath.keys())),
            sizeMismatch: commonPaths
                .filter((path) => expectedByPath.get(path).bytes !== actualByPath.get(path).bytes)
                .map((path) => ({ path, expected: expectedByPath.get(path).bytes, actual: actualByPath.get(path).bytes })),
            hashMismatch: commonPaths
                .filter((path) => expectedByPath.get(path).sha256 !== actualByPath.get(path).sha256)
                .map((path) => ({ path, expected: expectedByPath.get(path).sha256, actual: actualByPath.get(path).sha256 })),
            contentTypeMismatch: commonPaths
                .filter((path) => expectedByPath.get(path).contentType !== actualByPath.get(path).contentType)
                .map((path) => ({
                    path,
                    expected: expectedByPath.get(path).contentType,
                    actual: actualByPath.get(path).contentType,
                })),
        },
    };
    result.ok = Object.values(result.tables).every((items) => items.length === 0)
        && Object.values(result.storage).every((items) => items.length === 0);
    return result;
}

export function redactBackupSummary(value) {
    const candidate = {
        formatVersion: value?.formatVersion,
        createdAt: value?.createdAt,
        gitCommit: value?.gitCommit,
        sourceProjectRefHash: value?.sourceProjectRefHash,
        database: value?.database,
        storage: value?.storage,
    };
    const manifest = validateBackupManifest(candidate);
    return {
        formatVersion: manifest.formatVersion,
        createdAt: manifest.createdAt,
        gitCommit: manifest.gitCommit,
        sourceProjectRefHash: manifest.sourceProjectRefHash,
        databaseTableCount: Object.keys(manifest.database.tableCounts).length,
        databaseRowCount: Object.values(manifest.database.tableCounts).reduce((sum, count) => sum + count, 0),
        storageBucket: manifest.storage.bucket,
        storageObjectCount: manifest.storage.objectCount,
        storageTotalBytes: manifest.storage.totalBytes,
    };
}
