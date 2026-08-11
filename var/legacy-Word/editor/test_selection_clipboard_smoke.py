# -*- coding: utf-8 -*-
"""冒烟：精修涂黑 × 复制 × 失焦仍保留（规格 2026-08-10-选区与剪贴板）。

用法：先启动编辑器服务，再跑本文件。
  cd Word/editor && python app.py 8765
  python test_selection_clipboard_smoke.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("EDITOR_URL", "http://127.0.0.1:8765")

SAMPLE = """# 选区冒烟

## 一、测试章

这是第一段正文，用于拖选涂黑与复制粘贴。不要跨段。

### （一）小节

第二段不要拖进来。
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


def main() -> int:
    check_server()
    fails: list[str] = []

    def ok(cond: bool, msg: str) -> None:
        if cond:
            print(f"  OK  {msg}")
        else:
            print(f"  FAIL {msg}")
            fails.append(msg)

    with tempfile.TemporaryDirectory(prefix="sel_smoke_") as tmp:
        md_path = os.path.join(tmp, "选区冒烟.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(SAMPLE)
        opened = api("POST", "/api/open-path", {"path": md_path})
        ok(bool(opened.get("ok") or opened.get("md")), "open-path")

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                executable_path=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            )
            page = browser.new_page()
            page.goto(BASE + "/", wait_until="networkidle")
            page.wait_for_selector("#editor .vditor-reset", timeout=20000)
            page.wait_for_function(
                """() => {
                  const r = document.querySelector('#editor .vditor-reset');
                  return r && (r.innerText || '').includes('选区冒烟');
                }""",
                timeout=20000,
            )
            page.wait_for_timeout(500)

            # 进精修
            page.click("#aiTabSuite")
            page.wait_for_timeout(200)
            tab = page.evaluate("() => window.ai ? ai.tab : ''")
            # ai may not be on window — check DOM
            on = page.evaluate(
                "() => document.getElementById('aiTabSuite')?.classList.contains('on')"
            )
            ok(on is True, "切入精修 Tab")

            # 在第一段拖选若干字
            painted = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  if (!root) return { ok:false, why:'no root' };
                  const ps = Array.from(root.querySelectorAll('p'));
                  const p = ps.find(el => (el.textContent||'').includes('第一段正文'));
                  if (!p || !p.firstChild) return { ok:false, why:'no p' };
                  let textNode = null;
                  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
                  while (w.nextNode()) {
                    if ((w.currentNode.nodeValue||'').includes('第一段')) {
                      textNode = w.currentNode; break;
                    }
                  }
                  if (!textNode) return { ok:false, why:'no text' };
                  const r = document.createRange();
                  const s = String(textNode.textContent||'');
                  const i = s.indexOf('第一段');
                  r.setStart(textNode, i);
                  r.setEnd(textNode, Math.min(i + 6, s.length));
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(r);
                  const work = (typeof captureAiSelection === 'function')
                    ? captureAiSelection(true) : null;
                  if (typeof paintAiSelection === 'function') paintAiSelection();
                  if (typeof updateAiChrome === 'function') updateAiChrome();
                  const aiObj = window.__gwAi;
                  return {
                    ok: !!(work || (aiObj && aiObj.work)),
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                    workPlain: (work && work.plain) || (aiObj && aiObj.work && aiObj.work.plain) || '',
                    collapsed: !!(sel.rangeCount && sel.isCollapsed),
                    blueLen: sel.rangeCount && !sel.isCollapsed ? String(sel.toString()).length : 0,
                  };
                }"""
            )
            print("  paint:", painted)
            ok(bool(painted.get("ok")), "拖选后落 work")
            ok(int(painted.get("marks") or 0) > 0, "出现涂黑标记")
            ok(bool(painted.get("collapsed")), "涂黑后蓝选应折叠")

            # 复制兜底（无蓝选）
            copied = page.evaluate(
                """() => {
                  if (typeof clipboardPlainFromEditor !== 'function') return { ok:false };
                  const t = clipboardPlainFromEditor();
                  if (typeof runWriterClipboard === 'function') runWriterClipboard('copy');
                  const root = document.querySelector('#editor .vditor-reset');
                  return {
                    ok: !!(t && t.length),
                    text: t,
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                  };
                }"""
            )
            print("  copy:", copied)
            ok(bool(copied.get("ok")), "Ctrl+C 能从涂黑取到正文")
            ok(int(copied.get("marks") or 0) > 0, "复制后涂黑仍在")

            # 点右侧输入（失焦）
            page.click("#aiReq")
            page.wait_for_timeout(150)
            after_focus = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  const aiObj = window.__gwAi;
                  return {
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                    hasWork: !!(aiObj && aiObj.work),
                    plain: (aiObj && aiObj.work && aiObj.work.plain) || '',
                  };
                }"""
            )
            print("  after aiReq:", after_focus)
            ok(int(after_focus.get("marks") or 0) > 0, "点输入框后涂黑仍在")
            ok(bool(after_focus.get("hasWork")), "点输入框后 ai.work 仍在")

            # 点空白取消
            cleared = page.evaluate(
                """() => {
                  if (typeof clearAiSelection === 'function') {
                    clearAiSelection({ force:true, silent:true });
                  }
                  const root = document.querySelector('#editor .vditor-reset');
                  const aiObj = window.__gwAi;
                  return {
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                    hasWork: !!(aiObj && aiObj.work),
                  };
                }"""
            )
            ok(int(cleared.get("marks") or 0) == 0, "主动取消后无涂黑")
            ok(not cleared.get("hasWork"), "主动取消后无 work")

            # 再涂黑后剪切应清掉
            page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  const p = Array.from(root.querySelectorAll('p'))
                    .find(el => ((el.textContent||'').replace(/\\s/g,'').length > 4));
                  if (!p) return;
                  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
                  let textNode=null;
                  while (w.nextNode()) {
                    if ((w.currentNode.nodeValue||'').trim().length >= 2) {
                      textNode=w.currentNode; break;
                    }
                  }
                  if (!textNode) return;
                  const s=String(textNode.textContent||'');
                  const r=document.createRange();
                  r.setStart(textNode, 0);
                  r.setEnd(textNode, Math.min(2, s.length));
                  const sel=window.getSelection();
                  sel.removeAllRanges(); sel.addRange(r);
                  captureAiSelection(true); paintAiSelection();
                }"""
            )
            cut = page.evaluate(
                """() => {
                  const before = (window.__gwAi && __gwAi.work && __gwAi.work.plain) || '';
                  if (typeof runWriterClipboard === 'function') runWriterClipboard('cut');
                  const root = document.querySelector('#editor .vditor-reset');
                  return {
                    before,
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                    hasWork: !!(window.__gwAi && __gwAi.work),
                    body: (root.innerText||''),
                  };
                }"""
            )
            print("  cut:", {k: cut.get(k) for k in ("before", "marks", "hasWork")})
            ok(bool(cut.get("before")), "剪切前有工作区原文")
            ok(int(cut.get("marks") or 0) == 0, "剪切后涂黑清除")
            ok(not cut.get("hasWork"), "剪切后无 work")

            # 跨段应拒绝
            cross = page.evaluate(
                """() => {
                  const root = document.querySelector('#editor .vditor-reset');
                  const p1 = Array.from(root.querySelectorAll('p'))
                    .find(el => (el.textContent||'').includes('第一段') || (el.textContent||'').includes('拖选'));
                  const p2 = Array.from(root.querySelectorAll('p'))
                    .find(el => (el.textContent||'').includes('第二段'));
                  if (!p1 || !p2) return { ok:false, why:'no paras' };
                  const r = document.createRange();
                  r.setStartBefore(p1);
                  r.setEndAfter(p2);
                  const sel = window.getSelection();
                  sel.removeAllRanges(); sel.addRange(r);
                  const w = captureAiSelection(true);
                  const aiObj = window.__gwAi;
                  return {
                    rejected: !w,
                    warn: (aiObj && aiObj.selWarn) || '',
                    marks: root.querySelectorAll('.ai-work-mark, span[data-ai-work=\"1\"]').length,
                  };
                }"""
            )
            print("  cross:", cross)
            ok(bool(cross.get("rejected")), "跨段拖选被拒绝")
            ok("跨段" in str(cross.get("warn") or "") or int(cross.get("marks") or 0) == 0, "跨段有提示或无涂黑")

            browser.close()

    print("\n==== 结果 ====")
    if fails:
        print("FAILS:", len(fails))
        for f in fails:
            print(" -", f)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
