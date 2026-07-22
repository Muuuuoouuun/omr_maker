#!/usr/bin/env python3
"""Normalize one supplied Korean exam PDF into the selected problem pages."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import tempfile

from pypdf import PdfReader, PdfWriter


def parse_page_indexes(raw: str) -> list[int]:
    try:
        pages = [int(value.strip()) for value in raw.split(",") if value.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError("pages must be comma-separated zero-based integers") from error
    if not pages or any(page < 0 for page in pages):
        raise argparse.ArgumentTypeError("at least one non-negative page index is required")
    if pages != sorted(set(pages)):
        raise argparse.ArgumentTypeError("page indexes must be unique and ascending")
    return pages


def verify_pdf(path: Path, expected_pages: int) -> None:
    if not path.is_file():
        raise RuntimeError(f"output PDF is missing: {path}")
    reader = PdfReader(str(path))
    if len(reader.pages) != expected_pages:
        raise RuntimeError(
            f"output page count mismatch for {path}: expected {expected_pages}, got {len(reader.pages)}"
        )
    for index, page in enumerate(reader.pages, start=1):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        if width <= 0 or height <= 0:
            raise RuntimeError(f"invalid media box on output page {index}: {width}x{height}")


def normalize(source: Path, output: Path, page_indexes: list[int], temporary_root: Path) -> None:
    if not source.is_file():
        raise RuntimeError(f"source PDF is missing: {source}")
    reader = PdfReader(str(source))
    required_pages = max(page_indexes) + 1
    if len(reader.pages) < required_pages:
        raise RuntimeError(
            f"source has {len(reader.pages)} pages but selection requires at least {required_pages}: {source}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_root.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for page_index in page_indexes:
        writer.add_page(reader.pages[page_index])

    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f"{output.stem}-",
        suffix=".pdf",
        dir=temporary_root,
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    try:
        with temporary_path.open("wb") as stream:
            writer.write(stream)
        verify_pdf(temporary_path, len(page_indexes))
        shutil.copy2(temporary_path, output)
        verify_pdf(output, len(page_indexes))
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pages", required=True, type=parse_page_indexes)
    parser.add_argument("--temporary-root", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    if args.verify:
        verify_pdf(args.output, len(args.pages))
        print(f"verified {args.output}: {len(args.pages)} pages")
        return

    normalize(args.source, args.output, args.pages, args.temporary_root)
    print(f"normalized {args.source} -> {args.output}: {len(args.pages)} pages")


if __name__ == "__main__":
    main()
