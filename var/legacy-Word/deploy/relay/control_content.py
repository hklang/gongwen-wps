# -*- coding: utf-8 -*-
"""官方内容包：分类 / 手册 / 模板 / 剧本（只读下发，非用户文稿库）。"""
from __future__ import annotations

import json
import time
from typing import Any

from control_db import connect, init_db

# 云种子与扩展 DEFAULT_PLAYBOOK 对齐（改此处时同步 officialSync.js）
SUMMARY_FLOW_STAGES: list[dict[str, str]] = [
    {
        "id": "intent",
        "title": "立意",
        "hint": "先定读者与主旨；可选参照稿学口气",
        "prompt": "帮助用户明确本稿读者、主旨一句话、不写的边界。只讨论立意，勿大段正文。",
        "tab": "write",
    },
    {
        "id": "outline",
        "title": "搭架",
        "hint": "先一、二、三级标题，再填血肉",
        "prompt": "帮助搭标题骨架；输出可落稿的层级标题，少写段落正文。",
        "tab": "write",
    },
    {
        "id": "fill",
        "title": "充填",
        "hint": "据实写数，素材不足标明待核实",
        "prompt": "按已有标题充填事实与数据；无依据不编造数字；可提示需读哪些素材。",
        "tab": "write",
    },
    {
        "id": "polish",
        "title": "精修",
        "hint": "语气、条理、去套话",
        "prompt": "进入精修：按用户意见改写选区，必须有可见差异，禁原样返回。",
        "tab": "suite",
    },
    {
        "id": "proof",
        "title": "校对",
        "hint": "标点、错别字、规范用语",
        "prompt": "引导用户使用校对 Tab 做定稿检查；勿在对话里假装已完成校对引擎。",
        "tab": "proof",
    },
]


def _parse_stages(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    text = (raw or "").strip() if isinstance(raw, str) else ""
    if not text:
        return []
    try:
        data = json.loads(text)
    except Exception:
        return []
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


def _playbook_row(r) -> dict[str, Any]:
    d = dict(r)
    d["stages"] = _parse_stages(d.pop("stages_json", "[]"))
    return d


def _cat_id(conn, category_code: str) -> int:
    cat = conn.execute(
        "SELECT id FROM categories WHERE code=?", (category_code,)
    ).fetchone()
    if not cat:
        raise ValueError("分类不存在：" + category_code)
    return int(cat["id"])


def _upsert_md_row(
    table: str,
    code: str,
    title: str,
    body_md: str,
    *,
    category_code: str,
    version: str,
    published: int,
) -> dict[str, Any]:
    """手册 / 模板共用写入。"""
    init_db()
    code = (code or "").strip()
    if not code:
        raise ValueError("缺少 code")
    if table not in ("manuals", "templates"):
        raise ValueError("非法表")
    with connect() as conn:
        cid = _cat_id(conn, category_code)
        now = time.time()
        row = conn.execute(
            f"SELECT id FROM {table} WHERE code=?", (code,)
        ).fetchone()
        if row:
            conn.execute(
                f"UPDATE {table} SET category_id=?, title=?, version=?, body_md=?,"
                f" published=?, updated_at=? WHERE id=?",
                (cid, title, version, body_md or "", int(published), now, int(row["id"])),
            )
        else:
            conn.execute(
                f"INSERT INTO {table}(code,category_id,title,version,body_md,published,updated_at)"
                f" VALUES(?,?,?,?,?,?,?)",
                (code, cid, title, version, body_md or "", int(published), now),
            )
        conn.commit()
    return {"ok": True, "code": code}


def list_genres() -> dict[str, Any]:
    """宏观文种目录（无手册/模板正文），供顶栏选择。"""
    init_db()
    with connect() as conn:
        cats = conn.execute(
            "SELECT id,code,name,grp,sort FROM categories WHERE published=1 ORDER BY sort,id"
        ).fetchall()
    items = [dict(r) for r in cats]
    groups: list[str] = []
    seen = set()
    for it in items:
        g = (it.get("grp") or "其他").strip() or "其他"
        it["grp"] = g
        if g not in seen:
            seen.add(g)
            groups.append(g)
    return {"ok": True, "groups": groups, "categories": items}


def list_templates(category_code: str = "") -> dict[str, Any]:
    """按文种列出官方骨架（仅标题/摘要，无完整货架逛手册）。"""
    init_db()
    code = (category_code or "").strip()
    with connect() as conn:
        if code:
            cat = conn.execute(
                "SELECT id,code,name FROM categories WHERE code=? AND published=1",
                (code,),
            ).fetchone()
            if not cat:
                raise ValueError("未知文种")
            rows = conn.execute(
                "SELECT t.code,t.title,t.version,t.body_md,c.code AS category,c.name AS category_name"
                " FROM templates t JOIN categories c ON c.id=t.category_id"
                " WHERE t.published=1 AND t.category_id=? ORDER BY t.id",
                (int(cat["id"]),),
            ).fetchall()
            cat_info = {"code": cat["code"], "name": cat["name"]}
        else:
            rows = conn.execute(
                "SELECT t.code,t.title,t.version,t.body_md,c.code AS category,c.name AS category_name"
                " FROM templates t JOIN categories c ON c.id=t.category_id"
                " WHERE t.published=1 ORDER BY c.sort,t.id"
            ).fetchall()
            cat_info = None
    items = []
    for r in rows:
        body = (r["body_md"] or "").strip()
        blurb = body.replace("\n", " ")[:80]
        items.append(
            {
                "code": r["code"],
                "title": r["title"],
                "version": r["version"],
                "category": r["category"],
                "category_name": r["category_name"],
                "blurb": blurb + ("…" if len(body) > 80 else ""),
            }
        )
    out: dict[str, Any] = {"ok": True, "templates": items}
    if cat_info:
        out["category"] = cat_info["code"]
        out["category_name"] = cat_info["name"]
        if not items:
            # 无种子时给一条虚拟通用项，前端可预览 fallback 正文
            out["templates"] = [
                {
                    "code": "",
                    "title": cat_info["name"] + " · 通用骨架",
                    "version": "fallback",
                    "category": cat_info["code"],
                    "category_name": cat_info["name"],
                    "blurb": "一、二、三级标题通用架子",
                    "fallback": True,
                }
            ]
    return out


def get_template(template_code: str = "", category_code: str = "") -> dict[str, Any]:
    """取单份骨架全文（下载到本机模板夹用）。"""
    init_db()
    tcode = (template_code or "").strip()
    ccode = (category_code or "").strip()
    if tcode:
        with connect() as conn:
            row = conn.execute(
                "SELECT t.code,t.title,t.version,t.body_md,c.code AS category,c.name AS category_name"
                " FROM templates t JOIN categories c ON c.id=t.category_id"
                " WHERE t.published=1 AND t.code=?",
                (tcode,),
            ).fetchone()
        if not row:
            raise ValueError("未知模板")
        return {
            "ok": True,
            "code": row["code"],
            "title": row["title"],
            "version": row["version"],
            "category": row["category"],
            "category_name": row["category_name"],
            "body_md": row["body_md"] or "",
            "fallback": False,
        }
    # 无 code 时回落到文种默认
    return skeleton_for_category(ccode)


def skeleton_for_category(category_code: str) -> dict[str, Any]:
    """按文种取默认官方骨架（第一份或通用）。"""
    init_db()
    code = (category_code or "").strip()
    if not code:
        raise ValueError("缺少 category")
    with connect() as conn:
        cat = conn.execute(
            "SELECT id,code,name FROM categories WHERE code=? AND published=1",
            (code,),
        ).fetchone()
        if not cat:
            raise ValueError("未知文种")
        row = conn.execute(
            "SELECT code,title,version,body_md FROM templates"
            " WHERE published=1 AND category_id=? ORDER BY id LIMIT 1",
            (int(cat["id"]),),
        ).fetchone()
        if not row:
            body = (
                "# 【待补】标题\n\n"
                "## 一、【待补】\n\n"
                "## 二、【待补】\n\n"
                "## 三、【待补】\n\n"
            )
            return {
                "ok": True,
                "category": cat["code"],
                "category_name": cat["name"],
                "template_code": "",
                "code": "",
                "title": cat["name"] + "骨架",
                "body_md": body,
                "fallback": True,
            }
    return {
        "ok": True,
        "category": cat["code"],
        "category_name": cat["name"],
        "template_code": row["code"],
        "code": row["code"],
        "title": row["title"],
        "body_md": row["body_md"] or "",
        "fallback": False,
    }


def manual_inject_for_category(category_code: str, limit: int = 2400) -> str:
    """调模前注入：用户不可见的官方手册节选。"""
    init_db()
    code = (category_code or "").strip()
    if not code:
        return ""
    with connect() as conn:
        cat = conn.execute(
            "SELECT id,name FROM categories WHERE code=? AND published=1",
            (code,),
        ).fetchone()
        if not cat:
            return ""
        row = conn.execute(
            "SELECT title,body_md FROM manuals"
            " WHERE published=1 AND category_id=? ORDER BY id LIMIT 1",
            (int(cat["id"]),),
        ).fetchone()
    if not row:
        return "【公文文种】" + str(cat["name"]) + "（" + code + "）"
    body = (row["body_md"] or "").strip()
    slice_ = body[: max(200, int(limit))]
    return (
        "【公文文种】"
        + str(cat["name"])
        + "\n【写作规范 · "
        + str(row["title"] or "")
        + "】\n"
        + slice_
        + ("\n…(已截断)" if len(body) > len(slice_) else "")
    )


def content_pack() -> dict[str, Any]:
    init_db()
    with connect() as conn:
        cats = conn.execute(
            "SELECT id,code,name,grp,sort FROM categories WHERE published=1 ORDER BY sort,id"
        ).fetchall()
        manuals = conn.execute(
            "SELECT id,code,category_id,title,version,body_md,updated_at"
            " FROM manuals WHERE published=1 ORDER BY id"
        ).fetchall()
        templates = conn.execute(
            "SELECT id,code,category_id,title,version,body_md,updated_at"
            " FROM templates WHERE published=1 ORDER BY id"
        ).fetchall()
        playbooks = conn.execute(
            "SELECT id,code,category_id,title,version,stages_json,updated_at"
            " FROM playbooks WHERE published=1 ORDER BY id"
        ).fetchall()
    return {
        "ok": True,
        "pack_version": int(time.time()),
        "categories": [dict(r) for r in cats],
        "manuals": [dict(r) for r in manuals],
        "templates": [dict(r) for r in templates],
        "playbooks": [_playbook_row(r) for r in playbooks],
        "note": "客户端应写入本机 .gongwen/official/；禁止回传用户正文到云",
    }


def content_index() -> dict[str, Any]:
    """轻量目录（不含正文），供列表/增量判断。"""
    init_db()
    with connect() as conn:
        cats = conn.execute(
            "SELECT id,code,name,grp,sort FROM categories WHERE published=1 ORDER BY sort,id"
        ).fetchall()
        manuals = conn.execute(
            "SELECT id,code,category_id,title,version,updated_at,length(body_md) AS chars"
            " FROM manuals WHERE published=1 ORDER BY id"
        ).fetchall()
        templates = conn.execute(
            "SELECT id,code,category_id,title,version,updated_at,length(body_md) AS chars"
            " FROM templates WHERE published=1 ORDER BY id"
        ).fetchall()
        playbooks = conn.execute(
            "SELECT id,code,category_id,title,version,updated_at,"
            " length(stages_json) AS chars FROM playbooks WHERE published=1 ORDER BY id"
        ).fetchall()
    return {
        "ok": True,
        "categories": [dict(r) for r in cats],
        "manuals": [dict(r) for r in manuals],
        "templates": [dict(r) for r in templates],
        "playbooks": [dict(r) for r in playbooks],
    }


def upsert_manual(
    code: str,
    title: str,
    body_md: str,
    *,
    category_code: str = "summary",
    version: str = "1",
    published: int = 1,
) -> dict[str, Any]:
    return _upsert_md_row(
        "manuals",
        code,
        title,
        body_md,
        category_code=category_code,
        version=version,
        published=published,
    )


def upsert_template(
    code: str,
    title: str,
    body_md: str,
    *,
    category_code: str = "summary",
    version: str = "1",
    published: int = 1,
) -> dict[str, Any]:
    return _upsert_md_row(
        "templates",
        code,
        title,
        body_md,
        category_code=category_code,
        version=version,
        published=published,
    )


def upsert_playbook(
    code: str,
    title: str,
    stages: Any,
    *,
    category_code: str = "summary",
    version: str = "1",
    published: int = 1,
) -> dict[str, Any]:
    init_db()
    code = (code or "").strip()
    if not code:
        raise ValueError("缺少 code")
    stage_list = _parse_stages(stages)
    if not stage_list:
        raise ValueError("stages 不能为空")
    stages_json = json.dumps(stage_list, ensure_ascii=False)
    with connect() as conn:
        cid = _cat_id(conn, category_code)
        now = time.time()
        row = conn.execute(
            "SELECT id FROM playbooks WHERE code=?", (code,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE playbooks SET category_id=?, title=?, version=?, stages_json=?,"
                " published=?, updated_at=? WHERE id=?",
                (cid, title, version, stages_json, int(published), now, int(row["id"])),
            )
        else:
            conn.execute(
                "INSERT INTO playbooks(code,category_id,title,version,stages_json,published,updated_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (code, cid, title, version, stages_json, int(published), now),
            )
        conn.commit()
    return {"ok": True, "code": code, "stages": len(stage_list)}
