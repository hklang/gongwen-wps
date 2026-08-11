"""全链路：编辑器 ↔ 落地 md ↔ docx，一律用 md 标记沟通。

检查点：
1) 打开 md → 编辑器 getEditorMd 形态正确（** / <u> / 红 / 黑底 / 混排）
2) 保存落盘 = getEditorMd
3) 重新加载 → 显示样式在文字上 + getEditorMd 仍正确
4) 落盘 md → md2docx → docx2md → 标记仍在
5) 导出 API docx → docx2md 同上
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("EDITOR_URL", "http://127.0.0.1:8765")

SAMPLE = """# 链路测试

## 一、加黑

根据工作分工，**一是xxx。**正文继续。

### （一）样式

正文 <u>下划线词</u> 后。

<span style="color:red">红色文字</span>

<span style="background:#000;color:#fff">黑底白字</span>

混排：<u>**加黑下划线**</u>与<span style="color:red">**红加黑**</span>。

<div align="right">署名测试</div>
"""

MUST_IN_MD = [
    ("**一是xxx。**", "加黑 **"),
    ("<u>下划线词</u>", "下划线 <u>"),
    ('<span style="color:red">红色文字</span>', "红字 span"),
    ('<span style="background:#000;color:#fff">黑底白字</span>', "黑底 span"),
    ("<u>**加黑下划线**</u>", "加黑下划线混排"),
    ('<span style="color:red">**红加黑**</span>', "红加黑混排"),
    ('<div align="right">署名测试</div>', "右对齐"),
]


def api(method: str, path: str, body: dict | None = None, raw: bool = False):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        blob = resp.read()
        if raw:
            return blob
        return json.loads(blob.decode("utf-8"))


def assert_true(cond: bool, msg: str, fails: list) -> None:
    print(("  OK  " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def check_md_shape(md: str, label: str, fails: list) -> None:
    compact = md.replace(" ", "")
    assert_true("<strong" not in md.lower() and "<b>" not in md.lower(), f"{label}: 加黑不用 <strong>/<b>", fails)
    for needle, name in MUST_IN_MD:
        ok = needle in md or needle.replace(" ", "") in compact
        # 红/黑底允许属性空格差异
        if not ok and "color:red" in needle:
            ok = bool(re.search(r'<span\s+style="color:\s*red">红色文字</span>', md, re.I))
        if not ok and "background:#000" in needle and "黑底" in needle:
            ok = bool(re.search(
                r'<span\s+style="background:\s*#000(?:000)?;\s*color:\s*#fff(?:fff)?">黑底白字</span>',
                md, re.I,
            ))
        if not ok and "红加黑" in needle:
            ok = bool(re.search(
                r'<span\s+style="color:\s*red">\*\*红加黑\*\*</span>',
                md, re.I,
            ))
        assert_true(ok, f"{label}: 含 {name}", fails)
    # 禁止 Vditor 损坏形态
    assert_true(not re.search(r"(^|[^\w])u下划线词", md), f"{label}: 无损坏 u下划线词", fails)
    assert_true("span红色" not in md and "span黑底" not in md, f"{label}: 无损坏 span前缀", fails)


def main() -> int:
    fails: list[str] = []
    try:
        urllib.request.urlopen(BASE + "/", timeout=5)
    except Exception as e:
        print("编辑器未启动:", e)
        return 2

    tools = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tools"))

    with tempfile.TemporaryDirectory(prefix="md_pipe_") as tmp:
        md_path = os.path.join(tmp, "链路测试.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(SAMPLE)

        print("\n=== A) 打开 md（会话落地） ===")
        opened = api("POST", "/api/open-path", {"path": md_path})
        assert_true(opened.get("ok"), "open-path ok", fails)
        check_md_shape(opened.get("md") or "", "打开返回", fails)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(BASE + "/", wait_until="networkidle")
            page.wait_for_function(
                """() => {
                  const r = document.querySelector('#editor .vditor-reset');
                  return r && (r.innerText || '').includes('链路测试');
                }""",
                timeout=20000,
            )
            page.wait_for_timeout(600)

            print("\n=== B) 编辑器 getEditorMd ===")
            editor_md = page.evaluate("() => getEditorMd()")
            check_md_shape(editor_md, "编辑器", fails)

            print("\n=== C) 保存落盘 ===")
            api("POST", "/api/save", {"md": editor_md})
            with open(md_path, encoding="utf-8") as f:
                disk1 = f.read()
            check_md_shape(disk1, "落盘", fails)
            assert_true(
                disk1.replace("\r\n", "\n").strip() == editor_md.replace("\r\n", "\n").strip(),
                "落盘内容 = getEditorMd",
                fails,
            )

            print("\n=== D) 重新加载（按钮） ===")
            page.click("#btnReload")
            page.wait_for_timeout(800)
            page.wait_for_function(
                """() => {
                  const r = document.querySelector('#editor .vditor-reset');
                  return r && (r.innerText || '').includes('下划线词');
                }""",
                timeout=15000,
            )
            page.wait_for_timeout(400)
            vis = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  function okWord(word, pred) {
                    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                    while (w.nextNode()) {
                      if ((w.currentNode.nodeValue || '').includes(word)) {
                        let el = w.currentNode.parentElement;
                        while (el && el !== root) {
                          if (pred(el, getComputedStyle(el))) return true;
                          el = el.parentElement;
                        }
                      }
                    }
                    return false;
                  }
                  return {
                    u: okWord('下划线词', (el, cs) => el.tagName === 'U' || /underline/i.test(cs.textDecorationLine)),
                    red: okWord('红色文字', (el, cs) => /rgb\\(255,\\s*0,\\s*0\\)|rgb\\(198,\\s*40,\\s*40\\)/.test(cs.color)),
                    black: okWord('黑底白字', (el, cs) => /rgb\\(0,\\s*0,\\s*0\\)/.test(cs.backgroundColor)),
                    boldU: okWord('加黑下划线', (el, cs) => {
                      let u=false,b=false,cur=el;
                      while (cur && cur !== root) {
                        const s=getComputedStyle(cur);
                        if (cur.tagName==='U'||/underline/i.test(s.textDecorationLine)) u=true;
                        if (cur.tagName==='STRONG'||parseInt(s.fontWeight,10)>=600) b=true;
                        cur=cur.parentElement;
                      }
                      return u&&b;
                    }),
                    redBold: okWord('红加黑', (el, cs) => {
                      let r=false,b=false,cur=el;
                      while (cur && cur !== root) {
                        const s=getComputedStyle(cur);
                        if (/rgb\\(255,\\s*0,\\s*0\\)|rgb\\(198,\\s*40,\\s*40\\)/.test(s.color)) r=true;
                        if (cur.tagName==='STRONG'||parseInt(s.fontWeight,10)>=600) b=true;
                        cur=cur.parentElement;
                      }
                      return r&&b;
                    }),
                    broken: root.querySelectorAll('code[data-type="html-inline"]').length,
                    md: getEditorMd(),
                  };
                }"""
            )
            assert_true(vis["u"], "重载后：下划线显示", fails)
            assert_true(vis["red"], "重载后：红字显示", fails)
            assert_true(vis["black"], "重载后：黑底显示", fails)
            assert_true(vis["boldU"], "重载后：加黑下划线显示", fails)
            assert_true(vis["redBold"], "重载后：红加黑显示", fails)
            assert_true(vis["broken"] == 0, f"重载后：无破裂 html-inline（{vis['broken']}）", fails)
            check_md_shape(vis["md"], "重载后编辑器", fails)

            print("\n=== E) 落盘 md → docx → md ===")
            docx1 = os.path.join(tmp, "from_disk.docx")
            back1 = os.path.join(tmp, "from_disk.md")
            r = subprocess.run(
                [sys.executable, os.path.join(tools, "md2docx.py"), md_path, docx1],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            assert_true(r.returncode == 0, "md2docx(落盘)", fails)
            r2 = subprocess.run(
                [sys.executable, os.path.join(tools, "docx2md.py"), docx1, back1],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            assert_true(r2.returncode == 0, "docx2md(落盘)", fails)
            with open(back1, encoding="utf-8") as f:
                round1 = f.read()
            check_md_shape(round1, "docx往返", fails)

            print("\n=== F) 导出 API → docx2md ===")
            # 先确保会话内容是最新编辑器 md
            api("POST", "/api/save", {"md": vis["md"]})
            blob = api("GET", "/api/export?fmt=docx", raw=True)
            docx2 = os.path.join(tmp, "export.docx")
            with open(docx2, "wb") as f:
                f.write(blob)
            back2 = os.path.join(tmp, "export.md")
            r3 = subprocess.run(
                [sys.executable, os.path.join(tools, "docx2md.py"), docx2, back2],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            assert_true(r3.returncode == 0 and os.path.getsize(docx2) > 1000, "export docx 有效", fails)
            with open(back2, encoding="utf-8") as f:
                round2 = f.read()
            check_md_shape(round2, "导出往返", fails)

            # 把三份 md 摘要写入便于人工看
            summary = os.path.join(tmp, "summary.txt")
            with open(summary, "w", encoding="utf-8") as f:
                f.write("=== editor ===\n" + editor_md + "\n=== disk ===\n" + disk1)
                f.write("\n=== docx2md ===\n" + round1)
                f.write("\n=== export2md ===\n" + round2)
            print("\n摘要已写:", summary)

            browser.close()

    print("\n" + "=" * 40)
    if fails:
        print(f"结果：{len(fails)} 项失败")
        for m in fails:
            print("  -", m)
        return 1
    print("结果：全链路通过（编辑器 / md落盘 / docx 均以 md 标记互通）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
