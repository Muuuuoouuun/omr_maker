// Regenerates the images used by /intro.
//
// solve  src/app/intro/_assets/solve-tablet.webp
//   1. Prints scripts/intro-images/sample-exam.html to a two-page exam PDF.
//   2. Opens that exam in the student solve screen of a running app, marks the
//      first six answers on the OMR sheet, circles answers on the problem sheet
//      with the pen, and waits for the autosave.
//   3. Writes a tablet-landscape capture as an optimized WebP.
//   Only the student side is captured: teacher screens in the demo account
//   carry demo-data banners, so /intro draws those surfaces as coded vignettes.
//
// share  src/app/intro/opengraph-image.png (1200x630, alt text beside it)
//   Lays the page's own headline next to its hero visual on top of a running
//   /intro, so the card uses the app's tokens and fonts as they ship.
//
// Usage: start the app (`npm run dev`), then `npm run intro:images` for both,
// or `npm run intro:images -- share` for one. INTRO_IMAGE_BASE_URL overrides
// http://localhost:3003. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an
// already-installed Chromium.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const baseURL = (process.env.INTRO_IMAGE_BASE_URL || "http://localhost:3003").replace(/\/$/, "");
const rootDir = process.cwd();
const templatePath = path.join(rootDir, "scripts/intro-images/sample-exam.html");
const outputDir = path.join(rootDir, "src/app/intro/_assets");
const shareImagePath = path.join(rootDir, "src/app/intro/opengraph-image.png");

const EXAM_ID = "intro-sample-exam";
// Must match the answer key comment in sample-exam.html.
const ANSWER_KEY = [4, 4, 2, 2, 3, 3, 4, 2, 1, 3, 2, 4, 3, 3, 5, 2, 3, 1, 3, 5];
const MARKED_QUESTIONS = 6;

async function printExamPdf(browser) {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(templatePath).href);
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    await page.close();
    return pdf;
}

async function seedSolveExam(context, pdf) {
    await context.addInitScript(({ examId, answerKey, pdfData }) => {
        if (window.sessionStorage.getItem("intro-images-seeded") === "1") return;
        try { window.localStorage.clear(); } catch {}
        const session = {
            createdAt: "2026-10-01T00:00:00.000Z",
            groupId: "intro-class-2-1",
            groupName: "2학년 1반",
            identityType: "temporary",
            isGuest: false,
            loginId: "intro-student",
            name: "김민준",
            studentId: "intro-student",
        };
        const exam = {
            id: examId,
            title: "2학년 수학 단원평가",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            durationMin: 50,
            pdfData,
            accessConfig: { type: "public", groupIds: [] },
            questions: answerKey.map((answer, index) => ({
                id: index + 1,
                number: index + 1,
                answer,
                choices: 5,
                score: 5,
            })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("intro-images-seeded", "1");
    }, {
        examId: EXAM_ID,
        answerKey: ANSWER_KEY,
        pdfData: `data:application/pdf;base64,${pdf.toString("base64")}`,
    });
}

async function settle(locator) {
    await locator.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
}

/** Bounding box of the nth text-layer span on the visible PDF page that reads `text`. */
async function textBox(page, text, occurrence = 0) {
    const spans = page.locator(".react-pdf__Page__textContent span", { hasText: text });
    await spans.nth(occurrence).waitFor();
    const box = await spans.nth(occurrence).boundingBox();
    if (!box) throw new Error(`No layout box for "${text}"`);
    return box;
}

async function stroke(page, points) {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.up();
}

/** A slightly uneven hand-drawn loop around a box. */
function loopAround(box, pad = 7) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = box.width / 2 + pad;
    const ry = box.height / 2 + pad * 0.7;
    return Array.from({ length: 34 }, (_, index) => {
        const angle = -Math.PI * 0.6 + (index / 30) * Math.PI * 2;
        const wobble = 1 + Math.sin(index * 1.7) * 0.05;
        return { x: cx + Math.cos(angle) * rx * wobble, y: cy + Math.sin(angle) * ry * wobble };
    });
}


async function captureSolveTablet(browser, pdf) {
    const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2 });
    await seedSolveExam(context, pdf);
    const page = await context.newPage();
    await page.goto(`${baseURL}/solve/${EXAM_ID}`);

    const entryDialog = page.getByRole("dialog", { name: "시험 입장 확인" });
    await entryDialog.or(page.locator(".solve-body")).first().waitFor({ timeout: 60_000 });
    if (await entryDialog.isVisible()) {
        await entryDialog.getByRole("button", { name: "학생으로 시험 보기" }).click();
        await entryDialog.waitFor({ state: "hidden" });
    }
    await page.locator(".react-pdf__Page__canvas").first().waitFor({ timeout: 60_000 });

    const rail = page.locator(".solve-omr-rail-button");
    if (await rail.isVisible().catch(() => false)) await rail.click();
    const omrPane = page.locator("#solve-omr-pane");
    await settle(omrPane);
    for (let question = 1; question <= MARKED_QUESTIONS; question += 1) {
        await page.getByRole("radio", { name: `문제 ${question}번 보기 ${ANSWER_KEY[question - 1]}` }).click();
    }

    // Circle the chosen answers of questions 1 and 3, the two that are on screen
    // in this viewport. Italic variables split choices like "③ x=3" across
    // text-layer spans, so only plain choices are targeted.
    await page.getByRole("button", { name: "펜", exact: true }).click();
    await stroke(page, loopAround(await textBox(page, "④ 2", 0)));
    await stroke(page, loopAround(await textBox(page, "② 2", 0)));
    await page.getByRole("button", { name: "선택", exact: true }).click();

    // The answer sheet autosaves every 3 seconds; capture after it settles.
    await page.waitForTimeout(4_000);
    await settle(page.locator("body"));
    await page.mouse.move(0, 0);
    const png = await page.screenshot();
    await context.close();
    return png;
}

const SHARE_CARD_CSS = `
.intro-share-card,
.intro-share-card * {
  animation: none !important;
  transition: none !important;
}

.intro-share-card {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  grid-template-columns: 500px minmax(0, 1fr);
  align-items: center;
  gap: 28px;
  padding: 0 40px 0 76px;
  overflow: hidden;
  color: var(--foreground);
  background:
    radial-gradient(55% 70% at 84% 24%, color-mix(in srgb, var(--primary) 15%, transparent), transparent 72%),
    radial-gradient(45% 60% at 4% 100%, color-mix(in srgb, var(--secondary) 8%, transparent), transparent 70%),
    var(--background);
}

.intro-share-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 30px;
  font-weight: 850;
}

.intro-share-brand img {
  width: 54px;
  height: 54px;
}

.intro-share-title {
  margin: 40px 0 0;
  font-size: 62px;
  font-weight: 850;
  line-height: 1.24;
  letter-spacing: -0.01em;
}

.intro-share-title em {
  font-style: normal;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.intro-share-tagline {
  margin: 28px 0 0;
  color: var(--muted);
  font-size: 25px;
  font-weight: 700;
}

.intro-share-visual > * {
  min-height: 0;
}
`;

async function captureShareImage(browser) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2, colorScheme: "light" });
    await context.addInitScript(() => {
        try { window.localStorage.setItem("omr_theme", "light"); } catch {}
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}/intro`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: SHARE_CARD_CSS });
    // Copy is the page's own: the hero eyebrow and h1. The visual is the hero
    // illustration itself (the first role="img" on the page).
    await page.evaluate(() => {
        const hero = document.querySelector('#main-content [role="img"]');
        if (!hero) throw new Error("No hero visual on /intro");
        const card = document.createElement("div");
        card.className = "intro-share-card";
        card.innerHTML = `
            <div>
                <p class="intro-share-brand"><img src="/logo.png" alt="">OMR Maker</p>
                <h1 class="intro-share-title">시험이 끝나면,<br><em>선생님의 시험</em>이<br>시작됩니다</h1>
                <p class="intro-share-tagline">선생님을 위한 온라인 OMR 시험 플랫폼</p>
            </div>
            <div class="intro-share-visual"></div>`;
        card.querySelector(".intro-share-visual").append(hero.cloneNode(true));
        document.body.append(card);
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".intro-share-card img"))
        .every(image => image.complete && image.naturalWidth > 0));
    const png = await page.screenshot();
    await context.close();
    return png;
}

const STEPS = {
    async solve(browser) {
        await mkdir(outputDir, { recursive: true });
        const pdf = await printExamPdf(browser);
        const solve = await captureSolveTablet(browser, pdf);
        const target = path.join(outputDir, "solve-tablet.webp");
        await writeFile(target, await sharp(solve).resize({ width: 1600 }).webp({ quality: 84 }).toBuffer());
        return target;
    },
    async share(browser) {
        const share = await captureShareImage(browser);
        // Rendered at 2x and downsampled for clean text edges at the 1200x630 OG size.
        await writeFile(shareImagePath, await sharp(share).resize({ width: 1200, height: 630 }).png({ compressionLevel: 9 }).toBuffer());
        return shareImagePath;
    },
};

async function main() {
    const requested = process.argv.slice(2);
    const unknown = requested.filter(name => !(name in STEPS));
    if (unknown.length) throw new Error(`Unknown step(s): ${unknown.join(", ")}. Use: ${Object.keys(STEPS).join(", ")}`);
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {});
    try {
        for (const name of requested.length ? requested : Object.keys(STEPS)) {
            const target = await STEPS[name](browser);
            console.log(`wrote ${path.relative(rootDir, target)}`);
        }
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
