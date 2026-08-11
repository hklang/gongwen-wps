# -*- coding: utf-8 -*-
"""组织席位占位（无支付、非用户文稿库）。"""
from __future__ import annotations

import time
from typing import Any

from control_db import connect, init_db


def list_orgs(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    limit = max(1, min(200, int(limit or 100)))
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT o.id, o.code, o.name, o.seat_limit, o.manual_pack, o.status, o.created_at,
                   (SELECT COUNT(*) FROM org_members m WHERE m.org_id=o.id) AS seats_used
            FROM orgs o
            ORDER BY o.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_org(
    code: str,
    name: str,
    *,
    seat_limit: int = 5,
    manual_pack: str = "",
) -> dict[str, Any]:
    init_db()
    code = (code or "").strip().lower()
    name = (name or "").strip() or code
    if not code:
        raise ValueError("缺少组织 code")
    seat_limit = max(1, min(5000, int(seat_limit or 5)))
    now = time.time()
    with connect() as conn:
        try:
            conn.execute(
                "INSERT INTO orgs(code,name,seat_limit,manual_pack,status,created_at)"
                " VALUES(?,?,?,?,'active',?)",
                (code, name, seat_limit, manual_pack or "", now),
            )
        except Exception:
            raise ValueError("组织 code 已存在") from None
        conn.commit()
    return {"ok": True, "code": code, "name": name, "seat_limit": seat_limit}


def add_member(org_code: str, email: str, role: str = "member") -> dict[str, Any]:
    init_db()
    org_code = (org_code or "").strip().lower()
    email = (email or "").strip().lower()
    role = (role or "member").strip() or "member"
    if not org_code or not email:
        raise ValueError("缺少组织或邮箱")
    with connect() as conn:
        org = conn.execute(
            "SELECT id,seat_limit,status FROM orgs WHERE code=?", (org_code,)
        ).fetchone()
        if not org or str(org["status"]) != "active":
            raise ValueError("组织不存在或已停用")
        user = conn.execute(
            "SELECT id FROM users WHERE email=?", (email,)
        ).fetchone()
        if not user:
            raise ValueError("用户不存在，请先注册")
        uid = int(user["id"])
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM org_members WHERE org_id=?",
            (int(org["id"]),),
        ).fetchone()
        n = int(used["n"] if used else 0)
        if n >= int(org["seat_limit"]):
            raise ValueError("席位已满")
        existing = conn.execute(
            "SELECT org_id FROM org_members WHERE user_id=?", (uid,)
        ).fetchone()
        if existing:
            if int(existing["org_id"]) == int(org["id"]):
                return {"ok": True, "email": email, "org": org_code, "note": "已在组织内"}
            raise ValueError("用户已属于其他组织")
        conn.execute(
            "INSERT INTO org_members(org_id,user_id,role,created_at) VALUES(?,?,?,?)",
            (int(org["id"]), uid, role, time.time()),
        )
        conn.commit()
    return {"ok": True, "email": email, "org": org_code, "role": role}


def remove_member(email: str) -> dict[str, Any]:
    init_db()
    email = (email or "").strip().lower()
    if not email:
        raise ValueError("缺少邮箱")
    with connect() as conn:
        user = conn.execute(
            "SELECT id FROM users WHERE email=?", (email,)
        ).fetchone()
        if not user:
            raise ValueError("用户不存在")
        cur = conn.execute(
            "DELETE FROM org_members WHERE user_id=?", (int(user["id"]),)
        )
        conn.commit()
        if cur.rowcount < 1:
            raise ValueError("用户未加入组织")
    return {"ok": True, "email": email}
