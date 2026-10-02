#!/usr/bin/env node

import { createHash, pbkdf2, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const STUDENT_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_HEALTH_BYTES = 8 * 1024;
const MAX_HEALTH_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const STUDENT_CREDENTIAL_SESSIONS = new WeakMap();

export const RESTORE_SMOKE_STEPS = Object.freeze(["create", "publish", "invite", "solve", "submit", "feedback"]);

function fail(message = "Repository restore smoke was not verified") {
    throw new Error(message);
}

export async function runBoundedRestoreSmokeOperation(operation, options = {}) {
    if (typeof operation !== "function") fail();
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_OPERATION_TIMEOUT_MS
        || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > DEFAULT_CLEANUP_TIMEOUT_MS
    ) fail("Repository smoke operation bounds are invalid");
    const controller = new AbortController();
    let timedOut = false;
    let timeout;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("Repository smoke operation timed out"));
            reject(new Error("Repository smoke operation timed out"));
        }, timeoutMs);
    });
    try {
        return await Promise.race([operationPromise, timeoutPromise]);
    } catch {
        controller.abort(new Error("Repository smoke operation failed"));
        if (timedOut) {
            let cleanupTimer;
            const joined = await Promise.race([
                operationPromise.then(() => true, () => true),
                new Promise(resolvePromise => {
                    cleanupTimer = setTimeout(() => resolvePromise(false), cleanupTimeoutMs);
                }),
            ]);
            clearTimeout(cleanupTimer);
            if (!joined) fail("Repository smoke operation cleanup timed out");
        }
        fail(timedOut ? "Repository smoke operation timed out" : "Repository smoke operation failed");
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

function exactDataObject(value, required, optional = []) {
    const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
    if (
        !value || typeof value !== "object" || Array.isArray(value)
        || (prototype !== Object.prototype && prototype !== null)
    ) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(descriptors);
    if (
        required.some(key => !Object.hasOwn(descriptors, key))
        || keys.some(key => !allowed.has(key))
        || Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)
    ) fail();
    return value;
}

async function readBoundedResponseJson(response, signal) {
    const reader = response?.body?.getReader?.();
    if (!reader) fail("Restore target health response is invalid");
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            if (signal?.aborted) fail("Restore target health request was aborted");
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > MAX_HEALTH_BYTES) fail("Restore target health response exceeded its bound");
            chunks.push(Buffer.from(item.value));
        }
        return parseStrictJson(Buffer.concat(chunks, bytes).toString("utf8"));
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

export async function probeRestoreTargetHealth(config, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? new Date();
    if (typeof fetchImpl !== "function" || !(now instanceof Date) || Number.isNaN(now.getTime())) {
        fail("Restore target health probe is invalid");
    }
    const url = new URL("/api/healthz", `${config.targetAppUrl}/`);
    if (url.origin !== config.targetAppUrl) fail("Restore target health origin is invalid");
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Restore target health request aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, 10_000);
    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: { accept: "application/json", "user-agent": "omr-repository-restore-smoke/1" },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        if (
            response?.status !== 200
            || !response.headers?.get("content-type")?.toLowerCase().startsWith("application/json")
            || !response.headers?.get("cache-control")?.toLowerCase().includes("no-store")
        ) fail("Restore target health response was not verified");
        const body = exactDataObject(await readBoundedResponseJson(response, controller.signal), [
            "status", "build", "timestamp",
        ]);
        const timestamp = typeof body.timestamp === "string" ? Date.parse(body.timestamp) : Number.NaN;
        if (
            body.status !== "alive"
            || body.build !== config.buildSha
            || !Number.isFinite(timestamp)
            || new Date(timestamp).toISOString() !== body.timestamp
            || Math.abs(now.getTime() - timestamp) > MAX_HEALTH_CLOCK_SKEW_MS
        ) fail("Restore target health build was not verified");
        return Object.freeze({ status: body.status, build: body.build, timestamp: body.timestamp });
    } catch (error) {
        if (error instanceof Error && /Restore target health/.test(error.message)) throw error;
        fail("Restore target health request failed");
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
    }
}

function safeSecret(value, pattern) {
    return typeof value === "string"
        && value.length >= 6
        && Buffer.byteLength(value, "utf8") <= 4096
        && !/[\s\u0000-\u001f\u007f]/.test(value)
        && (!pattern || pattern.test(value));
}

function exactUrl(value, label) {
    let url;
    try { url = new URL(value); } catch { fail(`${label} is invalid`); }
    if (
        url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || url.pathname !== "/" || url.port
    ) fail(`${label} is invalid`);
    return url;
}

function projectRef(url) {
    const ref = url.hostname.split(".")[0].toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(ref) || url.hostname !== `${ref}.supabase.co`) fail("Restore project is invalid");
    return ref;
}

function actor(value) {
    exactDataObject(value, ["id", "credential"]);
    if (!SAFE_ID.test(value.id) || !safeSecret(value.credential)) fail("Disposable actor is invalid");
    return value;
}

function bindingFromRequest(request, config) {
    if (
        request.buildSha !== config.buildSha
        || request.environmentDigest !== config.environmentDigest
        || request.targetDigest !== config.targetDigest
    ) fail("Restore smoke binding does not match");
}

function exactRequest(value) {
    return exactDataObject(value, [
        "schemaVersion", "operation", "buildSha", "environmentDigest", "targetDigest", "disposableRunId",
    ], [
        "actor", "teacher", "actors", "actorId", "teacherId", "studentIds", "studentActors",
        "teacherSessionGeneration", "revocationNonce",
    ]);
}

export function resolveRepositoryRestoreSmokeConfig(input = {}, expectedBuild) {
    const env = input.env ?? {};
    if (env.OMR_DEPLOYMENT_TIER !== "staging") fail("Repository restore smoke requires staging");
    const buildSha = env.OMR_BUILD_SHA;
    if (!BUILD_SHA.test(buildSha) || (expectedBuild !== undefined && buildSha !== expectedBuild)) fail("Restore smoke build does not match");
    const environmentDigest = env.OMR_RESTORE_ENVIRONMENT_DIGEST;
    const targetDigest = env.OMR_RESTORE_TARGET_DIGEST;
    if (!SHA256.test(environmentDigest) || !SHA256.test(targetDigest)) fail("Restore smoke binding is invalid");
    const targetSupabase = exactUrl(env.OMR_RESTORE_TARGET_SUPABASE_URL, "Restore Supabase URL");
    const targetApp = exactUrl(env.OMR_RESTORE_TARGET_APP_URL, "Restore app URL");
    const productionSupabase = exactUrl(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL");
    const targetProjectRef = projectRef(targetSupabase);
    const productionProjectRef = projectRef(productionSupabase);
    if (
        targetProjectRef === productionProjectRef
        || env.OMR_RESTORE_TARGET_PROJECT_REF !== targetProjectRef
        || (env.OMR_PRODUCTION_APP_URL && exactUrl(env.OMR_PRODUCTION_APP_URL, "Production app URL").hostname === targetApp.hostname)
    ) fail("Restore smoke target must differ from production");
    if (env.OMR_DELIVERY_PROVIDER_MODE !== "disabled" || env.OMR_PAYMENT_PROVIDER_MODE !== "disabled") {
        fail("External provider contact is forbidden during restore smoke");
    }
    const serviceRoleKey = env.OMR_RESTORE_TARGET_SERVICE_ROLE_KEY;
    if (!safeSecret(serviceRoleKey) || Buffer.byteLength(serviceRoleKey, "utf8") < 32) fail("Restore smoke credentials are invalid");
    const restoreStartedAt = env.OMR_RESTORE_STARTED_AT;
    if (
        typeof restoreStartedAt !== "string" || Number.isNaN(Date.parse(restoreStartedAt))
        || new Date(restoreStartedAt).toISOString() !== restoreStartedAt
    ) fail("Restore started time binding is invalid");
    const safe = {
        environment: "staging",
        buildSha,
        environmentDigest,
        targetDigest,
        targetProjectRef,
        targetSupabaseUrl: targetSupabase.origin,
        targetAppUrl: targetApp.origin,
        restoreStartedAt,
    };
    Object.defineProperty(safe, "serviceRoleKey", { value: serviceRoleKey, enumerable: false });
    return Object.freeze(safe);
}

function pbkdf2Verifier(secret, saltDomain) {
    const salt = saltDomain
        ? createHash("sha256").update(`omr.restore-smoke.verifier:v1\n${saltDomain}`).digest().subarray(0, 16)
        : randomBytes(16);
    return new Promise((resolvePromise, rejectPromise) => pbkdf2(secret, salt, 120_000, 32, "sha256", (error, value) => {
        if (error) rejectPromise(error);
        else resolvePromise(`pbkdf2-sha256:120000:${salt.toString("hex")}:${value.toString("hex")}`);
    }));
}

function clientFor(config, operationSignal) {
    return createClient(config.targetSupabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: {
            headers: { "x-omr-client": "repository-restore-smoke" },
            fetch: async (input, init = {}) => {
                const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
                if (requestUrl.origin !== config.targetSupabaseUrl) fail("Repository smoke network target is invalid");
                const controller = new AbortController();
                const abort = () => controller.abort(new Error("Repository smoke request aborted"));
                operationSignal?.addEventListener("abort", abort, { once: true });
                init.signal?.addEventListener("abort", abort, { once: true });
                if (operationSignal?.aborted || init.signal?.aborted) abort();
                const timer = setTimeout(abort, 10_000);
                try {
                    return await fetch(input, { ...init, signal: controller.signal });
                } finally {
                    clearTimeout(timer);
                    operationSignal?.removeEventListener("abort", abort);
                    init.signal?.removeEventListener("abort", abort);
                }
            },
        },
    });
}

function exactCredentialSession(value) {
    exactDataObject(value, ["accountId", "credentialGeneration", "startCodeHash"]);
    if (
        typeof value.accountId !== "string" || value.accountId.length < 1 || value.accountId.length > 256
        || !Number.isSafeInteger(value.credentialGeneration)
        || value.credentialGeneration < 1 || value.credentialGeneration > 2_147_483_646
        || typeof value.startCodeHash !== "string"
        || !/^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/.test(value.startCodeHash)
    ) fail("Disposable student credential session is invalid");
    return value;
}

async function readStudentCredentialSession(client, organizationId, studentId) {
    const result = await client
        .from("omr_student_start_credentials")
        .select("account_id,credential_generation,start_code_hash")
        .eq("organization_id", organizationId)
        .eq("student_profile_id", studentId)
        .single();
    if (result.error || !result.data) fail("Disposable student credential session is unavailable");
    const record = exactDataObject(result.data, ["account_id", "credential_generation", "start_code_hash"]);
    return exactCredentialSession({
        accountId: record.account_id,
        credentialGeneration: record.credential_generation,
        startCodeHash: record.start_code_hash,
    });
}

function studentCredentialSessionMap(config) {
    let sessions = STUDENT_CREDENTIAL_SESSIONS.get(config);
    if (!sessions) {
        sessions = new Map();
        STUDENT_CREDENTIAL_SESSIONS.set(config, sessions);
    }
    return sessions;
}

export function validateRotatedStudentCredentialRevocation(oldCredential, currentCredential, validationResult) {
    const before = exactCredentialSession(oldCredential);
    const after = exactCredentialSession(currentCredential);
    if (
        !validationResult || typeof validationResult !== "object" || Array.isArray(validationResult)
        || validationResult.error !== null || validationResult.data !== false
        || after.accountId === before.accountId
        || after.credentialGeneration !== before.credentialGeneration + 1
        || after.startCodeHash === before.startCodeHash
    ) fail("Disposable student credential revocation was not verified");
    return true;
}

function teacherEmail(id) {
    if (!SAFE_ID.test(id)) fail("Disposable teacher is invalid");
    return `${id}@restore.invalid`;
}

function teacherProvisioningRequest(config, teacher, runId, verifier, replacement, revocationNonce) {
    const expiry = new Date(Date.parse(config.restoreStartedAt) + 24 * 60 * 60 * 1000).toISOString();
    const idempotency = createHash("sha256")
        .update(`omr.restore-smoke.teacher:v1\n${runId}\n${replacement ? revocationNonce : "initial"}`)
        .digest("hex");
    return {
        p_organization_name: `Restore ${runId}`,
        p_email: teacherEmail(teacher.id),
        p_display_name: "Restore Teacher",
        p_password_hash: verifier,
        p_plan: "academy",
        p_expires_at: expiry,
        p_actor: `operator:${runId}`,
        p_reason: replacement ? "restore_smoke_revoke" : "restore_smoke",
        p_idempotency_key: `prov_${idempotency}`,
    };
}

async function provisionedTeacherIdentity(config, teacher, runId, replacement = false, revocationNonce, signal) {
    if (replacement && !safeSecret(revocationNonce, /^[A-Za-z0-9_-]{32,}$/)) fail("Disposable revocation binding is invalid");
    const client = clientFor(config, signal);
    const verifier = await pbkdf2Verifier(
        replacement ? revocationNonce : teacher.credential,
        replacement ? `${runId}:${teacher.id}:revoke:${revocationNonce}` : `${runId}:${teacher.id}:initial`,
    );
    const result = await client.rpc(
        "omr_provision_pilot_teacher_v1",
        teacherProvisioningRequest(config, teacher, runId, verifier, replacement, revocationNonce),
    );
    if (result.error || !result.data?.accountId || !result.data?.organizationId) fail("Disposable teacher provisioning failed");
    return {
        client,
        accountId: result.data.accountId,
        organizationId: result.data.organizationId,
        sessionGeneration: replacement ? 2 : 1,
        replayed: result.data.replayed,
        verifier,
    };
}

async function defaultCreateTeacher(config, request, signal) {
    const disposable = actor(request.actor);
    const identity = await provisionedTeacherIdentity(config, disposable, request.disposableRunId, false, undefined, signal);
    if (identity.replayed === true) fail("Disposable teacher creation replayed unexpectedly");
    return { status: "created", actorId: disposable.id };
}

async function defaultCreateStudent(config, request, signal) {
    const disposable = actor(request.actor);
    const teacher = actor(request.teacher);
    if (!Array.isArray(request.studentActors) || request.studentActors.length < 1 || request.studentActors.length > 2) {
        fail("Disposable student roster is invalid");
    }
    const studentActors = request.studentActors.map(actor);
    if (studentActors.at(-1).id !== disposable.id || new Set(studentActors.map(item => item.id)).size !== studentActors.length) {
        fail("Disposable student roster is invalid");
    }
    if (!STUDENT_CODE.test(disposable.credential)) fail("Disposable student credential is invalid");
    const identity = await provisionedTeacherIdentity(config, teacher, request.disposableRunId, false, undefined, signal);
    const classId = `${request.disposableRunId}-class`;
    const rosterResult = await identity.client.rpc("omr_save_roster_v3", {
        p_session_authority: "account",
        p_account_id: identity.accountId,
        p_session_generation: request.teacherSessionGeneration,
        p_actor_user_id: identity.accountId,
        p_organization_id: identity.organizationId,
        p_classes: [{
            id: classId,
            organization_id: identity.organizationId,
            name: "Restore Smoke Class",
            campus: "Restore",
            status: "active",
            metadata: { restoreSmoke: true },
        }],
        p_students: studentActors.map(item => ({
            id: item.id,
            organization_id: identity.organizationId,
            display_name: item.id,
            external_id: item.id,
            email: `${item.id}@restore.invalid`,
            status: "active",
            metadata: { restoreSmoke: true },
        })),
        p_enrollments: studentActors.map(item => ({
            class_id: classId,
            organization_id: identity.organizationId,
            student_profile_id: item.id,
            enrollment_status: "active",
        })),
        p_invites: [],
        p_expected_revision: studentActors.length === 1 ? null : studentActors.length - 1,
    });
    if (rosterResult.error || rosterResult.data?.revision !== studentActors.length) fail("Disposable student roster creation failed");
    const verifier = await pbkdf2Verifier(disposable.credential, `${request.disposableRunId}:${disposable.id}:initial`);
    const idempotency = createHash("sha256").update(`${request.disposableRunId}:${disposable.id}`).digest("hex");
    const credentialResult = await identity.client.rpc("omr_issue_student_start_code_batch_v1", {
        p_session_authority: "account",
        p_account_id: identity.accountId,
        p_session_generation: identity.sessionGeneration,
        p_organization_id: identity.organizationId,
        p_actor_user_id: identity.accountId,
        p_items: [{ studentId: disposable.id, verifier }],
        p_idempotency_key: `batch_${idempotency}`,
    });
    if (credentialResult.error || credentialResult.data?.status !== "issued") fail("Disposable student credential creation failed");
    const credentialSession = await readStudentCredentialSession(
        identity.client,
        identity.organizationId,
        disposable.id,
    );
    studentCredentialSessionMap(config).set(disposable.id, credentialSession);
    return { status: "created", actorId: disposable.id };
}

export async function selectExactOptionByText(selectLocator, expectedText) {
    if (
        !selectLocator || typeof selectLocator.locator !== "function" || typeof selectLocator.selectOption !== "function"
        || typeof expectedText !== "string" || expectedText.length < 1 || expectedText.length > 256
        || expectedText.trim() !== expectedText
    ) fail("Restore smoke class selector is invalid");
    const options = selectLocator.locator("option");
    const count = await options.count();
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) fail("Restore smoke class options are invalid");
    let exactValue = null;
    for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        const text = (await option.textContent())?.trim();
        if (text !== expectedText) continue;
        if (exactValue !== null) fail("Restore smoke class option is ambiguous");
        const value = await option.getAttribute("value");
        if (typeof value !== "string" || value.length < 1 || value.length > 256) {
            fail("Restore smoke class option is invalid");
        }
        exactValue = value;
    }
    if (exactValue === null) fail("Restore smoke class option is missing");
    const selected = await selectLocator.selectOption(exactValue);
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0] !== exactValue) {
        fail("Restore smoke class selection failed");
    }
    return exactValue;
}

async function defaultBrowserJourney(config, request, signal) {
    const actors = exactDataObject(request.actors, ["teacher", "students"]);
    const teacher = actor(actors.teacher);
    if (!Array.isArray(actors.students) || actors.students.length !== 2) fail("Disposable students are invalid");
    const students = actors.students.map(actor);
    await probeRestoreTargetHealth(config, { signal });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const abortBrowser = () => { void browser.close().catch(() => undefined); };
    signal?.addEventListener("abort", abortBrowser, { once: true });
    const startedAt = new Date().toISOString();
    const steps = {};
    try {
        const teacherContext = await browser.newContext();
        const teacherPage = await teacherContext.newPage();
        await teacherPage.goto(`${config.targetAppUrl}/?role=teacher`, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await teacherPage.getByLabel("아이디 또는 이메일").fill(teacherEmail(teacher.id));
        await teacherPage.getByLabel("비밀번호").fill(teacher.credential);
        await teacherPage.getByRole("button", { name: /대시보드 입장|로그인/ }).click();
        await teacherPage.waitForURL(/\/teacher\/(?:dashboard|create)/, { timeout: 20_000 });
        await teacherPage.goto(`${config.targetAppUrl}/create`);
        await teacherPage.getByLabel("시험 제목").fill(`Restore Smoke ${request.disposableRunId}`);
        await teacherPage.getByLabel("문항 수 직접 입력").fill("1");
        await teacherPage.getByLabel("문항 수 직접 입력").press("Enter");
        await teacherPage.getByLabel("빠른 정답 입력").fill("1");
        steps.create = "passed";
        await teacherPage.getByRole("button", { name: /배포하기|저장하고 배포하기/ }).click();
        await teacherPage.getByRole("dialog", { name: "시험 배포하기" }).waitFor({ state: "visible", timeout: 15_000 });
        await teacherPage.getByRole("checkbox", { name: /Restore Smoke Class/ }).check();
        await teacherPage.getByRole("button", { name: /링크 생성하기|배포하기/ }).last().click();
        await teacherPage.getByRole("button", { name: "링크 복사" }).waitFor({ state: "visible", timeout: 15_000 });
        steps.publish = "passed";
        const inviteUrl = (await teacherPage.getByTestId("distribution-share-url").textContent())?.trim();
        let parsedInvite;
        try { parsedInvite = new URL(inviteUrl); } catch { fail("Restore smoke invite URL is invalid"); }
        if (
            parsedInvite.origin !== config.targetAppUrl
            || !/^\/solve\/[A-Za-z0-9_-]{1,256}$/.test(parsedInvite.pathname)
            || !/^#invite=[A-Za-z0-9_-]{16,4096}$/.test(parsedInvite.hash)
        ) fail("Restore smoke invite URL is invalid");
        const studentContext = await browser.newContext();
        const studentPage = await studentContext.newPage();
        await studentPage.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (new URL(studentPage.url()).origin !== config.targetAppUrl) fail("Restore smoke invite escaped its target");
        await studentPage.getByRole("heading", { name: "학습 시작" }).waitFor({ state: "visible", timeout: 15_000 });
        await studentPage.getByLabel("반 선택").locator("option", { hasText: "Restore Smoke Class" })
            .waitFor({ state: "attached", timeout: 15_000 });
        await studentPage.getByText("초대된 반을 찾을 수 없습니다", { exact: false }).waitFor({ state: "hidden" });
        steps.invite = "passed";
        await studentPage.getByPlaceholder("이름을 입력하세요").fill(students[0].id);
        await studentPage.getByLabel("학생번호 또는 이메일").fill(students[0].id);
        const groupSelect = studentPage.getByLabel("반 선택");
        if (await groupSelect.isVisible().catch(() => false)) {
            await selectExactOptionByText(groupSelect, "Restore Smoke Class");
        }
        else await studentPage.getByLabel("반 코드").fill(`${request.disposableRunId}-class`);
        await studentPage.getByLabel("시작 코드").fill(students[0].credential);
        await studentPage.getByRole("button", { name: "시험 시작하기" }).click();
        await studentPage.getByRole("link", { name: /시작/ }).first().click();
        await studentPage.getByRole("radio", { name: /문제 1번 보기 1/ }).check();
        steps.solve = "passed";
        await studentPage.getByRole("button", { name: /제출/ }).click();
        const confirm = studentPage.getByRole("dialog");
        if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /제출/ }).click();
        await studentPage.waitForURL(/\/student\/review\//, { timeout: 20_000 });
        steps.submit = "passed";

        await teacherPage.goto(`${config.targetAppUrl}/teacher/dashboard`);
        await teacherPage.getByRole("link", { name: /결과|성취도/ }).first().click();
        await teacherPage.getByRole("link", { name: /결과 보기|학생 결과 보기/ }).first().click();
        const feedback = teacherPage.getByLabel("전체 피드백");
        await feedback.fill("Restore smoke feedback");
        await teacherPage.getByRole("button", { name: "학생에게 반환" }).click();
        await teacherPage.getByRole("status").filter({ hasText: "학생에게 피드백을 반환했습니다." }).waitFor();
        await studentPage.reload();
        await studentPage.getByText("Restore smoke feedback", { exact: true }).waitFor({ timeout: 15_000 });
        steps.feedback = "passed";
        await studentContext.close();
        await teacherContext.close();
    } finally {
        signal?.removeEventListener("abort", abortBrowser);
        await browser.close();
    }
    if (RESTORE_SMOKE_STEPS.some(step => steps[step] !== "passed")) fail("Browser journey was incomplete");
    return {
        status: "passed",
        freshContext: true,
        steps: [...RESTORE_SMOKE_STEPS],
        startedAt,
        completedAt: new Date().toISOString(),
    };
}

async function defaultRevokeStudent(config, request, signal) {
    const disposable = actor(request.actor);
    const teacher = actor(request.teacher);
    if (disposable.id !== request.actorId) fail("Disposable student is invalid");
    const oldCredential = studentCredentialSessionMap(config).get(disposable.id);
    if (!oldCredential) fail("Disposable student credential session is unavailable");
    const identity = await provisionedTeacherIdentity(config, teacher, request.disposableRunId, false, undefined, signal);
    if (!safeSecret(request.revocationNonce, /^[A-Za-z0-9_-]{32,}$/)) fail("Disposable revocation binding is invalid");
    const replacementVerifier = await pbkdf2Verifier(
        request.revocationNonce,
        `${request.disposableRunId}:${disposable.id}:revoke:${request.revocationNonce}`,
    );
    const idempotency = createHash("sha256")
        .update(`omr.restore-smoke.student-revoke:v1\n${request.disposableRunId}\n${disposable.id}\n${request.revocationNonce}`)
        .digest("hex");
    const result = await identity.client.rpc("omr_issue_student_start_code_batch_v1", {
        p_session_authority: "account",
        p_account_id: identity.accountId,
        p_session_generation: request.teacherSessionGeneration,
        p_organization_id: identity.organizationId,
        p_actor_user_id: identity.accountId,
        p_items: [{ studentId: disposable.id, verifier: replacementVerifier }],
        p_idempotency_key: `batch_${idempotency}`,
    });
    if (result.error || !["issued", "already_applied"].includes(result.data?.status)) {
        fail("Disposable student revocation failed");
    }
    const currentCredential = await readStudentCredentialSession(
        identity.client,
        identity.organizationId,
        disposable.id,
    );
    const staleSession = await identity.client.rpc("omr_validate_student_session_v1", {
        p_account_id: oldCredential.accountId,
        p_organization_id: identity.organizationId,
        p_student_id: disposable.id,
        p_credential_generation: oldCredential.credentialGeneration,
    });
    validateRotatedStudentCredentialRevocation(oldCredential, currentCredential, staleSession);
    studentCredentialSessionMap(config).delete(disposable.id);
    return { status: "revoked", actorId: request.actorId };
}

async function defaultRevokeTeacher(config, request, signal) {
    const disposable = actor(request.actor);
    if (disposable.id !== request.actorId) fail("Disposable teacher is invalid");
    const initialVerifier = await pbkdf2Verifier(disposable.credential, `${request.disposableRunId}:${disposable.id}:initial`);
    const identity = await provisionedTeacherIdentity(
        config,
        disposable,
        request.disposableRunId,
        true,
        request.revocationNonce,
        signal,
    );
    const lookup = await identity.client.rpc("omr_lookup_provisioned_teacher_login_v1", {
        p_identifier: teacherEmail(disposable.id),
    });
    const staleSession = await identity.client.rpc("omr_validate_provisioned_teacher_session_v1", {
        p_account_id: identity.accountId,
        p_session_generation: 1,
        p_organization_id: identity.organizationId,
    });
    if (
        lookup.error || !lookup.data || lookup.data.passwordHash === initialVerifier
        || lookup.data.sessionGeneration !== 2 || staleSession.error || staleSession.data !== null
    ) fail("Disposable teacher revocation failed");
    return { status: "revoked", actorId: request.actorId };
}

function validateJourneyReceipt(receipt) {
    exactDataObject(receipt, ["status", "freshContext", "steps"], ["startedAt", "completedAt"]);
    if (
        receipt.status !== "passed" || receipt.freshContext !== true
        || !Array.isArray(receipt.steps) || receipt.steps.length !== RESTORE_SMOKE_STEPS.length
        || receipt.steps.some((step, index) => step !== RESTORE_SMOKE_STEPS[index])
    ) fail("Browser journey receipt is not exact");
    return receipt;
}

export async function executeRepositoryRestoreSmokeOperation(config, rawRequest, dependencies = {}) {
    const request = exactRequest(rawRequest);
    if (request.schemaVersion !== 1 || !SAFE_ID.test(request.disposableRunId)) fail("Disposable identifier is invalid");
    bindingFromRequest(request, config);
    switch (request.operation) {
        case "create-teacher":
            return (dependencies.createTeacher ?? defaultCreateTeacher)(config, request, dependencies.signal);
        case "create-student":
            return (dependencies.createStudent ?? defaultCreateStudent)(config, request, dependencies.signal);
        case "browser-journey": {
            const receipt = validateJourneyReceipt(await (dependencies.runBrowserJourney ?? defaultBrowserJourney)(
                config,
                request,
                dependencies.signal,
            ));
            if (!request.actors) return receipt;
            const actors = exactDataObject(request.actors, ["teacher", "students"]);
            const actorIds = [actor(actors.teacher).id, ...actors.students.map(actor).map(value => value.id)];
            return {
                status: "passed",
                buildSha: config.buildSha,
                environmentDigest: config.environmentDigest,
                targetDigest: config.targetDigest,
                startedAt: receipt.startedAt,
                completedAt: receipt.completedAt,
                actorIds,
                steps: Object.fromEntries(RESTORE_SMOKE_STEPS.map(step => [step, "passed"])),
            };
        }
        case "revoke-teacher":
            return (dependencies.revokeTeacher ?? defaultRevokeTeacher)(config, request, dependencies.signal);
        case "revoke-student":
            return (dependencies.revokeStudent ?? defaultRevokeStudent)(config, request, dependencies.signal);
        default:
            fail("Restore smoke operation is not allowed");
    }
}

async function defaultExecOperation(config, operation, payload) {
    const binding = payload.binding;
    const actorValue = payload.actor;
    const disposableRunId = payload.disposableRunId
        ?? payload.teacher?.id
        ?? payload.actors?.teacher?.id
        ?? actorValue?.id
        ?? payload.actorId;
    const request = {
        schemaVersion: 1,
        operation,
        buildSha: binding.buildSha,
        environmentDigest: binding.environmentDigest,
        targetDigest: binding.targetDigest,
        disposableRunId,
        ...(actorValue ? { actor: actorValue } : {}),
        ...(payload.teacher ? { teacher: payload.teacher } : {}),
        ...(payload.actors ? { actors: payload.actors } : {}),
        ...(payload.actorId ? { actorId: payload.actorId } : {}),
        ...(payload.studentActors ? { studentActors: payload.studentActors } : {}),
        ...(payload.teacherSessionGeneration ? { teacherSessionGeneration: payload.teacherSessionGeneration } : {}),
        ...(payload.revocationNonce ? { revocationNonce: payload.revocationNonce } : {}),
    };
    let result;
    try {
        result = await runBoundedRestoreSmokeOperation(signal => executeRepositoryRestoreSmokeOperation(
            config,
            request,
            { signal },
        ));
    } catch { fail("Repository smoke operation failed"); }
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) fail("Repository smoke output exceeded its bound");
    return parseStrictJson(serialized);
}

export function createRepositoryRestoredSmokeDependencies(config, overrides = {}) {
    const execOperation = overrides.execOperation ?? ((operation, payload) => defaultExecOperation(config, operation, payload));
    const generateIdentity = overrides.createDisposableIdentity ?? ((kind, index) => {
        if (kind === "student") {
            const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
            const code = Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join("");
            return { id: `restore-student-${index}-${randomBytes(4).toString("hex")}`, credential: code };
        }
        return {
            id: `restore-teacher-${randomBytes(4).toString("hex")}`,
            credential: `R-${randomBytes(24).toString("base64url")}`,
        };
    });
    let teacherActor;
    const studentActors = [];
    let teacherSessionGeneration = 1;
    const retryExactOperation = async (operation, payload) => {
        try {
            return await execOperation(operation, payload);
        } catch {
            return execOperation(operation, payload);
        }
    };
    return Object.freeze({
        now: overrides.now ?? (() => new Date()),
        createDisposableIdentity: generateIdentity,
        createTeacher(binding, actorValue) {
            teacherActor = actorValue;
            return execOperation("create-teacher", {
                binding, actor: actorValue, disposableRunId: actorValue.id,
            });
        },
        createStudent(binding, actorValue, teacher) {
            if (!teacherActor || teacher.id !== teacherActor.id) fail("Disposable teacher binding is unavailable");
            studentActors.push(actorValue);
            return execOperation("create-student", {
                binding,
                actor: actorValue,
                teacher,
                studentActors: [...studentActors],
                teacherSessionGeneration,
                disposableRunId: teacher.id,
            });
        },
        runBrowserJourney(binding, actors) {
            return execOperation("browser-journey", {
                binding, actors, disposableRunId: actors.teacher.id,
            });
        },
        revokeTeacher(binding, actorValue) {
            const payload = {
                binding,
                actor: actorValue,
                actorId: actorValue.id,
                disposableRunId: actorValue.id,
                revocationNonce: randomBytes(32).toString("base64url"),
            };
            return retryExactOperation("revoke-teacher", payload).then((result) => {
                teacherSessionGeneration = 2;
                return result;
            });
        },
        revokeStudent(binding, actorValue) {
            if (!teacherActor) fail("Disposable teacher binding is unavailable");
            const payload = {
                binding,
                actor: actorValue,
                actorId: actorValue.id,
                teacher: teacherActor,
                teacherSessionGeneration,
                disposableRunId: teacherActor.id,
                revocationNonce: randomBytes(32).toString("base64url"),
            };
            return retryExactOperation("revoke-student", payload);
        },
        async dispose() { /* no copied runner bytes or persistent process to dispose */ },
    });
}

async function readBoundedStdin() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.byteLength;
        if (bytes > MAX_INPUT_BYTES) fail("Restore smoke input exceeded its bound");
        chunks.push(chunk);
    }
    return parseStrictJson(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function main() {
    try {
        const operationArg = process.argv.slice(2);
        if (operationArg.length !== 1 || !operationArg[0].startsWith("--operation=")) fail();
        const operation = operationArg[0].slice("--operation=".length);
        const config = resolveRepositoryRestoreSmokeConfig({ env: process.env });
        const request = await readBoundedStdin();
        if (request.operation !== operation) fail();
        const result = await executeRepositoryRestoreSmokeOperation(config, request);
        const line = `${JSON.stringify(result)}\n`;
        if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_BYTES) fail();
        process.stdout.write(line);
    } catch {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "repository_restore_smoke_not_verified" })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
