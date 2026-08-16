# -*- coding: utf-8 -*-
"""用户校对词库/数字表（按账号隔离；非文稿仓）。"""
from __future__ import annotations

import json
import time
from typing import Any

from control_db import connect, init_db

MAX_WHITELIST = 200
MAX_MUSTFIX = 200
MAX_FACTS = 40
MAX_WORD = 40
MAX_FACT_LABEL = 40
MAX_FACT_VALUE = 40
MAX_FACT_UNIT = 16


def _uid(user_id: int) -> int:
    uid = int(user_id or 0)
    if uid <= 0:
        raise ValueError("需要登录账号")
    return uid


def _clip(s: Any, n: int) -> str:
    return str(s or "").strip()[:n]


def _aliases_dump(raw: Any) -> str:
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace("、", ",").split(",") if p.strip()]
    elif isinstance(raw, list):
        parts = [str(x).strip() for x in raw if str(x).strip()]
    else:
        parts = []
    parts = parts[:8]
    return json.dumps(parts, ensure_ascii=False) if parts else ""


def _aliases_load(raw: str) -> list[str]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()][:8]
    except Exception:
        pass
    return [p.strip() for p in text.split(",") if p.strip()][:8]


def list_user_proof(user_id: int) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    with connect() as conn:
        wl = conn.execute(
            "SELECT id,word FROM user_proof_whitelist WHERE user_id=? ORDER BY id DESC",
            (uid,),
        ).fetchall()
        mf = conn.execute(
            "SELECT id,wrong,right FROM user_proof_mustfix WHERE user_id=? ORDER BY id DESC",
            (uid,),
        ).fetchall()
        facts = conn.execute(
            "SELECT id,label,value,unit,aliases FROM user_proof_facts"
            " WHERE user_id=? ORDER BY id DESC",
            (uid,),
        ).fetchall()
    return {
        "ok": True,
        "whitelist": [{"id": int(r["id"]), "word": r["word"] or ""} for r in wl],
        "mustfix": [
            {"id": int(r["id"]), "wrong": r["wrong"] or "", "right": r["right"] or ""}
            for r in mf
        ],
        "facts": [
            {
                "id": int(r["id"]),
                "label": r["label"] or "",
                "value": r["value"] or "",
                "unit": r["unit"] or "",
                "aliases": _aliases_load(r["aliases"] or ""),
            }
            for r in facts
        ],
        "limit": {
            "whitelist": MAX_WHITELIST,
            "mustfix": MAX_MUSTFIX,
            "facts": MAX_FACTS,
        },
    }


def pack_for_proofread(user_id: int) -> dict[str, Any]:
    data = list_user_proof(user_id)
    return {
        "whitelist": [x["word"] for x in data["whitelist"] if x.get("word")],
        "mustfix": [
            {"wrong": x["wrong"], "right": x["right"]}
            for x in data["mustfix"]
            if x.get("wrong") and x.get("right")
        ],
        "facts": [
            {
                "label": x["label"],
                "value": x["value"],
                "unit": x.get("unit") or "",
                "aliases": x.get("aliases") or [],
            }
            for x in data["facts"]
            if x.get("label") and x.get("value")
        ],
    }


def add_whitelist(user_id: int, word: str) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    w = _clip(word, MAX_WORD)
    if not w:
        raise ValueError("请划选要收入的词")
    with connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM user_proof_whitelist WHERE user_id=?", (uid,)
        ).fetchone()["c"]
        row = conn.execute(
            "SELECT id,word FROM user_proof_whitelist WHERE user_id=? AND word=?",
            (uid, w),
        ).fetchone()
        if row:
            return {"ok": True, "item": {"id": int(row["id"]), "word": row["word"]}}
        if int(n) >= MAX_WHITELIST:
            raise ValueError("白名单已达上限（%d）" % MAX_WHITELIST)
        cur = conn.execute(
            "INSERT INTO user_proof_whitelist(user_id,word,created_at) VALUES(?,?,?)",
            (uid, w, time.time()),
        )
        return {"ok": True, "item": {"id": int(cur.lastrowid), "word": w}}


def add_mustfix(user_id: int, wrong: str, right: str) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    w = _clip(wrong, MAX_WORD)
    r = _clip(right, MAX_WORD)
    if not w or not r:
        raise ValueError("需要错误写法和正确写法")
    if w == r:
        raise ValueError("对错相同，不必收入")
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM user_proof_mustfix WHERE user_id=? AND wrong=?",
            (uid, w),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE user_proof_mustfix SET right=?, created_at=? WHERE id=? AND user_id=?",
                (r, time.time(), int(row["id"]), uid),
            )
            return {
                "ok": True,
                "item": {"id": int(row["id"]), "wrong": w, "right": r},
            }
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM user_proof_mustfix WHERE user_id=?", (uid,)
        ).fetchone()["c"]
        if int(n) >= MAX_MUSTFIX:
            raise ValueError("必改表已达上限（%d）" % MAX_MUSTFIX)
        cur = conn.execute(
            "INSERT INTO user_proof_mustfix(user_id,wrong,right,created_at)"
            " VALUES(?,?,?,?)",
            (uid, w, r, time.time()),
        )
        return {
            "ok": True,
            "item": {"id": int(cur.lastrowid), "wrong": w, "right": r},
        }


def add_facts(user_id: int, items: list[dict]) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    if not isinstance(items, list) or not items:
        raise ValueError("没有可收入的数字")
    out: list[dict[str, Any]] = []
    with connect() as conn:
        n = int(
            conn.execute(
                "SELECT COUNT(*) AS c FROM user_proof_facts WHERE user_id=?", (uid,)
            ).fetchone()["c"]
        )
        for it in items[:MAX_FACTS]:
            if not isinstance(it, dict):
                continue
            label = _clip(it.get("label"), MAX_FACT_LABEL)
            value = _clip(it.get("value"), MAX_FACT_VALUE)
            unit = _clip(it.get("unit"), MAX_FACT_UNIT)
            if not label or not value:
                continue
            aliases = _aliases_dump(it.get("aliases"))
            row = conn.execute(
                "SELECT id FROM user_proof_facts WHERE user_id=? AND label=?",
                (uid, label),
            ).fetchone()
            if row:
                conn.execute(
                    "UPDATE user_proof_facts SET value=?, unit=?, aliases=?, created_at=?"
                    " WHERE id=? AND user_id=?",
                    (value, unit, aliases, time.time(), int(row["id"]), uid),
                )
                fid = int(row["id"])
            else:
                if n >= MAX_FACTS:
                    raise ValueError("数字表已达上限（%d）" % MAX_FACTS)
                cur = conn.execute(
                    "INSERT INTO user_proof_facts"
                    "(user_id,label,value,unit,aliases,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (uid, label, value, unit, aliases, time.time()),
                )
                fid = int(cur.lastrowid)
                n += 1
            out.append(
                {
                    "id": fid,
                    "label": label,
                    "value": value,
                    "unit": unit,
                    "aliases": _aliases_load(aliases),
                }
            )
    if not out:
        raise ValueError("没有可收入的数字")
    return {"ok": True, "items": out}


def delete_item(user_id: int, kind: str, item_id: int) -> dict[str, Any]:
    init_db()
    uid = _uid(user_id)
    tid = int(item_id or 0)
    if tid <= 0:
        raise ValueError("缺少 id")
    kind = str(kind or "").strip()
    if kind == "whitelist":
        sql = "DELETE FROM user_proof_whitelist WHERE id=? AND user_id=?"
    elif kind == "mustfix":
        sql = "DELETE FROM user_proof_mustfix WHERE id=? AND user_id=?"
    elif kind == "facts":
        sql = "DELETE FROM user_proof_facts WHERE id=? AND user_id=?"
    else:
        raise ValueError("未知 kind：whitelist|mustfix|facts")
    with connect() as conn:
        cur = conn.execute(sql, (tid, uid))
        if cur.rowcount < 1:
            raise ValueError("条目不存在")
    return {"ok": True, "id": tid, "kind": kind}


def handle_post(user_id: int, body: dict, *, provider=None, model=None) -> dict[str, Any]:
    op = str((body or {}).get("op") or (body or {}).get("action") or "").lower()
    if op in ("add_whitelist", "whitelist"):
        return add_whitelist(user_id, (body or {}).get("word") or "")
    if op in ("add_mustfix", "mustfix"):
        return add_mustfix(
            user_id,
            (body or {}).get("wrong") or (body or {}).get("original") or "",
            (body or {}).get("right") or (body or {}).get("suggestion") or "",
        )
    if op in ("add_facts", "facts"):
        items = (body or {}).get("items") or (body or {}).get("facts") or []
        return add_facts(user_id, items if isinstance(items, list) else [])
    if op == "delete":
        return delete_item(
            user_id,
            (body or {}).get("kind") or "",
            int((body or {}).get("id") or 0),
        )
    if op == "extract_facts":
        import proofread as pr

        items = pr.extract_facts(
            (body or {}).get("text") or "",
            provider=provider,
            model=model,
        )
        return {"ok": True, "items": items}
    raise ValueError("未知 op：add_whitelist|add_mustfix|add_facts|delete|extract_facts")
