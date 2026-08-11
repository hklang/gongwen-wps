#!/usr/bin/env python3
"""工作区会话：打开/保存 md、快照、状态恢复。"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.normpath(os.path.join(BASE, "..", "tools"))
KEEP_SNAPS = 20
STATE_FILE = os.path.join(BASE, "state.json")

# 当前工作区（由打开的文件决定）
CURRENT = {
    "work_base": None,
    "work_dir": None,
    "md_path": None,
    "docx_path": None,
    "snap_dir": None,
}


def cur():
    return CURRENT


def has_session():
    return bool(CURRENT.get("md_path"))


def clear_session():
    """关闭文档：只清内存会话，磁盘 md/快照不动。"""
    CURRENT.update(
        work_base=None, work_dir=None, md_path=None,
        docx_path=None, snap_dir=None,
    )
    save_state()


def run_converter(script, *args):
    """调用 tools/ 下转换脚本，返回 (returncode, stdout, stderr)。"""
    p = subprocess.run(
        [sys.executable, os.path.join(TOOLS, script), *args],
        capture_output=True, text=True,
    )
    return p.returncode, p.stdout, p.stderr


def atomic_write(path, text):
    """先写 .tmp 再 os.replace，避免半截文件。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def snapshot():
    """备份当前 md，最多保留 KEEP_SNAPS 份；同秒多次保存追加序号。"""
    s = cur()
    if not s.get("md_path") or not os.path.exists(s["md_path"]):
        return
    os.makedirs(s["snap_dir"], exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(s["snap_dir"], f"快照_{ts}.md")
    i = 2
    while os.path.exists(dst):
        dst = os.path.join(s["snap_dir"], f"快照_{ts}_{i}.md")
        i += 1
    shutil.copy2(s["md_path"], dst)
    snaps = sorted(f for f in os.listdir(s["snap_dir"]) if f.startswith("快照_"))
    for old in snaps[:-KEEP_SNAPS]:
        os.remove(os.path.join(s["snap_dir"], old))


def save_version():
    """把当前 md 复制到工作区根\\版本\\，文件名 = 原名_日期时间.md（原文件不动）。"""
    s = cur()
    if not s.get("md_path") or not os.path.isfile(s["md_path"]):
        return {"ok": False, "error": "请先打开文档"}
    try:
        import workspace as gw
        root = gw.resolve_root(s["md_path"])
        folders = gw.ensure_user_folders(root)
        ver_dir = folders["versions"]
    except Exception:
        ver_dir = os.path.join(s.get("work_dir") or os.path.dirname(s["md_path"]), "版本")
        os.makedirs(ver_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(s["md_path"]))[0]
    ts = time.strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(ver_dir, f"{stem}_{ts}.md")
    i = 2
    while os.path.exists(dst):
        dst = os.path.join(ver_dir, f"{stem}_{ts}_{i}.md")
        i += 1
    shutil.copy2(s["md_path"], dst)
    return {"ok": True, "path": dst, "filename": os.path.basename(dst)}


def read_md():
    s = cur()
    if not s.get("md_path") or not os.path.exists(s["md_path"]):
        return ""
    with open(s["md_path"], "r", encoding="utf-8") as f:
        return f.read()


def md_hash():
    s = cur()
    if not s.get("md_path") or not os.path.exists(s["md_path"]):
        return ""
    with open(s["md_path"], "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def _session_ok(s):
    """可恢复：md 文件仍在磁盘上。"""
    return bool(s and s.get("work_dir") and s.get("md_path") and os.path.isfile(s["md_path"]))


def save_state():
    try:
        st = {}
        if has_session() and _session_ok(CURRENT):
            st["session"] = {
                "work_base": CURRENT["work_base"],
                "work_dir": CURRENT["work_dir"],
                "md_path": CURRENT["md_path"],
                "docx_path": CURRENT["docx_path"],
                "snap_dir": CURRENT["snap_dir"],
            }
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def load_state():
    """启动恢复上次工作区；忽略 md 已不存在的旧会话。"""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f)
        s = st.get("session") or {}
        if not _session_ok(s):
            return
        os.makedirs(s.get("snap_dir") or os.path.join(s["work_dir"], "快照"), exist_ok=True)
        CURRENT.update(
            work_base=s.get("work_base") or s["work_dir"],
            work_dir=s["work_dir"],
            md_path=s["md_path"],
            docx_path=s["docx_path"],
            snap_dir=s.get("snap_dir") or os.path.join(s["work_dir"], "快照"),
        )
    except Exception:
        pass


def _workspace_payload(md_path):
    try:
        import workspace
        ws = workspace.touch_for_md(md_path)
        return {
            "name": ws.get("name") or "",
            "root": ws.get("root") or "",
            "current": ws.get("current") or "",
            "currentTitle": ws.get("currentTitle") or "",
            "files": ws.get("files") or [],
            "gongwenPath": ws.get("gongwenPath") or "",
        }
    except Exception:
        return {}


def _bind_session(work_base, work_dir, md_path, docx_path, snap_dir):
    os.makedirs(snap_dir, exist_ok=True)
    CURRENT.update(
        work_base=work_base, work_dir=work_dir, md_path=md_path,
        docx_path=docx_path, snap_dir=snap_dir,
    )
    save_state()
    r = {
        "ok": True,
        "filename": os.path.basename(md_path if md_path.endswith(".md") else docx_path),
        "md": read_md(),
        "hash": md_hash(),
        "work_dir": work_dir,
        "path": md_path,
    }
    ws = _workspace_payload(md_path)
    if ws:
        r["workspace"] = ws
    return r


def open_document(path, force=False):
    """打开 docx 或 md，设置当前工作区。

    - md / docx：工作目录 = 文件所在目录（不写旁侧 work/，不牵扯其它位置）
    - docx：转为同目录同名 md；已有则 need_confirm（除非 force）
    """
    p = os.path.normpath(path.strip().strip('"').strip("'"))
    if not os.path.isfile(p):
        return {"ok": False, "error": f"文件不存在：{p}"}
    ext = os.path.splitext(p)[1].lower()
    if ext not in (".docx", ".md"):
        return {"ok": False, "error": f"仅支持 .docx 或 .md，收到的是 {ext or '未知类型'}"}

    d = os.path.dirname(p)
    n = os.path.splitext(os.path.basename(p))[0]
    try:
        import workspace as gw
        root = gw.resolve_root(p if ext == ".md" else os.path.join(d, n + ".md"))
    except Exception:
        root = d

    if ext == ".md":
        snapshot()
        r = _bind_session(
            work_base=root, work_dir=root, md_path=p,
            docx_path=os.path.join(d, n + ".docx"),
            snap_dir=os.path.join(root, "快照"),
        )
        r["filename"] = os.path.basename(p)
        return r

    md_path = os.path.join(d, n + ".md")
    snap_dir = os.path.join(root, "快照")
    os.makedirs(snap_dir, exist_ok=True)

    if os.path.exists(md_path) and not force:
        return {
            "ok": False,
            "need_confirm": True,
            "path": p,
            "md_path": md_path,
            "filename": os.path.basename(p),
            "message": (
                f"同目录已有「{os.path.basename(md_path)}」。\n"
                "打开 docx 会按 Word 重新转换并覆盖该 md（覆盖前会先存一份快照）。\n"
                "日常请改用「打开 md 文件」。\n\n确定覆盖？"
            ),
        }

    if os.path.exists(md_path):
        CURRENT.update(
            work_base=root, work_dir=root, md_path=md_path,
            docx_path=os.path.join(d, n + ".docx"), snap_dir=snap_dir,
        )
        snapshot()

    tmp_md = md_path + ".converting"
    rc, _, err = run_converter("docx2md.py", p, tmp_md)
    if rc != 0:
        if os.path.exists(tmp_md):
            try:
                os.remove(tmp_md)
            except OSError:
                pass
        return {"ok": False, "error": f"docx2md 转换失败：{err.strip()}"}
    os.replace(tmp_md, md_path)

    r = _bind_session(
        work_base=root, work_dir=root, md_path=md_path,
        docx_path=os.path.join(d, n + ".docx"),
        snap_dir=snap_dir,
    )
    r["filename"] = os.path.basename(p)
    return r


def rename_markdown(new_name):
    """重命名当前 md（同目录），更新会话路径。"""
    if not has_session() or not CURRENT.get("md_path"):
        return {"ok": False, "error": "请先打开文档"}
    name = os.path.basename(str(new_name or "").strip().replace("\\", "/"))
    if not name:
        return {"ok": False, "error": "新文件名不能为空"}
    if not name.lower().endswith(".md"):
        name += ".md"
    if name in (".", "..") or "/" in name or "\\" in name:
        return {"ok": False, "error": "非法文件名"}
    old = CURRENT["md_path"]
    new_path = os.path.join(os.path.dirname(old), name)
    if os.path.normpath(old) == os.path.normpath(new_path):
        return {
            "ok": True,
            "path": old,
            "filename": os.path.basename(old),
            "renamed": False,
        }
    if os.path.exists(new_path):
        return {"ok": False, "error": f"目标已存在：{name}"}
    try:
        os.rename(old, new_path)
    except OSError as e:
        return {"ok": False, "error": f"重命名失败：{e}"}
    stem = os.path.splitext(name)[0]
    CURRENT["md_path"] = new_path
    CURRENT["docx_path"] = os.path.join(CURRENT.get("work_dir") or os.path.dirname(new_path), stem + ".docx")
    save_state()
    r = {
        "ok": True,
        "path": new_path,
        "filename": name,
        "renamed": True,
        "hash": md_hash(),
        "md": read_md(),
        "work_dir": CURRENT.get("work_dir") or "",
    }
    ws = _workspace_payload(new_path)
    if ws:
        r["workspace"] = ws
    return r


def create_markdown(path=None, title=""):
    """新建 md 文件并打开为当前工作区。

    path 为空时由调用方先弹「另存为」。写入简短公文骨架后 open_document。
    """
    p = os.path.normpath(str(path or "").strip().strip('"').strip("'"))
    if not p:
        return {"ok": False, "error": "路径不能为空"}
    if os.path.splitext(p)[1].lower() != ".md":
        p = p + ".md"
    parent = os.path.dirname(p)
    if parent and not os.path.isdir(parent):
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": f"无法创建目录：{e}"}

    stem = os.path.splitext(os.path.basename(p))[0]
    heading = (title or stem or "标题").strip() or "标题"
    text = f"# {heading}\n\n"
    try:
        atomic_write(p, text)
    except OSError as e:
        return {"ok": False, "error": f"创建失败：{e}"}

    r = open_document(p, force=True)
    if r.get("ok"):
        r["created"] = True
        r["filename"] = os.path.basename(p)
    return r


def import_markdown(path, force=False):
    """把外部 md 内容导入当前工作文件（路径不变）。

    - 无会话：等同打开该 md
    - 有会话且 force=False：返回 need_confirm，不改盘
    - force=True：快照后写入当前 md_path
    """
    p = os.path.normpath(str(path or "").strip().strip('"').strip("'"))
    if not os.path.isfile(p):
        return {"ok": False, "error": f"文件不存在：{p}"}
    if os.path.splitext(p)[1].lower() != ".md":
        return {"ok": False, "error": "导入仅支持 .md 文件"}

    if not has_session():
        return open_document(p, force=True)

    name = os.path.basename(p)
    if not force:
        return {
            "ok": False,
            "need_confirm": True,
            "path": p,
            "filename": name,
            "message": (
                f"将用「{name}」覆盖当前文稿内容（覆盖前会先存一份快照）。\n"
                "当前文件路径不变。\n\n确定导入？"
            ),
        }

    try:
        with open(p, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return {"ok": False, "error": f"读取失败：{e}"}

    snapshot()
    atomic_write(CURRENT["md_path"], text)
    s = cur()
    return {
        "ok": True,
        "imported": True,
        "md": text,
        "hash": md_hash(),
        "filename": name,
        "path": s.get("md_path") or "",
        "work_dir": s.get("work_dir") or "",
    }
