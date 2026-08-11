# -*- coding: utf-8 -*-
"""邀请码：试用准入（非用户文稿）。"""
from __future__ import annotations

import os
import secrets
import time
from typing import Any

from control_db import connect, init_db


def register_mode() -> str:
    raw = (os.environ.get("CONTROL_REGISTER_MODE") or "open").strip().lower()
    if raw in ("invite", "closed", "open"):
        return raw
    return "open"


def _norm_code(code: str) -> str:
    return (code or "").strip().upper()


def create_invite(
    *,
    plan_code: str = "free",
    max_uses: int = 1,
    days: int = 30,
    note: str = "",
    code: str = "",
) -> dict[str, Any]:
    init_db()
    plan_code = (plan_code or "free").strip().lower()
    max_uses = max(1, min(10000, int(max_uses or 1)))
    days = max(0, int(days or 0))
    raw = _norm_code(code) or secrets.token_hex(4).upper()
    now = time.time()
    expire_at = (now + days * 86400) if days > 0 else 0.0
    with connect() as conn:
        plan = conn.execute(
            "SELECT id FROM plans WHERE code=?", (plan_code,)
        ).fetchone()
        if not plan:
            raise ValueError("套餐不存在：" + plan_code)
        try:
            conn.execute(
                "INSERT INTO invite_codes(code,plan_code,max_uses,used_count,expire_at,status,note,created_at)"
                " VALUES(?,?,?,0,?,?,?,?)",
                (raw, plan_code, max_uses, expire_at, "active", note or "", now),
            )
        except Exception:
            raise ValueError("邀请码已存在") from None
        conn.commit()
    return {
        "ok": True,
        "code": raw,
        "plan_code": plan_code,
        "max_uses": max_uses,
        "expire_at": expire_at,
        "note": note or "",
    }


def list_invites(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    limit = max(1, min(500, int(limit or 100)))
    with connect() as conn:
        rows = conn.execute(
            "SELECT id,code,plan_code,max_uses,used_count,expire_at,status,note,created_at"
            " FROM invite_codes ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def revoke_invite(code: str) -> dict[str, Any]:
    init_db()
    raw = _norm_code(code)
    if not raw:
        raise ValueError("缺少邀请码")
    with connect() as conn:
        row = conn.execute(
            "SELECT id,status FROM invite_codes WHERE code=?", (raw,)
        ).fetchone()
        if not row:
            raise ValueError("邀请码不存在")
        conn.execute(
            "UPDATE invite_codes SET status='revoked' WHERE id=?",
            (int(row["id"]),),
        )
        conn.commit()
    return {"ok": True, "code": raw, "status": "revoked"}


def peek_invite(conn, code: str) -> dict[str, Any] | None:
    """校验可用邀请码（不加 used_count）。"""
    raw = _norm_code(code)
    if not raw:
        return None
    row = conn.execute(
        "SELECT id,code,plan_code,max_uses,used_count,expire_at,status"
        " FROM invite_codes WHERE code=?",
        (raw,),
    ).fetchone()
    if not row:
        return None
    if str(row["status"]) != "active":
        raise ValueError("邀请码已作废")
    exp = float(row["expire_at"] or 0)
    if exp > 0 and exp < time.time():
        raise ValueError("邀请码已过期")
    if int(row["used_count"]) >= int(row["max_uses"]):
        raise ValueError("邀请码已用尽")
    return dict(row)


def consume_invite(conn, invite_id: int) -> None:
    conn.execute(
        "UPDATE invite_codes SET used_count=used_count+1 WHERE id=?",
        (int(invite_id),),
    )
