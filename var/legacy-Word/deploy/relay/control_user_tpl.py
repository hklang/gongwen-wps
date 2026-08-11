# -*- coding: utf-8 -*-
"""用户「我的模板」云库（按账号隔离；非文稿仓）。"""
from __future__ import annotations

import time
from typing import Any

from control_db import connect, init_db

MAX_USER_TEMPLATES = 50
MAX_BODY_BYTES = 32 * 1024


def _uid(user_id: int) -> int:
    uid = int(user_id or 0)
    if uid <= 0:
        raise ValueError("需要登录账号")
    return uid


def _check_body(body_md: str) -> str:
    text = body_md if isinstance(body_md, str) else str(body_md or "")
    if len(text.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("模板过长（上限约 32KB）")
    return text


def _row(r) -> dict[str, Any]:
    return {
        "id": int(r["id"]),
        "title": r["title"] or "",
        "category_code": r["category_code"] or "",
        "body_md": r["body_md"] or "",
        "updated_at": float(r["updated_at"] or 0),
    }


def list_user_templates(user_id: int) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    with connect() as conn:
        rows = conn.execute(
            "SELECT id,title,category_code,body_md,updated_at FROM user_templates"
            " WHERE user_id=? ORDER BY updated_at DESC, id DESC",
            (uid,),
        ).fetchall()
    items = [_row(r) for r in rows]
    # 列表可瘦身：目录不带全文
    light = [
        {
            "id": x["id"],
            "title": x["title"],
            "category_code": x["category_code"],
            "updated_at": x["updated_at"],
            "chars": len(x["body_md"] or ""),
        }
        for x in items
    ]
    return {"ok": True, "templates": light, "limit": MAX_USER_TEMPLATES}


def get_user_template(user_id: int, tpl_id: int) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    tid = int(tpl_id or 0)
    if tid <= 0:
        raise ValueError("缺少模板 id")
    with connect() as conn:
        row = conn.execute(
            "SELECT id,title,category_code,body_md,updated_at FROM user_templates"
            " WHERE id=? AND user_id=?",
            (tid, uid),
        ).fetchone()
    if not row:
        raise ValueError("模板不存在")
    return {"ok": True, "template": _row(row)}


def create_user_template(
    user_id: int,
    title: str,
    body_md: str,
    category_code: str = "",
) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    title = (title or "").strip() or "未命名模板"
    body = _check_body(body_md)
    cat = (category_code or "").strip()[:64]
    with connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM user_templates WHERE user_id=?", (uid,)
        ).fetchone()["c"]
        if int(n) >= MAX_USER_TEMPLATES:
            raise ValueError("我的模板已达上限（%d）" % MAX_USER_TEMPLATES)
        now = time.time()
        cur = conn.execute(
            "INSERT INTO user_templates(user_id,title,category_code,body_md,updated_at)"
            " VALUES(?,?,?,?,?)",
            (uid, title[:120], cat, body, now),
        )
        tid = int(cur.lastrowid)
        row = conn.execute(
            "SELECT id,title,category_code,body_md,updated_at FROM user_templates WHERE id=?",
            (tid,),
        ).fetchone()
    return {"ok": True, "template": _row(row)}


def update_user_template(
    user_id: int,
    tpl_id: int,
    title: str | None = None,
    body_md: str | None = None,
    category_code: str | None = None,
) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    tid = int(tpl_id or 0)
    if tid <= 0:
        raise ValueError("缺少模板 id")
    with connect() as conn:
        row = conn.execute(
            "SELECT id,title,category_code,body_md FROM user_templates"
            " WHERE id=? AND user_id=?",
            (tid, uid),
        ).fetchone()
        if not row:
            raise ValueError("模板不存在")
        new_title = row["title"]
        new_body = row["body_md"]
        new_cat = row["category_code"]
        if title is not None:
            new_title = (title or "").strip() or "未命名模板"
            new_title = new_title[:120]
        if body_md is not None:
            new_body = _check_body(body_md)
        if category_code is not None:
            new_cat = (category_code or "").strip()[:64]
        now = time.time()
        conn.execute(
            "UPDATE user_templates SET title=?, category_code=?, body_md=?, updated_at=?"
            " WHERE id=? AND user_id=?",
            (new_title, new_cat, new_body, now, tid, uid),
        )
        out = conn.execute(
            "SELECT id,title,category_code,body_md,updated_at FROM user_templates WHERE id=?",
            (tid,),
        ).fetchone()
    return {"ok": True, "template": _row(out)}


def delete_user_template(user_id: int, tpl_id: int) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    tid = int(tpl_id or 0)
    if tid <= 0:
        raise ValueError("缺少模板 id")
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM user_templates WHERE id=? AND user_id=?", (tid, uid)
        )
        if cur.rowcount < 1:
            raise ValueError("模板不存在")
    return {"ok": True, "id": tid}
