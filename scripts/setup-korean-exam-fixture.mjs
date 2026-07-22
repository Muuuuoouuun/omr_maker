import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
    buildKoreanExamFixture,
    KOREAN_EXAM_FIXTURE_OWNER,
    SHARED_CLASS_ID,
    SHARED_ORGANIZATION_ID,
    SHARED_STUDENT_IDS,
    summarizeKoreanExamFixture,
} from "./korean-exam-fixture-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_BUCKET = "omr-private-assets";
const DEPLOYMENT_TARGETS = ["production", "preview"];
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseFixtureMode(args) {
    const selected = ["dry-run", "apply", "verify", "remove"].filter(mode => args.includes(`--${mode}`));
    if (selected.length !== 1) throw new Error("Use exactly one mode: --dry-run, --apply, --verify, or --remove");
    return selected[0];
}

function safeSegment(value) {
    if (typeof value !== "string" || !SAFE_SEGMENT.test(value.trim())) {
        throw new Error(`unsafe scope segment: ${String(value)}`);
    }
    return value.trim();
}

export function buildPrivateObjectPath({ organizationId, kind, ownerId, assetId }) {
    const organization = safeSegment(organizationId);
    const owner = safeSegment(ownerId);
    const asset = safeSegment(assetId);
    if (kind === "problem_pdf") {
        return `organizations/${organization}/exams/${owner}/problem/${asset}.pdf`;
    }
    if (kind === "attempt_handwriting") {
        return `organizations/${organization}/attempts/${owner}/handwriting/${asset}.json`;
    }
    throw new Error(`unsupported asset kind: ${String(kind)}`);
}

export function assertFixtureOwned(row, id) {
    if (!row) return;
    if (row.payload?.fixtureOwner !== KOREAN_EXAM_FIXTURE_OWNER) {
        throw new Error(`refusing to overwrite ${id}: row is not owned by ${KOREAN_EXAM_FIXTURE_OWNER}`);
    }
}

export function uniqueSupabaseTargets(configs) {
    const seen = new Set();
    return configs.filter(config => {
        if (seen.has(config.url)) return false;
        seen.add(config.url);
        return true;
    });
}

export function fixtureVerificationExpectations(fixture) {
    return {
        exams: fixture.exams.length,
        examQuestions: fixture.examQuestionRows.length,
        attempts: fixture.attemptRows.length,
        questionResults: fixture.questionResultRows.length,
        returnedFeedback: fixture.feedbackRows.filter(row => row.status === "returned").length,
        remoteAssets: fixture.pdfArtifacts.length + fixture.handwritingPayloads.length,
    };
}

function parseEnvFile(path) {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        let value = match[2];
        if (value.startsWith('"') && value.endsWith('"')) {
            try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
        } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
        }
        env[match[1]] = value;
    }
    return env;
}

function runVercel(args) {
    const result = spawnSync("npx", ["--yes", "vercel@latest", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
    });
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`Vercel command failed${detail ? `: ${detail}` : ""}`);
    }
}

function pullEnvironment(target, directory) {
    const path = resolve(directory, `.env.${target}`);
    runVercel(["env", "pull", path, `--environment=${target}`, "--yes"]);
    return parseEnvFile(path);
}

function serverConfig(env, target) {
    const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
    const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY || env.OMR_SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!url || !serviceRoleKey) throw new Error(`${target} is missing a Supabase URL or service-role key`);
    return { target, url, serviceRoleKey };
}

function adminClient(config) {
    return createClient(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

async function checkedRows(query, label) {
    const { data, error } = await query;
    if (error) throw new Error(`${label} failed: ${error.message}`);
    return data || [];
}

async function checkedMutation(query, label) {
    const { error } = await query;
    if (error) throw new Error(`${label} failed: ${error.message}`);
}

async function queryByIds(client, table, columns, ids) {
    if (ids.length === 0) return [];
    return checkedRows(client.from(table).select(columns).in("id", ids), `${table} query`);
}

async function verifySharedAccounts(client) {
    const [organizations, classes, students] = await Promise.all([
        checkedRows(client.from("omr_organizations").select("id").eq("id", SHARED_ORGANIZATION_ID), "organization prerequisite"),
        checkedRows(client.from("omr_classes").select("id").eq("id", SHARED_CLASS_ID), "class prerequisite"),
        checkedRows(client.from("omr_student_profiles").select("id").in("id", SHARED_STUDENT_IDS), "student prerequisite"),
    ]);
    if (organizations.length !== 1 || classes.length !== 1 || students.length !== 3) {
        throw new Error("shared QA organization, class, or students are missing; run accounts:deploy:apply first");
    }
}

function expectedRemoteAssets(fixture, now) {
    const pdfs = fixture.pdfArtifacts.map(artifact => ({
        id: artifact.assetId,
        organizationId: SHARED_ORGANIZATION_ID,
        kind: "problem_pdf",
        examId: artifact.examId,
        attemptId: null,
        bucket: artifact.bucket,
        objectPath: buildPrivateObjectPath({
            organizationId: SHARED_ORGANIZATION_ID,
            kind: "problem_pdf",
            ownerId: artifact.examId,
            assetId: artifact.assetId,
        }),
        mimeType: "application/pdf",
        originalName: artifact.outputName,
        localPath: resolve(root, artifact.outputPath),
        now,
    }));
    const handwriting = fixture.handwritingPayloads.map(asset => ({
        id: asset.assetId,
        organizationId: SHARED_ORGANIZATION_ID,
        kind: "attempt_handwriting",
        examId: null,
        attemptId: asset.attemptId,
        bucket: asset.bucket,
        objectPath: buildPrivateObjectPath({
            organizationId: SHARED_ORGANIZATION_ID,
            kind: "attempt_handwriting",
            ownerId: asset.attemptId,
            assetId: asset.assetId,
        }),
        mimeType: "application/json",
        originalName: asset.originalName,
        body: Buffer.from(JSON.stringify(asset.drawings), "utf8"),
        now,
    }));
    return [...pdfs, ...handwriting];
}

function assetBody(asset) {
    if (asset.body) return asset.body;
    if (!existsSync(asset.localPath)) throw new Error(`normalized PDF is missing: ${asset.localPath}`);
    return readFileSync(asset.localPath);
}

function remoteAssetRow(asset, body) {
    return {
        id: asset.id,
        organization_id: asset.organizationId,
        kind: asset.kind,
        exam_id: asset.examId,
        attempt_id: asset.attemptId,
        storage_bucket: asset.bucket,
        object_path: asset.objectPath,
        mime_type: asset.mimeType,
        byte_size: body.byteLength,
        sha256_hex: createHash("sha256").update(body).digest("hex"),
        original_name: asset.originalName,
        created_by_user_id: "teacher_fixture_korean_exam",
        created_at: asset.now,
        updated_at: asset.now,
    };
}

async function preflightOwnership(client, fixture, assets) {
    const [exams, attempts, feedback, remoteAssets, pathCollisions] = await Promise.all([
        queryByIds(client, "omr_exams", "id,payload", fixture.examRows.map(row => row.id)),
        queryByIds(client, "omr_attempts", "id,payload", fixture.attemptRows.map(row => row.id)),
        queryByIds(client, "omr_attempt_feedback", "id,payload", fixture.feedbackRows.map(row => row.id)),
        queryByIds(client, "omr_remote_assets", "id,organization_id,kind,exam_id,attempt_id,object_path", assets.map(asset => asset.id)),
        checkedRows(client.from("omr_remote_assets").select("id,object_path").in("object_path", assets.map(asset => asset.objectPath)), "remote asset path query"),
    ]);
    for (const row of [...exams, ...attempts, ...feedback]) assertFixtureOwned(row, row.id);
    const expectedById = new Map(assets.map(asset => [asset.id, asset]));
    for (const row of remoteAssets) {
        const expected = expectedById.get(row.id);
        const sameOwner = expected
            && row.organization_id === expected.organizationId
            && row.kind === expected.kind
            && row.exam_id === expected.examId
            && row.attempt_id === expected.attemptId
            && row.object_path === expected.objectPath;
        if (!sameOwner) throw new Error(`refusing to overwrite ${row.id}: remote asset ownership mismatch`);
    }
    for (const row of pathCollisions) {
        const expected = expectedById.get(row.id);
        if (!expected || row.object_path !== expected.objectPath) {
            throw new Error(`refusing to overwrite ${row.object_path}: private object path collision`);
        }
    }
}

function patchRowsWithRemoteMetadata(fixture, remoteRows) {
    const byId = new Map(remoteRows.map(row => [row.id, row]));
    const examRows = fixture.examRows.map(row => {
        const asset = byId.get(row.payload.pdfDataRef.key);
        return {
            ...row,
            payload: {
                ...row.payload,
                pdfDataRef: {
                    ...row.payload.pdfDataRef,
                    size: asset.byte_size,
                    updatedAt: asset.updated_at,
                },
            },
        };
    });
    const attemptRows = fixture.attemptRows.map(row => {
        const ref = row.payload.handwriting?.strokesRef;
        if (!ref) return row;
        const asset = byId.get(ref.key);
        const patchedRef = { ...ref, size: asset.byte_size, updatedAt: asset.updated_at };
        return {
            ...row,
            payload: {
                ...row.payload,
                drawingsRef: patchedRef,
                handwriting: { ...row.payload.handwriting, strokesRef: patchedRef },
            },
        };
    });
    return { examRows, attemptRows };
}

async function applyFixture(client, fixture) {
    await verifySharedAccounts(client);
    const assets = expectedRemoteAssets(fixture, fixture.examRows[0].updated_at);
    await preflightOwnership(client, fixture, assets);

    await checkedMutation(client.from("omr_exams").upsert(fixture.examRows, { onConflict: "id" }), "exam seed");
    await checkedMutation(client.from("omr_attempts").upsert(fixture.attemptRows, { onConflict: "id" }), "attempt seed");

    const remoteRows = [];
    for (const asset of assets) {
        const body = assetBody(asset);
        const { error } = await client.storage.from(REMOTE_BUCKET).upload(asset.objectPath, body, {
            contentType: asset.mimeType,
            upsert: true,
        });
        if (error) throw new Error(`private asset upload failed for ${asset.id}: ${error.message}`);
        remoteRows.push(remoteAssetRow(asset, body));
    }
    await checkedMutation(client.from("omr_remote_assets").upsert(remoteRows, { onConflict: "id" }), "remote asset metadata seed");

    const patched = patchRowsWithRemoteMetadata(fixture, remoteRows);
    await checkedMutation(client.from("omr_exams").upsert(patched.examRows, { onConflict: "id" }), "exam remote ref update");
    await checkedMutation(client.from("omr_attempts").upsert(patched.attemptRows, { onConflict: "id" }), "attempt remote ref update");

    await checkedMutation(client.from("omr_exam_questions").delete().in("exam_id", fixture.exams.map(exam => exam.id)), "stale exam question cleanup");
    await checkedMutation(client.from("omr_exam_questions").upsert(fixture.examQuestionRows, { onConflict: "id" }), "exam question seed");
    await checkedMutation(client.from("omr_question_results").delete().in("attempt_id", fixture.attempts.map(attempt => attempt.id)), "stale question result cleanup");
    await checkedMutation(client.from("omr_question_results").upsert(fixture.questionResultRows, { onConflict: "id" }), "question result seed");
    await checkedMutation(client.from("omr_attempt_feedback").upsert(fixture.feedbackRows, { onConflict: "id" }), "feedback seed");
}

function exactIds(rows, expectedIds) {
    return rows.length === expectedIds.length
        && rows.every(row => expectedIds.includes(row.id))
        && new Set(rows.map(row => row.id)).size === rows.length;
}

async function verifyFixture(client, fixture) {
    await verifySharedAccounts(client);
    const assets = expectedRemoteAssets(fixture, fixture.examRows[0].updated_at);
    const [exams, examQuestions, attempts, questionResults, feedback, remoteAssets] = await Promise.all([
        queryByIds(client, "omr_exams", "id,organization_id,class_id,payload", fixture.examRows.map(row => row.id)),
        checkedRows(client.from("omr_exam_questions").select("id,exam_id,question_id,correct_answer,score").in("exam_id", fixture.exams.map(exam => exam.id)), "exam question verification"),
        queryByIds(client, "omr_attempts", "id,student_profile_id,exam_id,score,total_score,retake_source_attempt_id,retake_mode,retake_question_ids,payload", fixture.attemptRows.map(row => row.id)),
        checkedRows(client.from("omr_question_results").select("id,attempt_id,status,score,earned_score").in("attempt_id", fixture.attempts.map(attempt => attempt.id)), "question result verification"),
        queryByIds(client, "omr_attempt_feedback", "id,attempt_id,status,payload", fixture.feedbackRows.map(row => row.id)),
        queryByIds(client, "omr_remote_assets", "id,kind,exam_id,attempt_id,object_path,byte_size,sha256_hex", assets.map(asset => asset.id)),
    ]);
    const expected = fixtureVerificationExpectations(fixture);
    if (!exactIds(exams, fixture.examRows.map(row => row.id)) || exams.length !== expected.exams) throw new Error("exam verification mismatch");
    if (examQuestions.length !== expected.examQuestions) throw new Error("exam question verification mismatch");
    if (!exactIds(attempts, fixture.attemptRows.map(row => row.id)) || attempts.length !== expected.attempts) throw new Error("attempt verification mismatch");
    if (questionResults.length !== expected.questionResults) throw new Error("question result verification mismatch");
    if (!exactIds(feedback, fixture.feedbackRows.map(row => row.id)) || feedback.filter(row => row.status === "returned").length !== expected.returnedFeedback) throw new Error("feedback verification mismatch");
    if (!exactIds(remoteAssets, assets.map(asset => asset.id)) || remoteAssets.length !== expected.remoteAssets) throw new Error("remote asset metadata verification mismatch");

    for (const row of exams) {
        assertFixtureOwned(row, row.id);
        if (row.organization_id !== SHARED_ORGANIZATION_ID || row.class_id !== SHARED_CLASS_ID) throw new Error(`${row.id}: exam scope mismatch`);
        if (row.payload.accessConfig?.type !== "group" || !row.payload.accessConfig.groupIds?.includes(SHARED_CLASS_ID)) throw new Error(`${row.id}: exam distribution mismatch`);
        if (!row.payload.pdfDataRef?.key) throw new Error(`${row.id}: problem PDF ref missing`);
    }
    for (const row of attempts) {
        assertFixtureOwned(row, row.id);
        const earned = questionResults.filter(result => result.attempt_id === row.id).reduce((sum, result) => sum + Number(result.earned_score), 0);
        const total = questionResults.filter(result => result.attempt_id === row.id).reduce((sum, result) => sum + Number(result.score), 0);
        if (earned !== Number(row.score) || total !== Number(row.total_score)) throw new Error(`${row.id}: score math mismatch`);
    }
    const original = attempts.find(row => row.id === "fixture-attempt-student1-original");
    const retake = attempts.find(row => row.id === "fixture-attempt-student1-retake");
    const originalWrongIds = questionResults
        .filter(row => row.attempt_id === original.id && row.status !== "correct")
        .map(row => Number(row.id.split(":").at(-1)))
        .sort((a, b) => a - b);
    const retakeIds = [...retake.retake_question_ids].sort((a, b) => a - b);
    if (retake.retake_source_attempt_id !== original.id || retake.retake_mode !== "wrong" || JSON.stringify(retakeIds) !== JSON.stringify(originalWrongIds)) {
        throw new Error("wrong-answer retake linkage mismatch");
    }
    for (const asset of assets) {
        const metadata = remoteAssets.find(row => row.id === asset.id);
        if (metadata.object_path !== asset.objectPath || metadata.byte_size <= 0 || !/^[a-f0-9]{64}$/.test(metadata.sha256_hex)) {
            throw new Error(`${asset.id}: remote asset metadata invalid`);
        }
        const { data, error } = await client.storage.from(REMOTE_BUCKET).download(asset.objectPath);
        if (error || !data || data.size !== metadata.byte_size) throw new Error(`${asset.id}: private storage object verification failed`);
    }
    return expected;
}

async function removeFixture(client, fixture) {
    const assets = expectedRemoteAssets(fixture, fixture.examRows[0].updated_at);
    await preflightOwnership(client, fixture, assets);
    await checkedMutation(client.from("omr_attempt_feedback").delete().in("id", fixture.feedbackRows.map(row => row.id)), "feedback removal");
    await checkedMutation(client.from("omr_question_results").delete().in("attempt_id", fixture.attempts.map(attempt => attempt.id)), "question result removal");
    await checkedMutation(client.from("omr_remote_assets").delete().in("id", assets.map(asset => asset.id)), "remote asset metadata removal");
    const { error: storageError } = await client.storage.from(REMOTE_BUCKET).remove(assets.map(asset => asset.objectPath));
    if (storageError) throw new Error(`private asset removal failed: ${storageError.message}`);
    await checkedMutation(client.from("omr_attempts").delete().in("id", fixture.attemptRows.map(row => row.id)), "attempt removal");
    await checkedMutation(client.from("omr_exam_questions").delete().in("exam_id", fixture.exams.map(exam => exam.id)), "exam question removal");
    await checkedMutation(client.from("omr_exams").delete().in("id", fixture.examRows.map(row => row.id)), "exam removal");
}

async function loadConfigs() {
    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "omr-korean-exam-fixture-"));
    try {
        return DEPLOYMENT_TARGETS.map(target => serverConfig(pullEnvironment(target, temporaryDirectory), target));
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

async function main() {
    const mode = parseFixtureMode(process.argv.slice(2));
    const fixture = buildKoreanExamFixture({ now: "2026-07-22T09:00:00.000Z" });
    if (mode === "dry-run") {
        process.stdout.write(`${JSON.stringify(summarizeKoreanExamFixture(fixture), null, 2)}\n`);
        return;
    }

    const configs = uniqueSupabaseTargets(await loadConfigs());
    for (const config of configs) {
        const client = adminClient(config);
        if (mode === "apply") {
            await applyFixture(client, fixture);
            const verified = await verifyFixture(client, fixture);
            process.stdout.write(`${config.target}: fixture applied and verified ${JSON.stringify(verified)}\n`);
        } else if (mode === "verify") {
            const verified = await verifyFixture(client, fixture);
            process.stdout.write(`${config.target}: fixture verified ${JSON.stringify(verified)}\n`);
        } else {
            await removeFixture(client, fixture);
            process.stdout.write(`${config.target}: fixture removed\n`);
        }
    }
}

const isEntrypoint = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
