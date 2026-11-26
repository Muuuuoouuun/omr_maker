import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { continueSolveEntryIfPresent } from "./helpers";

// Plan A2: phone and tablet solve geometry. Viewports are set per test, so the
// spec runs on the desktop Chromium project (and WebKit where enabled).

const EXAM_ID = "solve-mobile-layout-exam";
const STUDENT_ID = "solve-mobile-layout-class::student-1";
const SAMPLE_PDF_DATA_URL = `data:application/pdf;base64,${readFileSync(
    path.join(process.cwd(), "e2e/fixtures/sample-problem-2pages.pdf"),
).toString("base64")}`;

async function seedSolveExam(page: Page) {
    await page.addInitScript(({ examId, pdfData, studentId }) => {
        if (window.sessionStorage.getItem("solve-mobile-layout-seeded") === "1") return;
        try { window.localStorage.clear(); } catch {}
        const session = {
            createdAt: "2026-10-01T00:00:00.000Z",
            groupId: "solve-mobile-layout-class",
            groupName: "레이아웃반",
            identityType: "temporary",
            isGuest: false,
            loginId: studentId,
            name: "레이아웃학생",
            studentId,
        };
        const exam = {
            id: examId,
            title: "폰과 태블릿에서 문제지와 답안지를 함께 보는 국어 평가",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            durationMin: 35,
            pdfData,
            accessConfig: { type: "public", groupIds: [] },
            questions: Array.from({ length: 12 }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: (index % 5) + 1,
                choices: 5,
                score: 5,
                label: `문항 ${index + 1}`,
                pdfLocation: { page: 1, x: 0.15 + (index % 4) * 0.2, y: 0.2 + Math.floor(index / 4) * 0.2 },
            })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("solve-mobile-layout-seeded", "1");
    }, { examId: EXAM_ID, pdfData: SAMPLE_PDF_DATA_URL, studentId: STUDENT_ID });
}

async function openSolve(page: Page, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    await seedSolveExam(page);
    await page.goto(`/solve/${EXAM_ID}`);
    await continueSolveEntryIfPresent(page);
    await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".react-pdf__Page__canvas")).toBeVisible({ timeout: 30_000 });
}

async function box(page: Page, selector: string) {
    const rect = await page.locator(selector).first().boundingBox();
    expect(rect, `${selector} should have a layout box`).not.toBeNull();
    return rect!;
}

test.describe("solve layout on phones", () => {
    for (const { width, height, minScrollHeight } of [
        { width: 320, height: 568, minScrollHeight: 140 },
        { width: 393, height: 727, minScrollHeight: Math.ceil(727 * 0.3) },
        { width: 393, height: 852, minScrollHeight: Math.ceil(852 * 0.3) },
    ]) {
        test(`${width}x${height} keeps a readable PDF above the expanded answer sheet`, async ({ page }) => {
            await openSolve(page, { width, height });

            // PO decision A-4: the sheet stays expanded on first phone entry.
            const pane = page.locator("#solve-omr-pane");
            await expect(pane).not.toHaveClass(/is-collapsed/);

            await expect.poll(async () => (await box(page, ".pdf-viewer-scroll")).height)
                .toBeGreaterThanOrEqual(minScrollHeight);

            const toolbar = await box(page, ".pdf-viewer-toolbar");
            expect(toolbar.height).toBeLessThanOrEqual(60);
            await expect(page.locator(".pdf-viewer-file")).toBeHidden();
            await expect(page.locator(".pdf-viewer-bottom-toolbar")).toBeHidden();
            await expect(page.locator(".pdf-viewer-controls input[type='text']")).toBeVisible();
            await expect(page.getByRole("button", { name: /^필기 도구/ })).toBeVisible();

            const pdf = await box(page, ".solve-pdf-pane");
            const omr = await box(page, "#solve-omr-pane");
            expect(omr.y).toBeGreaterThanOrEqual(pdf.y + pdf.height - 2);
            expect(omr.width).toBeGreaterThanOrEqual(width - 2);
            expect(omr.height).toBeGreaterThanOrEqual(160);
            expect(omr.y + omr.height).toBeLessThanOrEqual(height + 1);
        });
    }

    for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 727 }]) {
        test(`${viewport.width}x${viewport.height} drawing tools open over the page without resizing it`, async ({ page }) => {
            await openSolve(page, viewport);
            const scroll = page.locator(".pdf-viewer-scroll");
            const before = await scroll.boundingBox();

            const toggle = page.getByRole("button", { name: /^필기 도구/ });
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(page.getByRole("toolbar", { name: "PDF 필기 도구" })).toHaveCount(0);
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            const popover = page.locator(".pdf-viewer-drawing-popover");
            await expect(popover).toBeVisible();
            await expect(popover.getByRole("toolbar", { name: "PDF 필기 도구" })).toBeVisible();

            const after = await scroll.boundingBox();
            expect(after?.height).toBe(before?.height);
            expect(after?.y).toBe(before?.y);

            const pane = await box(page, ".solve-pdf-pane");
            const popoverBox = await box(page, ".pdf-viewer-drawing-popover");
            expect(popoverBox.x).toBeGreaterThanOrEqual(pane.x - 1);
            expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
            expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(pane.y + pane.height + 1);

            await popover.getByLabel("펜", { exact: true }).click();
            await expect(toggle).toHaveAccessibleName("필기 도구 · 펜");
            expect((await scroll.boundingBox())?.height).toBe(before?.height);

            await page.keyboard.press("Escape");
            await expect(popover).toHaveCount(0);
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(toggle).toBeFocused();
        });
    }

    for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 727 }]) {
        test(`${viewport.width}x${viewport.height} collapsed sheet leaves a bottom dock that still marks answers`, async ({ page }) => {
            await openSolve(page, viewport);
            const expandedScroll = await box(page, ".pdf-viewer-scroll");

            await page.locator(".solve-controls").getByRole("button", { name: "답안지 접기" }).click();
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);

            const dock = page.locator(".solve-omr-rail");
            await expect(dock).toBeVisible();
            const dockBox = await box(page, ".solve-omr-rail");
            const pdf = await box(page, ".solve-pdf-pane");
            expect(dockBox.height).toBeGreaterThanOrEqual(50);
            expect(dockBox.height).toBeLessThanOrEqual(64);
            expect(dockBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
            expect(dockBox.y).toBeGreaterThanOrEqual(pdf.y + pdf.height - 2);
            expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(viewport.height + 1);
            await expect.poll(async () => (await box(page, ".pdf-viewer-scroll")).height)
                .toBeGreaterThan(expandedScroll.height);

            const bubble = dock.getByRole("button", { name: "1번 보기 3", exact: true });
            const bubbleBox = await bubble.boundingBox();
            expect(bubbleBox?.x ?? -1).toBeGreaterThanOrEqual(0);
            expect((bubbleBox?.x ?? 0) + (bubbleBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
            expect(bubbleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            await bubble.click();
            await expect(bubble).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator(".solve-progress")).toContainText("1/12");

            await page.locator(".solve-controls").getByRole("button", { name: "답안지 펼치기" }).click();
            await expect(page.locator("#solve-omr-pane")).not.toHaveClass(/is-collapsed/);
            await expect(dock).toBeHidden();
            await expect(page.getByRole("radio", { name: "문제 1번 보기 3", exact: true })).toBeChecked();
        });
    }
});

test.describe("solve layout on tablets", () => {
    for (const viewport of [
        { width: 1180, height: 820 },
        { width: 1024, height: 768 },
        { width: 1194, height: 834 },
    ]) {
        test(`${viewport.width}x${viewport.height} keeps the page and pen toolbar in view with the sheet collapsed`, async ({ page }) => {
            await openSolve(page, viewport);
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);

            await page.getByLabel("펜", { exact: true }).click();
            await expect(page.getByRole("group", { name: "펜 옵션" })).toBeVisible();

            const expectInView = async () => {
                const pane = await box(page, ".solve-pdf-pane");
                const header = await box(page, ".solve-header");
                const pdfPage = await box(page, ".react-pdf__Page");
                // The body must not be scrolled sideways or grown past the
                // viewport (that shifted the page left / pushed the header up).
                expect(pane.x).toBeGreaterThanOrEqual(-1);
                expect(pane.x + pane.width).toBeLessThanOrEqual(viewport.width + 1);
                expect(pane.y + pane.height).toBeLessThanOrEqual(viewport.height + 1);
                expect(header.y).toBeGreaterThanOrEqual(-1);
                expect(pdfPage.x).toBeGreaterThanOrEqual(pane.x - 1);

                const toolbar = await box(page, ".pdf-viewer-toolbar");
                for (const control of [
                    page.getByRole("button", { name: "확대" }),
                    page.getByRole("button", { name: "이 페이지의 모든 필기 삭제" }),
                    page.getByRole("button", { name: "필압 끄기" }),
                ]) {
                    const controlBox = await control.boundingBox();
                    expect(controlBox).not.toBeNull();
                    expect(controlBox!.x).toBeGreaterThanOrEqual(toolbar.x - 1);
                    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(Math.min(viewport.width, toolbar.x + toolbar.width) + 1);
                }
            };
            await expectInView();

            // Selecting a question scrolls the sheet's card into view; that
            // must not scroll the clipped solve body or page instead.
            await page.locator(".solve-controls").getByRole("button", { name: "답안지 펼치기" }).click();
            await expect(page.locator("#solve-omr-pane")).not.toHaveClass(/is-collapsed/);
            await page.getByRole("radio", { name: "문제 9번 보기 2", exact: true }).click();
            await page.locator(".solve-controls").getByRole("button", { name: "답안지 접기" }).click();
            await expect(page.locator("#solve-omr-pane")).toHaveClass(/is-collapsed/);
            await page.waitForTimeout(400);
            await expectInView();
        });
    }
});

test.describe("solve layout with the answer sheet open", () => {
    for (const viewport of [
        { width: 834, height: 1194 },
        { width: 1194, height: 834 },
        { width: 1440, height: 900 },
    ]) {
        test(`${viewport.width}x${viewport.height} keeps the PDF page/zoom controls and the sheet header usable`, async ({ page }) => {
            await openSolve(page, viewport);
            const pane = page.locator("#solve-omr-pane");
            if (await pane.evaluate(element => element.classList.contains("is-collapsed"))) {
                await page.locator(".solve-controls").getByRole("button", { name: "답안지 펼치기" }).click();
            }
            await expect(pane).not.toHaveClass(/is-collapsed/);
            await page.waitForTimeout(400);

            // The open sheet floats over the PDF pane's top-right corner, where
            // the toolbar keeps page and zoom controls: they stay on top of it.
            const expectControlsClear = async () => {
                for (const name of ["이전 페이지", "다음 페이지", "축소", "확대"]) {
                    const control = page.getByRole("button", { name, exact: true });
                    await expect(control).toBeVisible();
                    const reachable = await control.evaluate(element => {
                        const rect = element.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        return Boolean(hit && element.contains(hit));
                    });
                    expect(reachable, `${name} must not sit under the open answer sheet`).toBe(true);
                }
            };
            await expectControlsClear();

            // Marking scrolls each card into view; that must scroll the sheet's
            // list, not the clipped sheet itself, or its header slides out.
            for (let question = 1; question <= 7; question += 1) {
                await page.getByRole("radio", { name: `문제 ${question}번 보기 ${((question - 1) % 5) + 1}`, exact: true }).click();
            }
            await page.waitForTimeout(600);
            const paneBox = await box(page, "#solve-omr-pane");
            const headerBox = await box(page, "#solve-omr-pane .solve-omr-pane-header");
            expect(headerBox.y).toBeGreaterThanOrEqual(paneBox.y - 1);
            expect(await pane.evaluate(element => element.scrollTop)).toBe(0);
            await expectControlsClear();
        });
    }
});

test("drawing accepts one pointer and cancellation leaves no mark", async ({ page }) => {
    await openSolve(page, {width: 1100, height: 800});
    const canvas = page.getByTestId("pdf-draw-overlay");
    await expect(canvas).toHaveAttribute("data-pdf-ready", "true");
    await page.getByRole("button", {name: "펜", exact: true}).click();
    const point = {x: .21, y: .15};
    const stroke = async (action: "cancel" | "up") => {
        const rect = (await canvas.boundingBox())!;
        const x = rect.x + rect.width * point.x, y = rect.y + rect.height * point.y;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 48, y + 14, {steps: 10});
        if (action === "cancel") {
            await canvas.dispatchEvent("pointercancel", {pointerId: 1, pointerType: "mouse", bubbles: true});
        }
        await page.mouse.up();
    };
    const alpha = () => canvas.evaluate((node, p) => {
        const c = node as HTMLCanvasElement;
        return c.getContext("2d")!.getImageData(Math.round(c.width * p.x), Math.round(c.height * p.y),1,1).data[3];
    }, point);
    await stroke("cancel");
    expect(await alpha()).toBe(0);
    await stroke("up");
    await expect.poll(alpha).toBeGreaterThan(0);
    await page.getByRole("button", {name:"실행 취소", exact:true}).click();
    await expect.poll(alpha).toBe(0);
    await page.getByRole("button", {name:"다시 실행", exact:true}).click();
    await expect.poll(alpha).toBeGreaterThan(0);
    await page.getByRole("button", {name:"지우개", exact:true}).click();
    await stroke("cancel");
    await expect.poll(alpha).toBeGreaterThan(0);
    await stroke("up");
    await expect.poll(alpha).toBe(0);
    await page.getByRole("button", {name:"실행 취소", exact:true}).click();
    await expect.poll(alpha).toBeGreaterThan(0);
});
test("PDF zoom retains the panned viewport anchor and handwriting geometry", async ({page}) => {
    await openSolve(page,{width:1100,height:760});
    const overlay = page.getByTestId("pdf-draw-overlay");
    const pane = page.locator(".pdf-viewer-scroll");
    const plus = page.getByRole("button",{name:"확대",exact:true});
    for (let i=0;i<6;i++) await plus.click();
    await expect(overlay).toHaveAttribute("data-pdf-ready", "true");
    const frame = await pane.boundingBox();
    expect(frame?.height).toBeGreaterThan(100);
    await pane.evaluate(el=>{el.scrollTop=240; el.scrollLeft=120});
    const anchor = () => pane.evaluate(el=>{
        const view=el.getBoundingClientRect();
        const doc=el.querySelector('[data-testid="pdf-draw-overlay"]')!.getBoundingClientRect();
        return {x:(view.left+el.clientWidth/2-doc.left)/doc.width,
            y:(view.top+el.clientHeight/2-doc.top)/doc.height};
    });
    const before=await anchor();
    await plus.click();
    await expect(overlay).toHaveAttribute("data-pdf-ready", "true");
    const after=await anchor();
    console.log("view anchor normalized", JSON.stringify({before,after}));
    expect(Math.abs(after.x-before.x)).toBeLessThan(.012);
    expect(Math.abs(after.y-before.y)).toBeLessThan(.012);
});


test("300% maximum; independent writing-zone zoom and return preserve full-page coordinates", async ({page})=>{
    await openSolve(page,{width:1100,height:800});
    const ink=page.getByTestId("pdf-draw-overlay");
    const pane=page.locator(".pdf-viewer-scroll");
    const plus=page.getByRole("button",{name:"확대",exact:true});
    const minus=page.getByRole("button",{name:"축소",exact:true});
    const percent=page.locator(".pdf-zoom-value");
    const center=async(x:number,y:number)=>{
        const bounds=(await ink.boundingBox())!;
        const view=(await pane.boundingBox())!;
        await pane.evaluate((el,d)=>{el.scrollLeft+=d.x;el.scrollTop+=d.y},{x:bounds.x+x*bounds.width-view.x-view.width/2,y:bounds.y+y*bounds.height-view.y-view.height/2});
    };
    const pos=async(x:number,y:number)=>{
        const r=(await ink.boundingBox())!;
        return {x:r.x+x*r.width,y:r.y+y*r.height};
    };
    const sample=async(x:number,y:number)=>ink.evaluate((raw,p)=>{
        const c=raw as HTMLCanvasElement;
        return c.getContext("2d")!.getImageData(Math.round(c.width*p.x),Math.round(c.height*p.y),1,1).data[3];
    },{x,y});
    for(let i=0;i<21;i++) await plus.click();
    await expect(percent).toHaveText("300%");
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    for(let i=0;i<20;i++) await minus.click();
    await expect(percent).toHaveText("100%");
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    await center(.45,.24);
    await page.getByRole("button",{name:"필기 구역 지정",exact:true}).click();
    await center(.45,.24);
    const begin=await pos(.32,.18),end=await pos(.57,.30);
    await page.mouse.move(begin.x,begin.y);
    await page.mouse.down();
    await page.mouse.move(end.x,end.y,{steps:5});
    await page.mouse.up();
    const region=page.getByTestId("pdf-writing-zone");
    await expect(region).toBeVisible();
    const savedZone=await region.getAttribute("data-zone");
    await expect(percent).toHaveText("100%");
    for(let i=0;i<4;i++) await page.getByRole("button",{name:"구역 확대",exact:true}).click();
    await expect(page.getByRole("group",{name:"필기 구역"}).getByRole("status")).toHaveText("구역 240%");
    for(let i=0;i<3;i++) await page.getByRole("button",{name:"구역 확대",exact:true}).click();
    await expect(page.getByRole("group",{name:"필기 구역"}).getByRole("status")).toHaveText("구역 300%");
    await expect(page.getByRole("button",{name:"구역 확대",exact:true})).toBeDisabled();
    for(let i=0;i<3;i++) await page.getByRole("button",{name:"구역 축소",exact:true}).click();
    await expect(region).toHaveAttribute("data-zone",savedZone!);
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    await center(.44,.24);
    const draw=await pos(.44,.24);
    await page.mouse.move(draw.x,draw.y);
    await page.mouse.down();
    await page.mouse.move(draw.x+42,draw.y+22,{steps:11});
    await page.mouse.up();
    await expect.poll(()=>sample(.44,.24)).toBeGreaterThan(0);
    const hitTarget = await page.getByRole("button",{name:"구역 확대",exact:true}).boundingBox();
    expect(hitTarget?.width).toBeGreaterThanOrEqual(44);
    expect(hitTarget?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({path:test.info().outputPath("student-zone-evidence.png")});
    const outside=await pos(.30,.24);
    await page.mouse.click(outside.x,outside.y);
    expect(await sample(.30,.24)).toBe(0);
    await page.getByRole("button",{name:"구역 닫기"}).click();
    await expect(region).toHaveCount(0);
    await expect(percent).toHaveText("100%");
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    await expect.poll(()=>sample(.44,.24)).toBeGreaterThan(0);
    await page.waitForFunction(()=>Object.keys(localStorage).some(key=>{
        try {
            const d=JSON.parse(localStorage.getItem(key)??"null");
            return d&&typeof d==="object"&&d.drawingsRef;
        } catch {
            return false;
        }
    }));
    await page.getByRole("button",{name:"다음 페이지",exact:true}).click();
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    expect(await sample(.44,.24)).toBe(0);
    await page.getByRole("button",{name:"이전 페이지",exact:true}).click();
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    await expect.poll(()=>sample(.44,.24)).toBeGreaterThan(0);
    await page.reload();
    await continueSolveEntryIfPresent(page);
    await expect(ink).toHaveAttribute("data-pdf-ready","true",{timeout:15_000});
    await expect.poll(()=>sample(.44,.24)).toBeGreaterThan(0);
});

test("coalesces a burst of pointer input to one live-canvas paint and preserves the drawing", async ({page})=>{
    await openSolve(page,{width:1100,height:800});
    const ink=page.getByTestId("pdf-draw-overlay");
    await expect(ink).toHaveAttribute("data-pdf-ready","true");
    await page.getByRole("button",{name:"펜",exact:true}).click();
    const r=(await ink.boundingBox())!;
    const x=r.x+.22*r.width,y=r.y+.16*r.height;
    await page.mouse.move(x,y);
    await page.mouse.down();
    const count=await ink.evaluate(async(el,pt)=>{
        const contextType=CanvasRenderingContext2D.prototype;
        const before=contextType.clearRect;
        let paints=0;
        contextType.clearRect=function(...args:Parameters<typeof before>){
            if(this.canvas.dataset.testid==="pdf-draw-live-overlay") paints++;
            return before.apply(this,args);
        };
        try {
            for(let i=1;i<=120;i++) el.dispatchEvent(new PointerEvent("pointermove",{
                bubbles:true,cancelable:true,pointerId:1,pointerType:"mouse",buttons:1,
                clientX:pt.x+i,clientY:pt.y+(i%8),
            }));
            await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
            return paints;
        } finally {contextType.clearRect=before;}
    },{x,y});
    console.log("120-input burst live canvas paints", count);
    expect(count).toBe(1);
    await page.mouse.up();
    await expect(page.getByRole("button",{name:"실행 취소",exact:true})).toBeEnabled();
});
