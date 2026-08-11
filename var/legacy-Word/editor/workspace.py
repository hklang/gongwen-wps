#!/usr/bin/env python3
"""公文工作空间：在打开 md 的根目录维护 .gongwen/ 目录（配置与状态）。"""
from __future__ import annotations

import json
import os
import re
import time

GONGWEN_DIR = ".gongwen"
WORKSPACE_JSON = "workspace.json"
CONFIG_JSON = "config.json"
MATERIAL_DIR = "素材"
VERSION_DIR = "版本"
SKIP_DIRS = {
    "var", "快照", VERSION_DIR, ".git", "node_modules", ".venv", "venv",
    "__pycache__", "vendor", "dist", ".cursor",
    "Word",  # 编辑器/扩展源码，不计入公文素材
}

_DEFAULT_CONFIG = {
    "version": 1,
    "note": "公文工作区配置（可后续扩展）",
}

_MATERIAL_README = (
    "# 素材文件夹\n\n"
    "请把写稿要用的参考材料（旧稿、提纲、会议纪要、数据说明等）放到这里。\n"
    "侧栏只显示 `.md`。放入 `.docx` / `.txt` / `.pdf` 后，点「转换」生成同名 md；源文件保留。\n"
    "对话授权改稿时会优先读取本目录的 md。\n"
)

_MATERIAL_CONVERT_EXTS = {".docx", ".txt", ".pdf"}
_CONVERT_SCRIPT = {
    ".docx": "docx2md.py",
    ".txt": "txt2md.py",
    ".pdf": "pdf2md.py",
}

_VERSION_README = (
    "# 版本文件夹\n\n"
    "「存版本」会把当前文稿副本放在这里，不影响正在编辑的正文。\n"
    "也可自行备份重要稿件到本目录。\n"
)


def gongwen_dir(root: str) -> str:
    return os.path.join(os.path.abspath(root), GONGWEN_DIR)


def workspace_json_path(root: str) -> str:
    return os.path.join(gongwen_dir(root), WORKSPACE_JSON)


def config_json_path(root: str) -> str:
    return os.path.join(gongwen_dir(root), CONFIG_JSON)


def _is_gongwen_marker(path: str) -> bool:
    """根下存在 .gongwen 目录，或遗留的 .gongwen 单文件。"""
    return os.path.isdir(path) or os.path.isfile(path)


def resolve_root(md_path: str) -> str:
    """工作目录 = 当前 md 所在目录。

    若在「素材/版本/work/快照」内则上抬到父目录。
    不再向上搜索父级 .gongwen（避免 src2 等子目录绑到上层工程）。
    """
    d = os.path.dirname(os.path.abspath(md_path or ""))
    if not d:
        return os.getcwd()
    lift = {MATERIAL_DIR, VERSION_DIR, "work", "Work", "快照"}
    for _ in range(3):
        base = os.path.basename(d)
        if base not in lift and base.lower() != "work":
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return d


def _rel(root: str, path: str) -> str:
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        return os.path.basename(path)


def _title_of(md_path: str) -> str:
    try:
        with open(md_path, "r", encoding="utf-8") as f:
            head = f.read(4000)
    except OSError:
        return os.path.splitext(os.path.basename(md_path))[0]
    m = re.search(r"(?m)^#\s+(.+)$", head)
    if m:
        return m.group(1).strip()
    return os.path.splitext(os.path.basename(md_path))[0]


def scan_md_files(root: str, limit: int = 40) -> list[dict]:
    """扫描根下 md（跳过快照/var 等），返回 [{path, title, bytes}]。"""
    root = os.path.abspath(root)
    out: list[dict] = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS and not x.startswith(".")]
        rel_dir = _rel(root, dirpath)
        if rel_dir.startswith("../"):
            continue
        for name in filenames:
            if not name.lower().endswith(".md"):
                continue
            if name.startswith(".") or name == "说明.md":
                continue
            fp = os.path.join(dirpath, name)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            out.append({
                "path": _rel(root, fp),
                "title": _title_of(fp),
                "bytes": int(st.st_size),
            })
            if len(out) >= limit:
                return sorted(out, key=lambda x: x["path"])
    return sorted(out, key=lambda x: x["path"])


def _read_json(fp: str) -> dict | None:
    if not os.path.isfile(fp):
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(fp: str, data: dict) -> str:
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    payload = dict(data or {})
    tmp = fp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, fp)
    return fp


def _ensure_folder_with_readme(root: str, name: str, readme: str) -> str:
    d = os.path.join(os.path.abspath(root), name)
    os.makedirs(d, exist_ok=True)
    tip = os.path.join(d, "说明.md")
    if not os.path.isfile(tip):
        with open(tip, "w", encoding="utf-8") as f:
            f.write(readme if readme.endswith("\n") else readme + "\n")
    return d


def ensure_user_folders(root: str) -> dict:
    """工作区根下创建「素材」「版本」，便于用户投放材料与存版本。"""
    root = os.path.abspath(root)
    return {
        "materials": _ensure_folder_with_readme(root, MATERIAL_DIR, _MATERIAL_README),
        "versions": _ensure_folder_with_readme(root, VERSION_DIR, _VERSION_README),
    }


def ensure_dir(root: str) -> str:
    """确保 .gongwen/ 为目录；若遗留单文件则迁移为目录+workspace.json。"""
    root = os.path.abspath(root)
    marker = os.path.join(root, GONGWEN_DIR)
    legacy_data = None
    if os.path.isfile(marker):
        legacy_data = _read_json(marker) or {}
        try:
            os.remove(marker)
        except OSError:
            # 删不掉则改名避开
            try:
                os.replace(marker, marker + ".legacy.json")
            except OSError:
                pass
    os.makedirs(marker, exist_ok=True)
    cfg = config_json_path(root)
    if not os.path.isfile(cfg):
        _write_json(cfg, dict(_DEFAULT_CONFIG))
    ws_fp = workspace_json_path(root)
    if legacy_data is not None and not os.path.isfile(ws_fp):
        _write_json(ws_fp, legacy_data)
    ensure_user_folders(root)
    return marker


def load(root: str) -> dict | None:
    ensure_dir(root)
    data = _read_json(workspace_json_path(root))
    if data is not None:
        return data
    # 兼容：极端情况下仍读到遗留文件名
    legacy = os.path.join(os.path.abspath(root), GONGWEN_DIR + ".legacy.json")
    return _read_json(legacy)


def save(root: str, data: dict) -> str:
    ensure_dir(root)
    payload = dict(data or {})
    payload["version"] = int(payload.get("version") or 1)
    payload["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return _write_json(workspace_json_path(root), payload)


def touch_for_md(md_path: str, workspace_name: str = "") -> dict:
    """打开/保存 md 时：确保 .gongwen/ 存在，并写入当前文件与文件清单。"""
    md_path = os.path.abspath(md_path)
    root = resolve_root(md_path)
    ensure_dir(root)
    prev = load(root) or {}
    cur_rel = _rel(root, md_path)
    # 仅文稿根一层 + 素材 + 版本，不扫 src2/work
    files = (
        _list_md_in_subdir(root, "", cur_rel)
        + _list_md_in_subdir(root, MATERIAL_DIR, cur_rel)
        + _list_md_in_subdir(root, VERSION_DIR, cur_rel)
    )
    name = (workspace_name or prev.get("name") or os.path.basename(root) or "公文工作区").strip()
    data = {
        "version": 1,
        "name": name,
        "root": root,
        "current": cur_rel,
        "currentTitle": _title_of(md_path) if os.path.isfile(md_path) else "",
        "files": files,
        "materials": prev.get("materials") if isinstance(prev.get("materials"), list) else [],
    }
    folders = ensure_user_folders(root)
    save(root, data)
    data["gongwenPath"] = gongwen_dir(root)
    data["workspaceFile"] = workspace_json_path(root)
    data["materialDir"] = folders["materials"]
    data["versionDir"] = folders["versions"]
    return data


def summary_for_ai(md_path: str, max_files: int = 12) -> dict:
    """给对话用的精简工作区快照（不含大段正文）。"""
    if not md_path or not os.path.isfile(md_path):
        return {}
    data = touch_for_md(md_path)
    files = list(data.get("files") or [])[:max_files]
    return {
        "name": data.get("name") or "",
        "root": data.get("root") or "",
        "current": data.get("current") or "",
        "currentTitle": data.get("currentTitle") or "",
        "files": files,
        "gongwenPath": data.get("gongwenPath") or "",
    }


def _list_md_in_subdir(root: str, sub: str, cur_rel: str, limit: int = 40) -> list[dict]:
    """扫描工程根下某一子目录中的 md（用于「版本」等被 SKIP 的目录）。"""
    root = os.path.abspath(root)
    d = os.path.join(root, sub)
    out: list[dict] = []
    if not os.path.isdir(d):
        return out
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for name in names:
        if not name.lower().endswith(".md") or name.startswith(".") or name == "说明.md":
            continue
        fp = os.path.join(d, name)
        if not os.path.isfile(fp):
            continue
        try:
            st = os.stat(fp)
        except OSError:
            continue
        rel = _rel(root, fp)
        out.append({
            "path": rel,
            "title": _title_of(fp),
            "bytes": int(st.st_size),
            "current": rel == cur_rel,
        })
        if len(out) >= limit:
            break
    return out


def list_project_files(md_path: str) -> dict:
    """工程 md 分区：文稿=根目录一层；素材/、版本/ 各自一层。不扫 src2/work 等。"""
    if not md_path:
        return {"ok": False, "error": "请先打开文档", "docs": [], "materials": [], "versions": []}
    abs_path = os.path.abspath(md_path)
    # 软切换后文件可能已删：仍按路径定根列出，避免三区全空
    missing = not os.path.isfile(abs_path)
    root = resolve_root(abs_path)
    ensure_user_folders(root)
    cur_rel = _rel(root, abs_path)
    return {
        "ok": True,
        "name": (load(root) or {}).get("name") or os.path.basename(root),
        "root": root,
        "current": cur_rel,
        "missingCurrent": missing,
        "warning": "当前文件已不在磁盘，已按工程根刷新列表" if missing else None,
        "docs": _list_md_in_subdir(root, "", cur_rel),
        "materials": _list_md_in_subdir(root, MATERIAL_DIR, cur_rel),
        "versions": _list_md_in_subdir(root, VERSION_DIR, cur_rel),
    }


def list_material_sources(md_path: str) -> dict:
    """素材夹一层待转：docx / txt / pdf（不含 ~$）。"""
    if not md_path:
        return {"ok": False, "error": "请先打开文档", "items": []}
    root = resolve_root(md_path)
    mat_dir = ensure_user_folders(root)["materials"]
    items = []
    try:
        names = os.listdir(mat_dir)
    except OSError:
        return {"ok": True, "items": [], "root": root, "materialsDir": mat_dir}
    for name in names:
        if not name or name.startswith("~$"):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in _MATERIAL_CONVERT_EXTS:
            continue
        src = os.path.join(mat_dir, name)
        if not os.path.isfile(src):
            continue
        base = os.path.splitext(name)[0]
        md = os.path.join(mat_dir, base + ".md")
        items.append({
            "name": name,
            "ext": ext,
            "src": src,
            "md": md,
            "hasMd": os.path.isfile(md),
            "relSrc": _rel(root, src),
            "relMd": _rel(root, md),
        })
    return {"ok": True, "items": items, "root": root, "materialsDir": mat_dir}


def list_material_docx(md_path: str) -> dict:
    """兼容旧名。"""
    return list_material_sources(md_path)


def convert_materials(md_path: str, force: bool = False) -> dict:
    """素材夹 docx/txt/pdf → 同目录同名 md；源文件不删。"""
    from session import run_converter

    listed = list_material_sources(md_path)
    if not listed.get("ok"):
        return listed
    items = listed.get("items") or []
    if not items:
        return {
            "ok": True,
            "converted": [],
            "skipped": [],
            "failed": [],
            "need_confirm": [],
            "message": "素材夹中没有可转换的文件（.docx / .txt / .pdf）",
        }
    converted, skipped, failed, need_confirm = [], [], [], []
    for it in items:
        if it.get("hasMd") and not force:
            skipped.append(it["name"])
            need_confirm.append({"name": it["name"], "md": it.get("relMd")})
            continue
        script = _CONVERT_SCRIPT.get(it.get("ext") or "")
        if not script:
            failed.append({"name": it["name"], "error": "暂不支持：" + str(it.get("ext"))})
            continue
        tmp = it["md"] + ".converting"
        rc, _, err = run_converter(script, it["src"], tmp)
        if rc != 0:
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            failed.append({
                "name": it["name"],
                "error": script.replace(".py", "") + " 失败：" + (err or "").strip(),
            })
            continue
        try:
            if os.path.isfile(it["md"]):
                os.remove(it["md"])
            os.replace(tmp, it["md"])
            converted.append(it["name"])
        except OSError as e:
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            failed.append({"name": it["name"], "error": "写入 md 失败：" + str(e)})
    return {
        "ok": len(failed) == 0,
        "converted": converted,
        "skipped": skipped,
        "failed": failed,
        "need_confirm": need_confirm,
        "message": (
            f"已转换 {len(converted)} 个"
            + (f"，跳过 {len(skipped)} 个（已有 md）" if skipped else "")
            + (f"，失败 {len(failed)} 个" if failed else "")
        ),
    }


def material_snippets(md_path: str, limit: int = 3, each: int = 800) -> list[dict]:
    """只读本工程「素材/」，不扫 src2/终稿/work。"""
    if not md_path:
        return []
    root = resolve_root(md_path)
    ensure_user_folders(root)
    root_abs = os.path.abspath(root)
    cur_rel = _rel(root, os.path.abspath(md_path))
    items = [
        it for it in _list_md_in_subdir(root, MATERIAL_DIR, cur_rel)
        if it.get("path") != cur_rel
        and int(it.get("bytes") or 0) >= 80
        and os.path.basename(it.get("path") or "") != "说明.md"
    ]
    items.sort(key=lambda it: -int(it.get("bytes") or 0))
    out = []
    for item in items:
        rel = item.get("path") or ""
        fp = os.path.normpath(os.path.join(root, rel.replace("/", os.sep)))
        if not fp.startswith(root_abs):
            continue
        try:
            with open(fp, "r", encoding="utf-8") as f:
                text = f.read(each)
        except OSError:
            continue
        out.append({"path": rel, "title": item.get("title") or rel, "snippet": text})
        if len(out) >= limit:
            break
    return out
