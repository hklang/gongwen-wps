#!/usr/bin/env python3
"""pdf -> md：优先 pdfplumber 抽文本；扫描件/无字 PDF 会得到空或很少文字。"""
from __future__ import annotations

import os
import sys


def convert(src: str, dst: str) -> None:
    try:
        import pdfplumber
    except ImportError as e:
        raise RuntimeError(
            "未安装 pdfplumber。请执行: pip install pdfplumber"
        ) from e

    pages: list[str] = []
    with pdfplumber.open(src) as pdf:
        for i, page in enumerate(pdf.pages):
            text = (page.extract_text() or "").strip()
            if not text:
                continue
            pages.append("## 第%d页\n\n%s" % (i + 1, text))
    if not pages:
        raise RuntimeError(
            "未能从 PDF 抽出文字（可能是扫描件，需 OCR，第一期不支持）"
        )
    body = "\n\n".join(pages) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法: python pdf2md.py input.pdf [output.md]", file=sys.stderr)
        return 2
    src = os.path.abspath(argv[1])
    if not os.path.isfile(src):
        print("文件不存在: " + src, file=sys.stderr)
        return 1
    if len(argv) >= 3:
        dst = os.path.abspath(argv[2])
    else:
        dst = os.path.splitext(src)[0] + ".md"
    try:
        convert(src, dst)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    print(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
