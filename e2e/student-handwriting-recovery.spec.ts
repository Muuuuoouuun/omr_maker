import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ATTEMPT_ID = "attempt-handwriting-recovery-qa";
const EXAM_ID = "exam-handwriting-recovery-qa";
const STUDENT_ID = "student-handwriting-recovery-qa";
const ORGANIZATION_ID = "default";
const OWNER_FINGERPRINT = "f037ad5688fd05bbbdad55fe7ca9416919de710f2f2f74ac968dd2db71c0c47d";
const MANIFEST_KEY = `omr_handwriting_upload_recovery:${ATTEMPT_ID}`;
const SOURCE_KEY = `attempt:${ATTEMPT_ID}:handwriting-upload-source`;

test("restores and retries a private handwriting upload on phone and tablet", async ({ page }) => {
    test.info().annotations.push({ type: "release-proof", description: "student_core_handwriting_recovery" });
    const consoleErrors: string[] = [];
    page.on("console", message => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", error => consoleErrors.push(error.message));

    await page.goto("/");
    await page.evaluate(async ({ attemptId, examId, studentId, organizationId, ownerFingerprint, manifestKey, sourceKey }) => {
        const now = new Date();
        const session = {
            studentId,
            name: "모바일 QA 학생",
            groupId: "group-qa",
            groupName: "QA 반",
            isGuest: false,
            identityType: "temporary",
            createdAt: now.toISOString(),
        };
        const exam = {
            id: examId,
            organizationId,
            createdByUserId: "admin",
            title: "필기 복구 모바일 QA",
            createdAt: now.toISOString(),
            durationMin: 45,
            accessConfig: { type: "public", groupIds: [] },
            questions: [{ id: 1, number: 1, label: "1", score: 10, answer: 2 }],
        };
        const attempt = {
            id: attemptId,
            organizationId,
            examId,
            examTitle: exam.title,
            studentName: session.name,
            studentId,
            groupId: session.groupId,
            groupName: session.groupName,
            identityType: "temporary",
            startedAt: new Date(now.getTime() - 20 * 60 * 1_000).toISOString(),
            finishedAt: now.toISOString(),
            score: 10,
            totalScore: 10,
            answers: { 1: 2 },
            status: "completed",
            handwritingArchived: false,
            handwritingPlan: "pro",
        };
        const drawings = { 1: [JSON.stringify({ color: "#ef4444", points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.35 }] })] };
        const serializedDrawings = JSON.stringify(drawings);
        const updatedAt = now.toISOString();
        const encoded = btoa(unescape(encodeURIComponent(serializedDrawings)));
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("omr-maker", 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains("dataUrls")) {
                    request.result.createObjectStore("dataUrls", { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction("dataUrls", "readwrite");
            transaction.objectStore("dataUrls").put({
                key: sourceKey,
                dataUrl: `data:application/json;base64,${encoded}`,
                mimeType: "application/json",
                size: serializedDrawings.length,
                updatedAt,
            });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
        localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        localStorage.setItem(manifestKey, JSON.stringify({
            version: 1,
            attemptId,
            sessionId: "session-handwriting-recovery-qa",
            ownerFingerprint,
            sourceRef: {
                store: "indexeddb",
                key: sourceKey,
                mimeType: "application/json",
                size: new Blob([serializedDrawings]).size,
                updatedAt,
            },
            createdAt: updatedAt,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
            retryCount: 0,
            nextRetryAt: null,
            failureCategory: null,
        }));
    }, {
        attemptId: ATTEMPT_ID,
        examId: EXAM_ID,
        studentId: STUDENT_ID,
        organizationId: ORGANIZATION_ID,
        ownerFingerprint: OWNER_FINGERPRINT,
        manifestKey: MANIFEST_KEY,
        sourceKey: SOURCE_KEY,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/student/review/${ATTEMPT_ID}`);
    const retryButton = page.getByRole("button", { name: "필기 업로드 다시 시도" });
    await expect(retryButton).toBeVisible();
    await page.waitForTimeout(800);
    const phoneBox = await retryButton.boundingBox();
    expect(phoneBox?.height).toBeGreaterThanOrEqual(44);
    expect(phoneBox?.x).toBeGreaterThanOrEqual(0);
    expect((phoneBox?.x || 0) + (phoneBox?.width || 0)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(tmpdir(), "omr-handwriting-recovery-phone.png"), fullPage: false });

    await page.route("**/*", async route => {
        if (route.request().method() === "POST") await new Promise(resolve => setTimeout(resolve, 350));
        await route.continue();
    });
    await retryButton.click();
    await expect(page.getByText("필기 업로드 중")).toBeVisible();
    await expect(page.getByRole("button", { name: "처리 중…" })).toBeDisabled();
    await expect(page.getByText("필기 업로드 실패")).toBeVisible({ timeout: 12_000 });

    const retained = await page.evaluate(async ({ manifestKey, sourceKey }) => {
        const rawManifest = localStorage.getItem(manifestKey);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("omr-maker", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const record = await new Promise<unknown>((resolve, reject) => {
            const transaction = database.transaction("dataUrls", "readonly");
            const request = transaction.objectStore("dataUrls").get(sourceKey);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        database.close();
        return { rawManifest, hasSource: !!record };
    }, { manifestKey: MANIFEST_KEY, sourceKey: SOURCE_KEY });
    expect(retained.rawManifest).toBeTruthy();
    expect(retained.hasSource).toBe(true);
    expect(retained.rawManifest).not.toMatch(/모바일 QA 학생|student-handwriting-recovery-qa|ticket|points|drawings/);

    await page.evaluate(() => {
        sessionStorage.setItem("omr_student_session", JSON.stringify({
            studentId: "another-student",
            name: "다른 학생",
            isGuest: false,
            identityType: "temporary",
            createdAt: new Date().toISOString(),
        }));
        window.dispatchEvent(new Event("omr:student-session-changed"));
    });
    await expect(page.locator(".student-handwriting-recovery")).toHaveCount(0);

    await page.setViewportSize({ width: 820, height: 1180 });
    await page.evaluate(studentId => {
        sessionStorage.setItem("omr_student_session", JSON.stringify({
            studentId,
            name: "모바일 QA 학생",
            groupId: "group-qa",
            groupName: "QA 반",
            isGuest: false,
            identityType: "temporary",
            createdAt: new Date().toISOString(),
        }));
        window.dispatchEvent(new Event("omr:student-session-changed"));
    }, STUDENT_ID);
    await expect(page.getByText("필기 업로드 실패")).toBeVisible();
    const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.viewport + 1);
    await page.screenshot({ path: join(tmpdir(), "omr-handwriting-recovery-tablet.png"), fullPage: false });

    expect(consoleErrors.filter(message => !message.includes("Failed to fetch"))).toEqual([]);
});
