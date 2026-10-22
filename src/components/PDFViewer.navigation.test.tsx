// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-pdf", () => ({
  pdfjs: { version: "6.2.108", GlobalWorkerOptions: {} },
  Document: ({ file, onLoadSuccess, children }: { file: File; onLoadSuccess: (result: { numPages: number }) => void; children: React.ReactNode }) => {
    return <div><button onClick={() => onLoadSuccess({ numPages: file.name === "short.pdf" ? 2 : 4 })}>문서 로드</button>{children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => <canvas data-testid="pdf-page" data-page={pageNumber} />,
}));
import PDFViewer from "./PDFViewer";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const file = new File(["pdf"], "long.pdf", { type: "application/pdf" });
const loaded = vi.fn();
function pageInput() { return screen.getByRole("textbox", { name: "페이지 번호" }); }
function loadDocument() { fireEvent.click(screen.getByRole("button", { name: "문서 로드" })); }

describe("PDF viewer navigation", () => {
  it("keeps the input and drawing canvas mounted while navigating and preserves typed input", () => {
    const view = render(<PDFViewer file={file} onLoadSuccess={loaded} enableDrawing />);
    loadDocument();
    const input = pageInput();
    const overlay = screen.getByTestId("pdf-draw-overlay");
    input.focus();
    fireEvent.change(input, { target: { value: "3" } });
    view.rerender(<PDFViewer file={file} onLoadSuccess={loaded} enableDrawing markers={[]} />);
    expect(pageInput()).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("3");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(input).toHaveValue("4");
    expect(screen.getByTestId("pdf-draw-overlay")).toBe(overlay);
  });

  it("applies valid parent navigation, ignores invalid targets, and resets a replacement file", () => {
    const view = render(<PDFViewer file={file} onLoadSuccess={loaded} forcePage={2} />);
    loadDocument();
    expect(pageInput()).toHaveValue("2");
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(pageInput()).toHaveValue("3");
    view.rerender(<PDFViewer file={file} onLoadSuccess={loaded} forcePage={2} focusTarget={{ page: 99, x: 0.5, y: 0.5 }} />);
    expect(pageInput()).toHaveValue("3");
    view.rerender(<PDFViewer file={file} onLoadSuccess={loaded} focusTarget={{ page: 4, x: 0.5, y: 0.5 }} />);
    expect(pageInput()).toHaveValue("4");
    view.rerender(<PDFViewer file={new File(["pdf"], "short.pdf")} onLoadSuccess={loaded} />);
    expect(pageInput()).toHaveValue("1");
  });
});
