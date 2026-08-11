#!/usr/bin/env python3
"""txt -> md：按常见中文编码读入，原样写入 md（保留换行）。"""
from __future__ import annotations

import os
import sys


def read_text(path: str) -> str:
    raw = open(path, "rb").read()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", errors="replace")
    for enc in ("utf-8", "gb18030", "gbk", "cp936", "utf-16", "utf-16-le"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def convert(src: str, dst: str) -> None:
    text = read_text(src).replace("\r\n", "\n").replace("\r", "\n")
    text = text.strip("\n") + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法: python txt2md.py input.txt [output.md]", file=sys.stderr)
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
