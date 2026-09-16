/** Render only the teacher-selected range; never silently truncate an uploaded exam. */
export async function renderExamAnalysisPages(file: File, start: number, end: number, isCurrent: () => boolean): Promise<string[]> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 4) {
        throw new Error('한 번에 최대 4쪽까지 분석할 수 있습니다. 페이지 범위를 확인해 주세요.');
    }
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
    try {
        const pdf = await task.promise;
        if (end > pdf.numPages) throw new Error(`이 PDF는 ${pdf.numPages}쪽입니다. 분석 범위를 수정해 주세요.`);
        const images: string[] = [];
        for (let index = start; index <= end; index++) {
            if (!isCurrent()) throw new Error('분석이 취소되었습니다.');
            const page = await pdf.getPage(index);
            const original = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: 1600 / Math.max(original.width, original.height) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            try {
                const canvasContext = canvas.getContext('2d');
                if (!canvasContext) throw new Error('PDF 이미지를 준비하지 못했습니다.');
                await page.render({ canvas, canvasContext, viewport }).promise;
                images.push(canvas.toDataURL('image/jpeg', 0.78));
                if (images.reduce((sum, image) => sum + image.length, 0) > 8_000_000) {
                    throw new Error('분석 이미지가 너무 큽니다. 페이지 범위를 줄여 주세요.');
                }
            } finally {
                page.cleanup();
                canvas.width = 0;
                canvas.height = 0;
            }
        }
        return images;
    } finally {
        await task.destroy();
    }
}
