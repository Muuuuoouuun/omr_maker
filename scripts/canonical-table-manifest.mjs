import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CANONICAL_TABLE_COUNT = 38;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tokenizeSql(sql) {
    const tokens = [];
    let index = 0;
    let blockCommentDepth = 0;

    while (index < sql.length) {
        if (blockCommentDepth > 0) {
            if (sql.startsWith("/*", index)) {
                blockCommentDepth += 1;
                index += 2;
            } else if (sql.startsWith("*/", index)) {
                blockCommentDepth -= 1;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if (sql.startsWith("--", index)) {
            const lineEnd = sql.indexOf("\n", index + 2);
            index = lineEnd === -1 ? sql.length : lineEnd + 1;
            continue;
        }
        if (sql.startsWith("/*", index)) {
            blockCommentDepth = 1;
            index += 2;
            continue;
        }

        const character = sql[index];
        if (character === "'") {
            const escapeBackslashes = /[eE]/.test(sql[index - 1] ?? "")
                && !/[A-Za-z0-9_$]/.test(sql[index - 2] ?? "");
            index += 1;
            while (index < sql.length) {
                if (sql[index] === "'" && sql[index + 1] === "'") {
                    index += 2;
                } else if (escapeBackslashes && sql[index] === "\\") {
                    index += 2;
                } else if (sql[index] === "'") {
                    index += 1;
                    break;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if (character === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
            const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
            const bodyEnd = delimiter ? sql.indexOf(delimiter, index + delimiter.length) : -1;
            index = bodyEnd === -1 ? sql.length : bodyEnd + delimiter.length;
            continue;
        }
        if (character === '"') {
            let value = "";
            index += 1;
            while (index < sql.length) {
                if (sql[index] === '"' && sql[index + 1] === '"') {
                    value += '"';
                    index += 2;
                } else if (sql[index] === '"') {
                    index += 1;
                    break;
                } else {
                    value += sql[index];
                    index += 1;
                }
            }
            tokens.push({ type: "identifier", value });
            continue;
        }
        if (/[A-Za-z_]/.test(character)) {
            const identifier = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
            tokens.push({ type: "word", value: identifier.toLowerCase() });
            index += identifier.length;
            continue;
        }
        if (character === ".") tokens.push({ type: "dot", value: character });
        if (character === ";") tokens.push({ type: "semicolon", value: character });
        index += 1;
    }

    return tokens;
}

function identifierValue(token) {
    return token?.type === "word" || token?.type === "identifier" ? token.value : null;
}

function createdCanonicalTables(sql) {
    const tokens = tokenizeSql(sql);
    const tables = [];
    let statementStart = 0;

    for (let index = 0; index <= tokens.length; index += 1) {
        if (index < tokens.length && tokens[index].type !== "semicolon") continue;
        const statement = tokens.slice(statementStart, index);
        statementStart = index + 1;
        if (statement[0]?.type !== "word" || statement[0].value !== "create") continue;
        if (statement[1]?.type !== "word" || statement[1].value !== "table") continue;

        let nameIndex = 2;
        if (
            statement[nameIndex]?.type === "word"
            && statement[nameIndex].value === "if"
            && statement[nameIndex + 1]?.type === "word"
            && statement[nameIndex + 1].value === "not"
            && statement[nameIndex + 2]?.type === "word"
            && statement[nameIndex + 2].value === "exists"
        ) {
            nameIndex += 3;
        }
        const schema = identifierValue(statement[nameIndex]);
        const table = identifierValue(statement[nameIndex + 2]);
        if (
            statement[nameIndex + 1]?.type === "dot"
            && schema === "public"
            && typeof table === "string"
            && /^omr_[a-z0-9_]+$/.test(table)
        ) {
            tables.push(table);
        }
    }

    return tables;
}

export function discoverCanonicalTables({ schemaSql, migrationSqlFiles }) {
    if (typeof schemaSql !== "string") throw new Error("schemaSql must be a string");
    if (!Array.isArray(migrationSqlFiles)) throw new Error("migrationSqlFiles must be an array");

    const paths = new Set();
    const migrations = migrationSqlFiles.map((migration) => {
        if (!migration || typeof migration !== "object" || Array.isArray(migration)) {
            throw new Error("each migration SQL file must be an object");
        }
        if (typeof migration.path !== "string" || migration.path.trim() === "") {
            throw new Error("each migration path must be a non-empty string");
        }
        if (typeof migration.sql !== "string") {
            throw new Error(`migration SQL must be a string: ${migration.path}`);
        }
        const pathKey = path.posix.normalize(migration.path.replaceAll("\\", "/"));
        if (paths.has(pathKey)) throw new Error(`duplicate migration path: ${migration.path}`);
        paths.add(pathKey);
        return { path: pathKey, sql: migration.sql };
    });
    const sources = [
        schemaSql,
        ...migrations
            .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
            .map((migration) => migration.sql),
    ];

    return [...new Set(sources.flatMap(createdCanonicalTables))].sort();
}

export function loadRepositoryCanonicalTables({ rootDir = repositoryRoot } = {}) {
    const migrationDir = path.join(rootDir, "supabase/migrations");
    const migrationSqlFiles = readdirSync(migrationDir)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => ({
            path: name,
            sql: readFileSync(path.join(migrationDir, name), "utf8"),
        }));
    const tables = discoverCanonicalTables({
        schemaSql: readFileSync(path.join(rootDir, "supabase/schema.sql"), "utf8"),
        migrationSqlFiles,
    });

    if (tables.length !== EXPECTED_CANONICAL_TABLE_COUNT) {
        throw new Error(
            `canonical table manifest must contain exactly ${EXPECTED_CANONICAL_TABLE_COUNT} tables; found ${tables.length}`,
        );
    }
    return tables;
}

export const CANONICAL_TABLES = Object.freeze(loadRepositoryCanonicalTables());
