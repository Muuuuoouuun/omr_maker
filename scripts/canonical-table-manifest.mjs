import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CANONICAL_TABLE_COUNT = 47;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tokenizeSql(sql, sourcePath) {
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
            let terminated = false;
            index += 1;
            while (index < sql.length) {
                if (sql[index] === "'" && sql[index + 1] === "'") {
                    index += 2;
                } else if (escapeBackslashes && sql[index] === "\\") {
                    index += 2;
                } else if (sql[index] === "'") {
                    index += 1;
                    terminated = true;
                    break;
                } else {
                    index += 1;
                }
            }
            if (!terminated) throw new Error(`${sourcePath}: unterminated SQL string`);
            continue;
        }
        if (character === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
            const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
            const bodyEnd = delimiter ? sql.indexOf(delimiter, index + delimiter.length) : -1;
            if (bodyEnd === -1) throw new Error(`${sourcePath}: unterminated dollar-quoted SQL body`);
            index = bodyEnd + delimiter.length;
            continue;
        }
        if (character === '"') {
            let value = "";
            let terminated = false;
            index += 1;
            while (index < sql.length) {
                if (sql[index] === '"' && sql[index + 1] === '"') {
                    value += '"';
                    index += 2;
                } else if (sql[index] === '"') {
                    index += 1;
                    terminated = true;
                    break;
                } else {
                    value += sql[index];
                    index += 1;
                }
            }
            if (!terminated) throw new Error(`${sourcePath}: unterminated quoted SQL identifier`);
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
        if (character === ",") tokens.push({ type: "comma", value: character });
        if (character === "(") tokens.push({ type: "leftParen", value: character });
        if (character === ")") tokens.push({ type: "rightParen", value: character });
        if (character === ";") tokens.push({ type: "semicolon", value: character });
        index += 1;
    }

    if (blockCommentDepth > 0) throw new Error(`${sourcePath}: unterminated SQL block comment`);

    return tokens;
}

function identifierValue(token) {
    return token?.type === "word" || token?.type === "identifier" ? token.value : null;
}

function wordIs(token, value) {
    return token?.type === "word" && token.value === value;
}

function isCanonicalTableName(value) {
    return typeof value === "string" && /^omr_[a-z0-9_]+$/.test(value);
}

function hasCanonicalIdentifier(tokens) {
    return tokens.some((token) => isCanonicalTableName(identifierValue(token)));
}

function qualifiedName(tokens, index) {
    const schema = identifierValue(tokens[index]);
    const table = identifierValue(tokens[index + 2]);
    if (!schema || tokens[index + 1]?.type !== "dot" || !table) return null;
    return { schema, table, nextIndex: index + 3 };
}

function unsupportedIdentityDdl(sourcePath, category) {
    throw new Error(`${sourcePath}: unsupported canonical ${category}`);
}

function rejectUnsupportedCreateTarget(statement, targetIndex, sourcePath, category) {
    let index = targetIndex;
    if (
        wordIs(statement[index], "if")
        && wordIs(statement[index + 1], "not")
        && wordIs(statement[index + 2], "exists")
    ) {
        index += 3;
    }
    const target = qualifiedName(statement, index);
    if (target?.schema === "public" && isCanonicalTableName(target.table)) {
        unsupportedIdentityDdl(sourcePath, category);
    }
    if (!target && hasCanonicalIdentifier(statement.slice(index))) {
        unsupportedIdentityDdl(sourcePath, category);
    }
}

function rejectUnsupportedView(statement, sourcePath) {
    let index = 1;
    const modifiers = [];
    if (wordIs(statement[index], "or") && wordIs(statement[index + 1], "replace")) {
        modifiers.push("OR REPLACE");
        index += 2;
    }
    if (wordIs(statement[index], "temp") || wordIs(statement[index], "temporary")) {
        modifiers.push(statement[index].value.toUpperCase());
        index += 1;
    }
    if (wordIs(statement[index], "recursive")) {
        modifiers.push("RECURSIVE");
        index += 1;
    }
    if (!wordIs(statement[index], "view")) return false;

    rejectUnsupportedCreateTarget(
        statement,
        index + 1,
        sourcePath,
        `CREATE ${modifiers.length > 0 ? `${modifiers.join(" ")} ` : ""}VIEW`,
    );
    return true;
}

function createTable(state, statement, sourcePath) {
    if (wordIs(statement[1], "foreign") && wordIs(statement[2], "table")) {
        rejectUnsupportedCreateTarget(statement, 3, sourcePath, "CREATE FOREIGN TABLE");
        return;
    }
    if (rejectUnsupportedView(statement, sourcePath)) return;
    if (wordIs(statement[1], "materialized") && wordIs(statement[2], "view")) {
        rejectUnsupportedCreateTarget(statement, 3, sourcePath, "CREATE MATERIALIZED VIEW");
        return;
    }

    let index = 1;
    if (wordIs(statement[index], "global") || wordIs(statement[index], "local")) index += 1;
    if (wordIs(statement[index], "temp") || wordIs(statement[index], "temporary")) {
        if (hasCanonicalIdentifier(statement)) {
            unsupportedIdentityDdl(sourcePath, `CREATE ${statement[index].value.toUpperCase()} TABLE`);
        }
        return;
    }
    if (wordIs(statement[index], "unlogged")) index += 1;
    if (!wordIs(statement[index], "table")) return;
    index += 1;
    if (
        wordIs(statement[index], "if")
        && wordIs(statement[index + 1], "not")
        && wordIs(statement[index + 2], "exists")
    ) {
        index += 3;
    }

    const target = qualifiedName(statement, index);
    if (!target) {
        if (hasCanonicalIdentifier(statement.slice(index))) {
            unsupportedIdentityDdl(sourcePath, "CREATE TABLE");
        }
        return;
    }
    if (target.schema !== "public" || !isCanonicalTableName(target.table)) return;

    const definitionStart = statement[target.nextIndex];
    if (
        definitionStart?.type !== "leftParen"
        && !wordIs(definitionStart, "as")
        && !wordIs(definitionStart, "of")
        && !wordIs(definitionStart, "partition")
    ) {
        unsupportedIdentityDdl(sourcePath, "CREATE TABLE");
    }
    state.add(target.table);
}

function dropTable(state, statement, sourcePath) {
    let index = 2;
    if (wordIs(statement[index], "if") && wordIs(statement[index + 1], "exists")) index += 2;
    let foundCanonicalTarget = false;

    while (index < statement.length) {
        const target = qualifiedName(statement, index);
        if (!target) {
            if (hasCanonicalIdentifier(statement.slice(index)) || foundCanonicalTarget) {
                unsupportedIdentityDdl(sourcePath, "DROP TABLE");
            }
            return;
        }
        if (target.schema === "public" && isCanonicalTableName(target.table)) {
            state.delete(target.table);
            foundCanonicalTarget = true;
        }
        index = target.nextIndex;
        if (statement[index]?.type === "comma") {
            index += 1;
            continue;
        }
        if (wordIs(statement[index], "cascade") || wordIs(statement[index], "restrict")) index += 1;
        if (index !== statement.length && foundCanonicalTarget) {
            unsupportedIdentityDdl(sourcePath, "DROP TABLE");
        }
        return;
    }
}

function alterTable(state, statement, sourcePath) {
    let index = 2;
    let ifExists = false;
    if (wordIs(statement[index], "if") && wordIs(statement[index + 1], "exists")) {
        ifExists = true;
        index += 2;
    }
    if (wordIs(statement[index], "only")) index += 1;

    const target = qualifiedName(statement, index);
    if (!target) {
        if (hasCanonicalIdentifier(statement.slice(index))) {
            unsupportedIdentityDdl(sourcePath, "ALTER TABLE");
        }
        return;
    }
    const targetIsCanonical = target.schema === "public" && isCanonicalTableName(target.table);
    const action = target.nextIndex;

    if (wordIs(statement[action], "rename")) {
        if (wordIs(statement[action + 1], "column") || wordIs(statement[action + 1], "constraint")) {
            return;
        }
        if (!wordIs(statement[action + 1], "to")) {
            if (targetIsCanonical || hasCanonicalIdentifier(statement.slice(action + 1))) {
                unsupportedIdentityDdl(sourcePath, "ALTER TABLE RENAME");
            }
            return;
        }
        const renamedTable = identifierValue(statement[action + 2]);
        if (!renamedTable || action + 3 !== statement.length) {
            if (targetIsCanonical || isCanonicalTableName(renamedTable)) {
                unsupportedIdentityDdl(sourcePath, "ALTER TABLE RENAME");
            }
            return;
        }
        if (target.schema !== "public") return;
        if (!targetIsCanonical && isCanonicalTableName(renamedTable)) {
            unsupportedIdentityDdl(sourcePath, "ALTER TABLE RENAME");
        }
        if (!targetIsCanonical || (ifExists && !state.has(target.table))) return;
        state.delete(target.table);
        if (isCanonicalTableName(renamedTable)) state.add(renamedTable);
        return;
    }

    if (wordIs(statement[action], "set") && wordIs(statement[action + 1], "schema")) {
        const destinationSchema = identifierValue(statement[action + 2]);
        if (isCanonicalTableName(target.table) && (target.schema === "public" || destinationSchema === "public")) {
            unsupportedIdentityDdl(sourcePath, "ALTER TABLE SET SCHEMA");
        }
    }
}

function applySqlTableIdentity(state, { path: sourcePath, sql }) {
    const tokens = tokenizeSql(sql, sourcePath);
    let statementStart = 0;

    for (let index = 0; index <= tokens.length; index += 1) {
        if (index < tokens.length && tokens[index].type !== "semicolon") continue;
        const statement = tokens.slice(statementStart, index);
        statementStart = index + 1;
        if (wordIs(statement[0], "create")) createTable(state, statement, sourcePath);
        if (wordIs(statement[0], "drop") && wordIs(statement[1], "table")) {
            dropTable(state, statement, sourcePath);
        }
        if (wordIs(statement[0], "alter") && wordIs(statement[1], "table")) {
            alterTable(state, statement, sourcePath);
        }
    }
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
        { path: "supabase/schema.sql", sql: schemaSql },
        ...migrations
            .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    ];

    const tables = new Set();
    for (const source of sources) applySqlTableIdentity(tables, source);
    return [...tables].sort();
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
