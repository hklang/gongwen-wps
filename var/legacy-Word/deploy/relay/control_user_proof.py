# -*- coding: utf-8 -*-
"""用户校对词库/数字表（按账号隔离；非文稿仓）。"""
from __future__ import annotations

import hashlib
import json
import re
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
MAX_SNIPPET = 4000
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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


def _snippet_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _day_str(raw: Any, ts: float) -> str:
    s = str(raw or "").strip()
    if _DAY_RE.match(s):
        return s
    return time.strftime("%Y-%m-%d", time.localtime(ts or time.time()))


def _fact_from_row(r: Any) -> dict[str, Any]:
    keys = set(r.keys())
    snippet = str(r["snippet"] or "").strip() if "snippet" in keys else ""
    value = r["value"] or ""
    recorded = ""
    if snippet and _DAY_RE.match(str(value).strip()):
        recorded = str(value).strip()
    elif "created_at" in keys and r["created_at"]:
        recorded = time.strftime("%Y-%m-%d", time.localtime(float(r["created_at"])))
    return {
        "id": int(r["id"]),
        "label": r["label"] or "",
        "value": value,
        "unit": r["unit"] or "",
        "aliases": _aliases_load(r["aliases"] or "") if "aliases" in keys else [],
        "snippet": snippet,
        "recorded_at": recorded,
    }


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
            "SELECT id,label,value,unit,aliases,snippet,created_at FROM user_proof_facts"
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
        "facts": [_fact_from_row(r) for r in facts],
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
            (
                {
                    "snippet": x["snippet"],
                    "recorded_at": x.get("recorded_at") or "",
                }
                if x.get("snippet")
                else {
                    "label": x["label"],
                    "value": x["value"],
                    "unit": x.get("unit") or "",
                    "aliases": x.get("aliases") or [],
                }
            )
            for x in data["facts"]
            if x.get("snippet") or (x.get("label") and x.get("value"))
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
        raise ValueError("没有可收入的原文")
    out: list[dict[str, Any]] = []
    now = time.time()
    with connect() as conn:
        n = int(
            conn.execute(
                "SELECT COUNT(*) AS c FROM user_proof_facts WHERE user_id=?", (uid,)
            ).fetchone()["c"]
        )
        for it in items[:MAX_FACTS]:
            if not isinstance(it, dict):
                continue
            saved = _upsert_fact(conn, uid, it, n, now)
            if not saved:
                continue
            item, n = saved
            out.append(item)
    if not out:
        raise ValueError("没有可收入的原文")
    return {"ok": True, "items": out}


def _fact_row(conn, uid: int, label: str):
    return conn.execute(
        "SELECT id FROM user_proof_facts WHERE user_id=? AND label=?",
        (uid, label),
    ).fetchone()


def _insert_fact(conn, uid: int, n: int, values: tuple):
    if n >= MAX_FACTS:
        raise ValueError("数据已达上限（%d）" % MAX_FACTS)
    cur = conn.execute(
        "INSERT INTO user_proof_facts"
        "(user_id,label,value,unit,aliases,snippet,created_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (uid,) + values,
    )
    return int(cur.lastrowid), n + 1


def _upsert_snippet_fact(conn, uid: int, it: dict, n: int, now: float, snippet: str):
    key = _snippet_key(snippet)
    day = _day_str(it.get("recorded_at") or it.get("date"), now)
    row = _fact_row(conn, uid, key)
    if row:
        conn.execute(
            "UPDATE user_proof_facts SET snippet=?, value=?, created_at=?"
            " WHERE id=? AND user_id=?",
            (snippet, day, now, int(row["id"]), uid),
        )
        fid = int(row["id"])
    else:
        fid, n = _insert_fact(conn, uid, n, (key, day, "", "", snippet, now))
    return ({"id": fid, "snippet": snippet, "recorded_at": day}, n)


def _upsert_label_fact(conn, uid: int, it: dict, n: int, now: float):
    label = _clip(it.get("label"), MAX_FACT_LABEL)
    value = _clip(it.get("value"), MAX_FACT_VALUE)
    unit = _clip(it.get("unit"), MAX_FACT_UNIT)
    if not label or not value:
        return None
    aliases = _aliases_dump(it.get("aliases"))
    row = _fact_row(conn, uid, label)
    if row:
        conn.execute(
            "UPDATE user_proof_facts SET value=?, unit=?, aliases=?, created_at=?"
            " WHERE id=? AND user_id=?",
            (value, unit, aliases, now, int(row["id"]), uid),
        )
        fid = int(row["id"])
    else:
        fid, n = _insert_fact(
            conn, uid, n, (label, value, unit, aliases, "", now)
        )
    return (
        {
            "id": fid,
            "label": label,
            "value": value,
            "unit": unit,
            "aliases": _aliases_load(aliases),
        },
        n,
    )


def _upsert_fact(conn, uid: int, it: dict, n: int, now: float):
    snippet = _clip(it.get("snippet") or it.get("text") or "", MAX_SNIPPET)
    if snippet:
        return _upsert_snippet_fact(conn, uid, it, n, now, snippet)
    return _upsert_label_fact(conn, uid, it, n, now)


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
        snippet = (body or {}).get("snippet") or (body or {}).get("text") or ""
        recorded = (body or {}).get("recorded_at") or (body or {}).get("date") or ""
        items = (body or {}).get("items") or (body or {}).get("facts") or []
        if str(snippet).strip():
            items = [{"snippet": snippet, "recorded_at": recorded}]
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
