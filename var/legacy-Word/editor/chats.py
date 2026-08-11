#!/usr/bin/env python3
"""工程级聊天历史：仅落本机 .gongwen/chats/，云端不存。"""
from __future__ import annotations

import json
import os
import time
import uuid

import workspace as gw

CHATS_DIR = "chats"
INDEX_FILE = "index.json"


def _chats_dir(root: str) -> str:
    d = os.path.join(gw.gongwen_dir(root), CHATS_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def _index_path(root: str) -> str:
    return os.path.join(_chats_dir(root), INDEX_FILE)


def _session_path(root: str, sid: str) -> str:
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return os.path.join(_chats_dir(root), f"session-{safe}.json")


def _read_json(fp: str):
    if not os.path.isfile(fp):
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(fp: str, data) -> None:
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    tmp = fp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, fp)


def _load_index(root: str) -> dict:
    data = _read_json(_index_path(root))
    if isinstance(data, dict) and isinstance(data.get("sessions"), list):
        return data
    return {"version": 1, "activeId": "", "sessions": []}


def _save_index(root: str, index: dict) -> None:
    index["version"] = 1
    index["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    _write_json(_index_path(root), index)


def list_sessions(md_path: str) -> dict:
    root = gw.resolve_root(md_path)
    gw.ensure_dir(root)
    idx = _load_index(root)
    return {
        "ok": True,
        "activeId": idx.get("activeId") or "",
        "sessions": idx.get("sessions") or [],
    }


def load_active(md_path: str) -> dict:
    """打开工程时：返回当前会话消息；无则建空会话。"""
    root = gw.resolve_root(md_path)
    gw.ensure_dir(root)
    idx = _load_index(root)
    sid = str(idx.get("activeId") or "").strip()
    if not sid or not os.path.isfile(_session_path(root, sid)):
        return new_session(md_path, title="默认会话")
    data = _read_json(_session_path(root, sid)) or {}
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    return {
        "ok": True,
        "id": sid,
        "title": data.get("title") or "会话",
        "messages": messages,
        "docPath": data.get("docPath") or "",
    }


def new_session(md_path: str, title: str = "新会话") -> dict:
    root = gw.resolve_root(md_path)
    gw.ensure_dir(root)
    sid = uuid.uuid4().hex[:12]
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = gw._rel(root, os.path.abspath(md_path)) if md_path else ""
    payload = {
        "id": sid,
        "title": (title or "新会话").strip() or "新会话",
        "createdAt": now,
        "updatedAt": now,
        "docPath": cur,
        "messages": [],
    }
    _write_json(_session_path(root, sid), payload)
    idx = _load_index(root)
    sessions = [s for s in (idx.get("sessions") or []) if s.get("id") != sid]
    sessions.insert(0, {
        "id": sid,
        "title": payload["title"],
        "updatedAt": now,
        "docPath": cur,
    })
    idx["sessions"] = sessions[:30]
    idx["activeId"] = sid
    _save_index(root, idx)
    return {
        "ok": True,
        "id": sid,
        "title": payload["title"],
        "messages": [],
        "docPath": cur,
    }


def save_session(md_path: str, session_id: str, messages, title: str = "") -> dict:
    root = gw.resolve_root(md_path)
    gw.ensure_dir(root)
    sid = str(session_id or "").strip()
    if not sid:
        return {"ok": False, "error": "缺少会话 id"}
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = gw._rel(root, os.path.abspath(md_path)) if md_path else ""
    prev = _read_json(_session_path(root, sid)) or {}
    title_final = (title or prev.get("title") or "").strip()
    if not title_final and isinstance(messages, list):
        for m in messages:
            if isinstance(m, dict) and m.get("role") == "user":
                title_final = str(m.get("content") or "")[:40]
                break
    if not title_final:
        title_final = "会话"
    clean = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = str(m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            clean.append({"role": role, "content": content[:20000]})
    payload = {
        "id": sid,
        "title": title_final,
        "createdAt": prev.get("createdAt") or now,
        "updatedAt": now,
        "docPath": cur,
        "messages": clean[-80:],
    }
    _write_json(_session_path(root, sid), payload)
    idx = _load_index(root)
    others = [s for s in (idx.get("sessions") or []) if s.get("id") != sid]
    others.insert(0, {
        "id": sid,
        "title": title_final,
        "updatedAt": now,
        "docPath": cur,
    })
    idx["sessions"] = others[:30]
    idx["activeId"] = sid
    _save_index(root, idx)
    return {"ok": True, "id": sid, "title": title_final}


def switch_session(md_path: str, session_id: str) -> dict:
    root = gw.resolve_root(md_path)
    sid = str(session_id or "").strip()
    fp = _session_path(root, sid)
    if not sid or not os.path.isfile(fp):
        return {"ok": False, "error": "会话不存在"}
    data = _read_json(fp) or {}
    idx = _load_index(root)
    idx["activeId"] = sid
    _save_index(root, idx)
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    return {
        "ok": True,
        "id": sid,
        "title": data.get("title") or "会话",
        "messages": messages,
        "docPath": data.get("docPath") or "",
    }
