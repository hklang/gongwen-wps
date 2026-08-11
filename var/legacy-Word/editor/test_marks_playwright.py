"""Playwright：标记 md ↔ 编辑器显示往返测试。

覆盖：加黑 ** / 下划线 <u> / 红字 / 黑底白字 / 标题 / 右对齐
用法：先启动 python app.py 8765，再 python test_marks_playwright.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("EDITOR_URL", "http://127.0.0.1:8765")

SAMPLE_MD = """# 标记往返测试

## 一、加黑

根据工作分工，**一是xxx。**正文继续。普通**局部加黑**继续。

### （一）下划线与颜色

正文前 <u>下划线词</u> 正文后。

这是<span style="color:red">红色文字</span>示例。

这是<span style="background:#000;color:#fff">黑底白字</span>示例。

混排：<u>**加黑下划线**</u>与<span style="color:red">**红加黑**</span>。

<div align="right">署名测试</div>
"""


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_server() -> None:
    try:
        with urllib.request.urlopen(BASE + "/", timeout=5) as r:
            if r.status != 200:
                raise RuntimeError(f"status {r.status}")
    except Exception as e:
        print(f"FAIL: 编辑器未启动 ({BASE}): {e}")
        print("请先：cd Word/editor && python app.py 8765")
        sys.exit(2)


def assert_true(cond: bool, msg: str, fails: list[str]) -> None:
    if cond:
        print(f"  OK  {msg}")
    else:
        print(f"  FAIL {msg}")
        fails.append(msg)


def main() -> int:
    check_server()
    fails: list[str] = []

    with tempfile.TemporaryDirectory(prefix="marks_pw_") as tmp:
        md_path = os.path.join(tmp, "标记往返测试.md")
        pristine = os.path.join(tmp, "pristine.md")  # 转换器用，避免被编辑器保存覆盖
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(SAMPLE_MD)
        with open(pristine, "w", encoding="utf-8") as f:
            f.write(SAMPLE_MD)

        print("\n=== 1) API 打开 md ===")
        opened = api("POST", "/api/open-path", {"path": md_path})
        assert_true(opened.get("ok") is True or "md" in opened, f"open-path ok: keys={list(opened)}", fails)
        disk_md = opened.get("md") or ""
        assert_true("**一是xxx。**" in disk_md, "打开后 md 含 **加黑**", fails)
        assert_true("<u>下划线词</u>" in disk_md, "打开后 md 含 <u>", fails)
        assert_true('style="color:red"' in disk_md, "打开后 md 含红字 span", fails)
        assert_true("background:#000" in disk_md, "打开后 md 含黑底 span", fails)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(BASE + "/", wait_until="networkidle")
            page.wait_for_selector("#editor .vditor-reset", timeout=20000)
            # 等 Vditor 就绪并拉到内容
            page.wait_for_function(
                """() => {
                  const r = document.querySelector('#editor .vditor-reset');
                  return r && (r.innerText || '').includes('标记往返测试');
                }""",
                timeout=20000,
            )
            # 给 fixUnparsedInline 一点时间
            page.wait_for_timeout(800)

            print("\n=== 2) 编辑器显示（样式须落在文字本身） ===")
            vis = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  const text = root ? (root.innerText || '') : '';
                  function styleOf(word) {
                    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                    while (w.nextNode()) {
                      if ((w.currentNode.nodeValue || '').includes(word)) {
                        const el = w.currentNode.parentElement;
                        const cs = getComputedStyle(el);
                        return {
                          tag: el.tagName,
                          color: cs.color,
                          bg: cs.backgroundColor,
                          td: cs.textDecorationLine || '',
                          fw: cs.fontWeight,
                        };
                      }
                    }
                    return null;
                  }
                  const u = styleOf('下划线词');
                  const red = styleOf('红色文字');
                  const black = styleOf('黑底白字');
                  const bold = styleOf('一是xxx');
                  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                  let literalStar = false, literalTag = false;
                  while (walker.nextNode()) {
                    const v = walker.currentNode.nodeValue || '';
                    if (/\\*\\*[^*]+\\*\\*/.test(v)) literalStar = true;
                    if (/<\\/?u\\b/i.test(v) || /<span\\b/i.test(v)) literalTag = true;
                  }
                  const brokenInline = root.querySelectorAll('code[data-type="html-inline"]').length;
                  return {
                    text, u, red, black, bold, literalStar, literalTag, brokenInline,
                    hasTitle: text.includes('标记往返测试'),
                    hasSign: text.includes('署名测试'),
                    wordUnderlined: !!(u && /underline/i.test(u.td)),
                    wordRed: !!(red && /rgb\\(255,\\s*0,\\s*0\\)|rgb\\(198,\\s*40,\\s*40\\)/.test(red.color)),
                    wordBlackBg: !!(black && /rgb\\(0,\\s*0,\\s*0\\)/.test(black.bg)),
                    wordBold: !!(bold && (parseInt(bold.fw, 10) >= 600 || bold.tag === 'STRONG' || bold.tag === 'B')),
                  };
                }"""
            )
            assert_true(vis["hasTitle"], "标题可见", fails)
            assert_true(vis["hasSign"], "右对齐署名可见", fails)
            assert_true(vis["wordBold"], "「一是xxx」本身为加黑", fails)
            assert_true(vis["wordUnderlined"], "「下划线词」本身有下划线", fails)
            assert_true(vis["wordRed"], "「红色文字」本身为红字", fails)
            assert_true(vis["wordBlackBg"], "「黑底白字」本身为黑底", fails)
            assert_true(not vis["literalStar"], "无裸露 **加黑** 文本", fails)
            assert_true(not vis["literalTag"], "无裸露 <u>/<span> 文本", fails)
            assert_true(vis["brokenInline"] == 0, f"无破裂 html-inline code（现 {vis['brokenInline']}）", fails)

            print("\n=== 3) getEditorMd 落盘形态 ===")
            saved_md = page.evaluate(
                """() => {
                  if (typeof getEditorMd === 'function') return getEditorMd();
                  if (window.vditor) return vditor.getValue();
                  return '';
                }"""
            )
            assert_true("**" in saved_md and "<strong" not in saved_md.lower(), "加黑落盘为 ** 而非 <strong>", fails)
            assert_true("<u>" in saved_md, "保存 md 保留 <u>", fails)
            assert_true("color:red" in saved_md.replace(" ", ""), "保存 md 保留红字", fails)
            assert_true("background:#000" in saved_md.replace(" ", "") or "background:#000000" in saved_md.replace(" ", ""), "保存 md 保留黑底", fails)

            print("\n=== 4) 保存 → 再读盘 → 刷新显示 ===")
            api("POST", "/api/save", {"md": saved_md})
            content = api("GET", "/api/content")
            disk2 = content.get("md") or ""
            assert_true("**一是xxx。**" in disk2 or "**一是xxx**" in disk2, "磁盘仍有加黑 **", fails)
            assert_true("<u>" in disk2, "磁盘仍有 <u>", fails)

            page.reload(wait_until="networkidle")
            page.wait_for_selector("#editor .vditor-reset", timeout=20000)
            page.wait_for_function(
                """() => {
                  const r = document.querySelector('#editor .vditor-reset');
                  return r && (r.innerText || '').includes('标记往返测试');
                }""",
                timeout=20000,
            )
            page.wait_for_timeout(800)
            vis2 = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                  let literalStar = false, literalTag = false;
                  while (walker.nextNode()) {
                    const v = walker.currentNode.nodeValue || '';
                    if (/\\*\\*[^*]+\\*\\*/.test(v)) literalStar = true;
                    if (/<\\/?u\\b/i.test(v) || /<span\\b/i.test(v)) literalTag = true;
                  }
                  const text = root.innerText || '';
                  return {
                    literalStar, literalTag,
                    ok: text.includes('下划线词') && text.includes('红色文字') && text.includes('黑底白字'),
                  };
                }"""
            )
            assert_true(vis2["ok"], "刷新后文案仍可见", fails)
            assert_true(not vis2["literalStar"], "刷新后无裸露 **", fails)
            assert_true(not vis2["literalTag"], "刷新后无裸露 HTML 标签文本", fails)

            browser.close()

        print("\n=== 5) md2docx / docx2md 往返（转换器） ===")
        import subprocess

        tools = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tools"))
        docx_path = os.path.join(tmp, "out.docx")
        r = subprocess.run(
            [sys.executable, os.path.join(tools, "md2docx.py"), pristine, docx_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        assert_true(r.returncode == 0 and os.path.exists(docx_path), f"md2docx ok ({r.stderr[:200]})", fails)

        back_md = os.path.join(tmp, "back.md")
        r2 = subprocess.run(
            [sys.executable, os.path.join(tools, "docx2md.py"), docx_path, back_md],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        assert_true(r2.returncode == 0 and os.path.exists(back_md), f"docx2md ok ({r2.stderr[:200]})", fails)
        with open(back_md, encoding="utf-8") as f:
            roundtrip = f.read()
        assert_true("**" in roundtrip, "docx→md 仍有加黑 **", fails)
        assert_true("<u>" in roundtrip, "docx→md 仍有下划线", fails)
        assert_true("color:red" in roundtrip.replace(" ", "") or "color:#ff0000" in roundtrip.lower().replace(" ", ""), "docx→md 仍有红字", fails)
        assert_true("background:#000" in roundtrip.replace(" ", "") or "background:#000000" in roundtrip.replace(" ", ""), "docx→md 仍有黑底", fails)

    print("\n" + "=" * 40)
    if fails:
        print(f"结果：{len(fails)} 项失败")
        for m in fails:
            print(f"  - {m}")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
