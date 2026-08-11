# -*- coding: utf-8 -*-
"""配额检查、用量记账、模型路由解析。"""
from __future__ import annotations

import random
import time
from typing import Any

from control_auth import CAPABILITY_LABELS
from control_db import connect, init_db


def resolve_route(capability: str, task: str) -> dict[str, str] | None:
    init_db()
    cap = (capability or "fast").strip() or "fast"
    task = (task or "chat").strip() or "chat"
    with connect() as conn:
        rows = conn.execute(
            "SELECT provider,model,weight FROM model_routes"
            " WHERE enabled=1 AND capability=? AND task=?",
            (cap, task),
        ).fetchall()
        if not rows:
            rows = conn.execute(
                "SELECT provider,model,weight FROM model_routes"
                " WHERE enabled=1 AND capability=? AND task='chat'",
                (cap,),
            ).fetchall()
        if not rows:
            return None
        weights = [max(1, int(r["weight"] or 1)) for r in rows]
        pick = random.choices(list(rows), weights=weights, k=1)[0]
        return {"provider": str(pick["provider"]), "model": str(pick["model"]), "capability": cap}


def _count_usage(conn, user_id: int, since: float) -> int:
    row = conn.execute(
        "SELECT COUNT(1) AS c FROM usage_events WHERE user_id=? AND created_at>=? AND ok=1",
        (user_id, since),
    ).fetchone()
    return int(row["c"] if row else 0)


def check_quota(access: dict[str, Any], capability: str, chars_in: int) -> None:
    """超额抛 ValueError（由上层变成 402）。"""
    init_db()
    uid = int(access["uid"])
    caps = list(access.get("caps") or [])
    cap = (capability or "fast").strip() or "fast"
    if cap == "proof":
        need = "proof" if "proof" in caps else ("fast" if "fast" in caps else None)
        if need is None and "strong" not in caps:
            raise ValueError("当前套餐不含校对能力")
    elif cap not in caps:
        raise ValueError("当前套餐不含该能力档（" + ("增强" if cap == "strong" else "标准") + "）")

    with connect() as conn:
        row = conn.execute(
            """
            SELECT p.monthly_requests, p.daily_requests, p.max_chars, s.expire_at
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.user_id=?
            """,
            (uid,),
        ).fetchone()
        if not row or float(row["expire_at"]) < time.time():
            raise ValueError("订阅已过期")
        max_chars = int(row["max_chars"] or 0)
        if max_chars and chars_in > max_chars:
            raise ValueError(f"单次最多 {max_chars} 字，当前 {chars_in}")
        now = time.time()
        day = _count_usage(conn, uid, now - 86400)
        month = _count_usage(conn, uid, now - 30 * 86400)
        if day >= int(row["daily_requests"]):
            raise ValueError("今日智能额度已用完")
        if month >= int(row["monthly_requests"]):
            raise ValueError("本月智能额度已用完")


def record_usage(
    user_id: int,
    api: str,
    capability: str,
    *,
    chars_in: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    ms: int = 0,
    ok: bool = True,
) -> None:
    init_db()
    with connect() as conn:
        conn.execute(
            "INSERT INTO usage_events(user_id,api,capability,tokens_in,tokens_out,chars_in,ms,ok,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (
                int(user_id),
                api,
                capability or "",
                int(tokens_in),
                int(tokens_out),
                int(chars_in),
                int(ms),
                1 if ok else 0,
                time.time(),
            ),
        )
        conn.commit()


def quota_snapshot(access: dict[str, Any]) -> dict[str, Any]:
    init_db()
    uid = int(access["uid"])
    with connect() as conn:
        row = conn.execute(
            """
            SELECT p.code, p.name, p.monthly_requests, p.daily_requests, p.max_chars, p.capabilities, s.expire_at
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.user_id=?
            """,
            (uid,),
        ).fetchone()
        now = time.time()
        used_day = _count_usage(conn, uid, now - 86400)
        used_month = _count_usage(conn, uid, now - 30 * 86400)
    if not row:
        return {"ok": True, "plan": None, "used_day": used_day, "used_month": used_month}
    return {
        "ok": True,
        "plan": {
            "code": row["code"],
            "name": row["name"],
            "monthly_requests": int(row["monthly_requests"]),
            "daily_requests": int(row["daily_requests"]),
            "max_chars": int(row["max_chars"]),
            "capabilities": [c for c in str(row["capabilities"]).split(",") if c],
            "expire_at": float(row["expire_at"]),
        },
        "used_day": used_day,
        "used_month": used_month,
        "remain_day": max(0, int(row["daily_requests"]) - used_day),
        "remain_month": max(0, int(row["monthly_requests"]) - used_month),
        "capability_labels": dict(CAPABILITY_LABELS),
    }


def list_routes() -> list[dict[str, Any]]:
    init_db()
    with connect() as conn:
        rows = conn.execute(
            "SELECT id,capability,task,provider,model,weight,enabled FROM model_routes ORDER BY capability,task,id"
        ).fetchall()
    return [dict(r) for r in rows]


def prune_usage(retain_days: int = 90) -> int:
    """按拍板保留审计/用量元数据天数，删除更早记录。"""
    init_db()
    cutoff = time.time() - max(1, int(retain_days)) * 86400
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM usage_events WHERE created_at<?", (cutoff,)
        )
        conn.commit()
        return int(cur.rowcount)


def upsert_route(
    capability: str,
    task: str,
    provider: str,
    model: str,
    *,
    weight: int = 100,
    enabled: int = 1,
    exclusive: bool = False,
) -> None:
    """写入一条路由。exclusive=True 时关闭同 capability+task 的其它条目（热切换）。"""
    init_db()
    with connect() as conn:
        if exclusive and int(enabled):
            conn.execute(
                "UPDATE model_routes SET enabled=0 WHERE capability=? AND task=?"
                " AND NOT (provider=? AND model=?)",
                (capability, task, provider, model),
            )
        row = conn.execute(
            "SELECT id FROM model_routes WHERE capability=? AND task=? AND provider=? AND model=?",
            (capability, task, provider, model),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE model_routes SET weight=?, enabled=? WHERE id=?",
                (int(weight), int(enabled), int(row["id"])),
            )
        else:
            conn.execute(
                "INSERT INTO model_routes(capability,task,provider,model,weight,enabled) VALUES(?,?,?,?,?,?)",
                (capability, task, provider, model, int(weight), int(enabled)),
            )
        conn.commit()
