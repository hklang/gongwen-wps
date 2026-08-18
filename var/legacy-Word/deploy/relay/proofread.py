#!/usr/bin/env python3
"""公文校对：全部由模型判；用户词库/数字表只当证据。供 gongwen-relay /api/proofread。

唯一定稿路径：Word/deploy/relay/proofread.py（勿在 editor/ 复制）。
行业包从同目录 industry_proof.json 读取。无 shell。
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

_INDUSTRY_PATH = Path(__file__).resolve().parent / "industry_proof.json"

# ── 引擎清单 ──────────────────────────────────────────────

ENGINE_META = {
    "punctuation": {"name": "标点", "kind": "llm", "tier": "quick"},
    "format": {"name": "公文格式", "kind": "llm", "tier": "quick"},
    "dictionary": {"name": "词库", "kind": "llm", "tier": "quick"},
    "typo": {"name": "错别字", "kind": "llm", "tier": "quick"},
    "grammar": {"name": "语法", "kind": "llm", "tier": "quick"},
    "sensitive": {"name": "政治规范", "kind": "llm", "tier": "quick"},
    "style": {"name": "风格", "kind": "llm", "tier": "deep"},
    "logic": {"name": "逻辑", "kind": "llm", "tier": "deep"},
    "dataverify": {"name": "数据核验", "kind": "llm", "tier": "deep"},
    "duplicate": {"name": "内容重复", "kind": "llm", "tier": "deep"},
}

DEFAULT_QUICK = ["punctuation", "format", "dictionary", "typo", "grammar", "sensitive"]
DEFAULT_DEEP = ["style", "logic", "dataverify", "duplicate"]
DUP_SUGGESTION = "建议删除本处或与另一处合并"

SEGMENT_THRESHOLD = 3500
SEGMENT_OVERLAP = 120
MAX_CHARS = 20000

_SENS_HINT = {
    "strict": "严格：宁可误报不可漏报。",
    "normal": "正常：只标有明确证据的问题。",
    "relaxed": "宽松：只标确定无疑的错误。",
}

_HEADS = {
    "punctuation": (
        "你是公文标点审校。\n"
        "查：中英标点混用、标点重复、标点前后不该有的空格、明显用错的句读。\n"
        "不查：错别字、用词是否完整、语法、文风。\n"
        "小数点、英文缩写里的点、数字中的点不要报。\n"
        "用词少字、公文简称不是标点问题，不要当标点来改。"
    ),
    "format": (
        "你是公文格式审校。\n"
        "查：标题末尾不该有的句号、同一层级序号体例明显混乱、层次错乱。\n"
        "不查：错别字、标点细节、内容对错、文风、内容是否重复。\n"
        "original 只圈最小格式问题本身。\n"
        "不改写正文意思。"
    ),
    "dictionary": (
        "你是词库审校。只处理用户提供的【必须改】对照：\n"
        "文中出现左侧写法则报成右侧。表中没有的一律不报、不联想。"
    ),
    "typo": (
        "你是政务公文核稿人，本轮只查「字写错了」。\n"
        "怎么查：\n"
        "- 按句读，只圈你会用红笔改的文字错误。\n"
        "- 先分清：这里是词写错了，还是一个数、编号、单位本身。\n"
        "- 改正之后，若数量、日期、编号、百分数、单位会少掉或改掉 → 不当错字，不报。\n"
        "- 改正之后只是把词写对了、事实没变 → 可报。\n"
        "- 同一句里既有数量也有错字：数量保持原样，错字仍要报；"
        "不要因为旁边有数就整句放过。\n"
        "- 吃不准就不报。\n"
        "查：同音别字、形近别字、多字、漏字、字序颠倒、词被写断。\n"
        "不查：语法通顺、文风、格式体例、政治口径（其它引擎负责）。\n"
        "reason 只写为什么是字错、为什么不是在改数；不要复述原文和改法。"
    ),
    "grammar": (
        "你是公文语法审校。\n"
        "查：搭配不当、成分残缺或赘余、语序明显不通、主宾混乱。\n"
        "不查：错别字、标点、格式、政治口径。\n"
        "不把公文惯用简称、套话、数量表达当成语法错误。\n"
        "不润色文风、不改事实。吃不准就不报。"
    ),
    "sensitive": (
        "你是政务文稿政治规范审校。\n"
        "只检查【待校对文本】里真实出现的字句。\n"
        "查：明显不规范的提法；职务、机构张冠李戴（须原文里真有这些字）。\n"
        "不查：错别字、标点、语法、文风。\n"
        "找不到原文连续子串就不要报。无把握返回 []。"
    ),
    "style": (
        "你是公文文风顾问。\n"
        "查：套话堆砌、同一词过度重复、句子过长难读。\n"
        "可建议更具体的表述，但不改事实、不删必要口径。\n"
        "不报错别字和标点。"
    ),
    "logic": (
        "你是公文逻辑审校。\n"
        "查：前后数字或结论矛盾、因果不成立、概念混用。\n"
        "须能在原文中指出依据。无依据不报。\n"
        "不改文风、不报错别字。"
    ),
    "dataverify": (
        "你是数据核验专家。按【参考事实数据】比对文中数字和口径。\n"
        "参考是用户某日收录的原文整段，不要拆字段，不要改写收录内容。\n"
        "只在文中数字或口径与某条收录明显不一致时才报。\n"
        "reason 必须写成「与YYYY年M月D日收录的数据不一致」，并点明差在哪。\n"
        "suggestion 只改正文中出错的那一小段，不要整段替换。\n"
        "无参考或一致则不报。不把计量本身当成错别字。"
    ),
}


def _common(engine_id: str, sensitivity: str) -> str:
    sens = _SENS_HINT.get(sensitivity, _SENS_HINT["normal"])
    return (
        f"当前灵敏度：{sensitivity}（{sens}）\n"
        "核稿纪律：\n"
        "- 只依据【待校对文本】。禁止臆造、补全、引用文中没有的人名、职务、"
        "会议、机构、事项、数字。\n"
        "- original 必须是原文里连续、原样的一段，与 start/end 区间完全一致。\n"
        "- original 只圈最小出错片段，不要把未改动的前后文圈进去。\n"
        "- suggestion 必须与 original 不同；只改正这一处，不扩写、不删整句、"
        "不把稿子润色成另一版。\n"
        "- reason 只写为什么算错，一句即可；不要复述 original，不要写「应为…」。\n"
        "- 吃不准就不报。无问题返回 []。\n"
        "- 精确标注 start/end（0-based，exclusive end）。\n"
        "只输出 JSON 数组："
        '[{"type":"'
        + engine_id
        + '","original":"...","start":0,"end":0,"suggestion":"...","reason":"..."}]'
    )


def _prompt(engine_id: str, sensitivity: str) -> str:
    sens = _SENS_HINT.get(sensitivity, _SENS_HINT["normal"])
    if engine_id == "duplicate":
        return (
            "你是公文「跨段内容重复」审校。找出同一事项、同一实质内容"
            "出现在不同标题章节下的情况（一处写过，另一处又写一遍）。\n"
            f"当前灵敏度：{sensitivity}（{sens}）\n"
            "怎么查：\n"
            "- 只报跨章节、跨同级标题的实质重复或近义整段复述。\n"
            "- 不报必要呼应一句、固定套话、文种格式用语、同一节内正常展开。\n"
            "- 不臆造文中没有的事项名；original 与 peer 都必须是原文连续子串。\n"
            "- 同一对重复只报一条（一处 original，另一处 peer）。\n"
            "- suggestion 固定为「"
            + DUP_SUGGESTION
            + "」（只提示，不改写正文）。\n"
            "只输出 JSON 数组："
            '[{"type":"duplicate","original":"...","start":0,"end":0,'
            '"peer":"...","path":"一/(一)","peerPath":"三/(一)",'
            '"suggestion":"'
            + DUP_SUGGESTION
            + '","reason":"..."}]；无问题返回 []。'
        )
    return _HEADS.get(engine_id, "你是中文校对助手。") + "\n" + _common(engine_id, sensitivity)


def _dedup_overlap(errors: list[dict]) -> list[dict]:
    errors = sorted(errors, key=lambda e: (e["start"], -(e["end"] - e["start"])))
    out: list[dict] = []
    for e in errors:
        if out and e["start"] < out[-1]["end"]:
            continue
        out.append(e)
    return out


# ── 分段 / 位置校正 / 合并 ────────────────────────────────

def split_segments(text: str) -> list[tuple[str, int]]:
    if len(text) <= SEGMENT_THRESHOLD:
        return [(text, 0)]
    segs: list[tuple[str, int]] = []
    pos = 0
    while pos < len(text):
        end = min(pos + SEGMENT_THRESHOLD, len(text))
        if end < len(text):
            para = text.rfind("\n\n", pos, end)
            if para > pos + SEGMENT_THRESHOLD * 0.55:
                end = para + 2
            else:
                cuts = [text.rfind(c, pos, end) for c in "。！？"]
                cut = max(cuts)
                if cut > pos + SEGMENT_THRESHOLD * 0.55:
                    end = cut + 1
        segs.append((text[pos:end], pos))
        nxt = end - SEGMENT_OVERLAP
        if nxt <= pos:
            nxt = end
        pos = nxt
    return segs


def correct_positions(errors: list[dict], text: str) -> list[dict]:
    fixed: list[dict] = []
    for err in errors:
        start = int(err.get("start") or 0)
        end = int(err.get("end") or 0)
        original = str(err.get("original") or "")
        suggestion = str(err.get("suggestion") or "")
        if not original or original == suggestion:
            continue
        if 0 <= start < end <= len(text) and text[start:end] == original:
            fixed.append({**err, "start": start, "end": end, "original": original, "suggestion": suggestion})
            continue
        best, dist, search = -1, 10**9, 0
        while True:
            idx = text.find(original, search)
            if idx < 0:
                break
            d = abs(idx - start)
            if d < dist:
                best, dist = idx, d
            search = idx + 1
        if best >= 0:
            fixed.append({
                **err,
                "start": best,
                "end": best + len(original),
                "original": original,
                "suggestion": suggestion,
            })
    return fixed


def filter_whitelist(errors: list[dict], whitelist: list[str]) -> list[dict]:
    if not whitelist:
        return errors
    out = []
    for e in errors:
        o = e.get("original") or ""
        if any(w and (w in o or o in w) for w in whitelist):
            continue
        out.append(e)
    return out


def _overlaps(a: dict, b: dict) -> bool:
    return not (int(a["end"]) <= int(b["start"]) or int(a["start"]) >= int(b["end"]))


def deterministic_merge(errors: list[dict], text: str) -> list[dict]:
    """重叠只留最短片段，禁止把整段并成一条。"""
    if len(errors) <= 1:
        return errors
    ranked = sorted(
        errors,
        key=lambda e: (int(e["end"]) - int(e["start"]), int(e["start"])),
    )
    kept: list[dict] = []
    for raw in ranked:
        e = dict(raw)
        if any(_overlaps(e, x) for x in kept):
            continue
        e["sources"] = e.get("sources") or [e.get("type")]
        kept.append(e)
    return _dedup_overlap(sorted(kept, key=lambda e: int(e["start"])))


def parse_llm_errors(content: str, engine_id: str) -> list[dict]:
    raw = (content or "").strip()
    try:
        parsed = json.loads(raw)
    except Exception:
        m = re.search(r"\[[\s\S]*\]", raw)
        if not m:
            return []
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            return []
    if isinstance(parsed, dict):
        parsed = parsed.get("errors") or parsed.get("result") or []
    if not isinstance(parsed, list):
        return []
    out = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        row = {
            "type": engine_id,
            "original": str(item.get("original") or ""),
            "start": int(item.get("start") or 0),
            "end": int(item.get("end") or 0),
            "suggestion": str(item.get("suggestion") or ""),
            "reason": str(item.get("reason") or "")[:200],
            "category": item.get("category"),
        }
        if engine_id == "duplicate":
            peer = str(item.get("peer") or item.get("peerOriginal") or "").strip()
            if peer:
                row["peer"] = peer[:500]
            path = str(item.get("path") or "").strip()
            peer_path = str(item.get("peerPath") or item.get("peer_path") or "").strip()
            if path:
                row["path"] = path[:80]
            if peer_path:
                row["peerPath"] = peer_path[:80]
            if not row["suggestion"] or row["suggestion"] == row["original"]:
                row["suggestion"] = DUP_SUGGESTION
        out.append(row)
    return out


def _run_llm_engine(
    text: str,
    engine_id: str,
    *,
    sensitivity: str,
    facts_block: str,
    mustfix_block: str,
    whitelist_block: str,
    provider: str | None,
    model: str | None,
) -> list[dict]:
    import suggest

    prompt = _prompt(engine_id, sensitivity)
    if whitelist_block:
        prompt += "\n\n【别再报这些】" + whitelist_block + "。专名或口径，不是错误。"
    if engine_id == "dictionary":
        if not mustfix_block:
            return []
        prompt += "\n\n【必须改】文中出现左侧写法，报成右侧：\n" + mustfix_block
    if engine_id == "dataverify" and facts_block:
        prompt += "\n\n【参考事实数据】\n" + facts_block
    elif engine_id == "dataverify" and not facts_block:
        return []

    segs = [(text, 0)] if engine_id == "duplicate" else split_segments(text)
    all_err: list[dict] = []
    for seg_text, offset in segs:
        msgs = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": "待校对文本：\n" + seg_text},
        ]
        try:
            content = suggest._chat(
                msgs, temperature=0.1, provider=provider, model=model
            )
        except Exception:
            continue
        for e in parse_llm_errors(content, engine_id):
            e["start"] = int(e["start"]) + offset
            e["end"] = int(e["end"]) + offset
            all_err.append(e)
    return correct_positions(all_err, text)


def _cn_day(s: str) -> str:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(s or "").strip())
    if not m:
        return str(s or "").strip() or "未知日期"
    return "%s年%s月%s日" % (m.group(1), int(m.group(2)), int(m.group(3)))


def _facts_block(facts: list[dict] | None) -> str:
    if not facts:
        return ""
    lines = []
    for it in facts[:40]:
        if not isinstance(it, dict):
            continue
        snippet = str(it.get("snippet") or "").strip()[:2000]
        if snippet:
            day = _cn_day(str(it.get("recorded_at") or it.get("date") or ""))
            lines.append("- 【%s收录】\n%s" % (day, snippet))
            continue
        label = str(it.get("label") or "").strip()
        value = str(it.get("value") or "").strip()
        if not label or not value:
            continue
        unit = str(it.get("unit") or "").strip()
        aliases = it.get("aliases") if isinstance(it.get("aliases"), list) else []
        alias_s = "、".join(str(a) for a in aliases if a)[:80]
        line = f"- {label}: {value}{unit}"
        if alias_s:
            line += f"（也写作：{alias_s}）"
        lines.append(line)
    return "\n".join(lines)


def _mustfix_block(mustfix: list[dict] | None) -> str:
    lines = []
    for it in mustfix or []:
        if not isinstance(it, dict):
            continue
        w = str(it.get("wrong") or it.get("original") or "").strip()
        r = str(
            it.get("right") or it.get("replacement") or it.get("suggestion") or ""
        ).strip()
        if w and r and w != r:
            lines.append("- %s → %s" % (w, r))
    return "\n".join(lines[:80])


def load_industry_pack() -> dict[str, Any]:
    empty: dict[str, Any] = {"whitelist": [], "mustfix": []}
    try:
        raw = json.loads(_INDUSTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return empty
    if not isinstance(raw, dict):
        return empty
    wl = raw.get("whitelist") if isinstance(raw.get("whitelist"), list) else []
    mf = raw.get("mustfix") if isinstance(raw.get("mustfix"), list) else []
    return {
        "whitelist": [str(w).strip() for w in wl if str(w).strip()][:80],
        "mustfix": [x for x in mf if isinstance(x, dict)][:80],
    }


def merge_industry_pack(
    whitelist: list[str] | None,
    mustfix: list[dict] | None,
    *,
    enabled: bool = True,
    pack: dict | None = None,
) -> tuple[list[str], list[dict]]:
    user_wl = [str(w).strip() for w in (whitelist or []) if str(w).strip()]
    user_mf = [x for x in (mustfix or []) if isinstance(x, dict)]
    if not enabled:
        return user_wl, user_mf
    src = pack if isinstance(pack, dict) else load_industry_pack()
    seen_w = set(user_wl)
    for w in src.get("whitelist") or []:
        s = str(w).strip()
        if s and s not in seen_w:
            user_wl.append(s)
            seen_w.add(s)
    seen_m: set[str] = set()
    for it in user_mf:
        w = str(it.get("wrong") or it.get("original") or "").strip()
        if w:
            seen_m.add(w)
    extra: list[dict] = []
    for it in src.get("mustfix") or []:
        if not isinstance(it, dict):
            continue
        w = str(it.get("wrong") or "").strip()
        r = str(it.get("right") or "").strip()
        if w and r and w != r and w not in seen_m:
            extra.append({"wrong": w, "right": r})
            seen_m.add(w)
    return user_wl, user_mf + extra


def _keep_grounded(merged: list[dict], text: str) -> list[dict]:
    """original 必须是原文子串（防模型串稿/臆造）。"""
    kept: list[dict] = []
    for e in merged:
        orig = str(e.get("original") or "")
        if not orig or orig not in text:
            continue
        if e.get("type") == "duplicate":
            peer = str(e.get("peer") or "")
            if peer and peer not in text:
                e = dict(e)
                e.pop("peer", None)
            if not e.get("suggestion") or e.get("suggestion") == orig:
                e = dict(e)
                e["suggestion"] = DUP_SUGGESTION
            kept.append(e)
            continue
        if e.get("suggestion") != orig:
            kept.append(e)
    return kept


def proofread(
    text: str,
    engines: list[str] | None = None,
    *,
    sensitivity: str = "normal",
    whitelist: list[str] | None = None,
    mustfix: list[dict] | None = None,
    facts: list[dict] | None = None,
    industry_pack: bool = True,
    provider: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    import time

    t0 = time.time()
    text = str(text or "")
    if not text.strip():
        raise ValueError("待校对文本为空")
    if len(text) > MAX_CHARS:
        raise ValueError(f"单次最多 {MAX_CHARS} 字，当前 {len(text)}")

    sens = sensitivity if sensitivity in ("strict", "normal", "relaxed") else "normal"
    eng = [e for e in (engines or DEFAULT_QUICK) if e in ENGINE_META]
    if not eng:
        eng = list(DEFAULT_QUICK)
    wl, mf = merge_industry_pack(
        whitelist, mustfix, enabled=bool(industry_pack)
    )
    facts_block = _facts_block(facts)
    mustfix_block = _mustfix_block(mf)
    whitelist_block = "、".join(wl[:80])

    by_engine: dict[str, int] = {}
    raw: list[dict] = []
    failed: list[dict] = []

    with ThreadPoolExecutor(max_workers=min(4, max(1, len(eng)))) as pool:
        futs = {
            pool.submit(
                _run_llm_engine,
                text,
                eid,
                sensitivity=sens,
                facts_block=facts_block,
                mustfix_block=mustfix_block,
                whitelist_block=whitelist_block,
                provider=provider,
                model=model,
            ): eid
            for eid in eng
        }
        for fut in as_completed(futs):
            eid = futs[fut]
            try:
                errs = filter_whitelist(fut.result(), wl)
                by_engine[eid] = len(errs)
                raw.extend(errs)
            except Exception as e:
                failed.append({"engineId": eid, "error": str(e)})
                by_engine.setdefault(eid, 0)

    # 内容重复不与邻近错敏合并，否则会丢 peer / 路径
    raw_dups = [e for e in raw if e.get("type") == "duplicate"]
    raw_rest = [e for e in raw if e.get("type") != "duplicate"]
    merged = correct_positions(deterministic_merge(raw_rest, text), text)
    merged.extend(correct_positions(raw_dups, text))
    merged = _keep_grounded(merged, text)
    duration = int((time.time() - t0) * 1000)
    return {
        "ok": True,
        "success": True,
        "results": merged,
        "checkedText": text,
        "summary": {
            "totalErrors": len(merged),
            "byEngine": by_engine,
            "duration": duration,
            "charCount": len(text),
        },
        "failedEngines": failed,
        "enginesMeta": {
            k: {"name": v["name"], "tier": v["tier"]} for k, v in ENGINE_META.items()
        },
    }


def engines_catalog() -> dict:
    return {
        "ok": True,
        "engines": [
            {"id": k, "name": v["name"], "kind": v["kind"], "tier": v["tier"]}
            for k, v in ENGINE_META.items()
        ],
        "defaultQuick": DEFAULT_QUICK,
        "defaultDeep": DEFAULT_DEEP,
    }


def extract_facts(
    text: str,
    *,
    provider: str | None = None,
    model: str | None = None,
) -> list[dict]:
    """从选区抽对照数字，供人确认后入库。无数字返回 []。"""
    import suggest

    src = str(text or "").strip()
    if not src:
        raise ValueError("请划选含数字的正文")
    if len(src) > 8000:
        raise ValueError("选区过长，请划一小段再收入")
    msgs = [
        {
            "role": "system",
            "content": (
                "从公文选区抽出可对照的数字条目。只输出 JSON 数组："
                '[{"label":"营收","value":"12.3","unit":"亿元"}]。'
                "label 用短名；value 保留原文数字；unit 可空。"
                "禁止编造选区没有的数；无数返回 []。"
            ),
        },
        {"role": "user", "content": "选区：\n" + src},
    ]
    try:
        content = suggest._chat(
            msgs, temperature=0.1, provider=provider, model=model
        )
    except Exception as e:
        raise ValueError("抽取失败：" + str(e)) from e
    raw = (content or "").strip()
    try:
        parsed = json.loads(raw)
    except Exception:
        m = re.search(r"\[[\s\S]*\]", raw)
        try:
            parsed = json.loads(m.group(0)) if m else []
        except Exception:
            parsed = []
    if isinstance(parsed, dict):
        parsed = parsed.get("items") or parsed.get("facts") or []
    if not isinstance(parsed, list):
        return []
    out: list[dict] = []
    for it in parsed[:40]:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()[:40]
        value = str(it.get("value") or "").strip()[:40]
        unit = str(it.get("unit") or "").strip()[:16]
        if label and value:
            out.append({"label": label, "value": value, "unit": unit})
    return out
