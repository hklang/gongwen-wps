#!/usr/bin/env python3
"""公文校对：本地规则 + 多引擎 LLM，供 gongwen-relay /api/proofread。

唯一定稿路径：Word/deploy/relay/proofread.py（勿在 editor/ 复制）。
对标 word4 的问题列表模型；无文件读写、无 shell。
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

# ── 引擎清单 ──────────────────────────────────────────────

ENGINE_META = {
    "punctuation": {"name": "标点", "kind": "local", "tier": "quick"},
    "format": {"name": "公文格式", "kind": "local", "tier": "quick"},
    "dictionary": {"name": "词库", "kind": "local", "tier": "quick"},
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


def _prompt(engine_id: str, sensitivity: str) -> str:
    sens = _SENS_HINT.get(sensitivity, _SENS_HINT["normal"])
    if engine_id == "duplicate":
        return (
            "你是公文「跨段内容重复」审校。任务：找出同一事项/同一实质内容"
            "出现在不同标题章节下的情况（一个内容不该在两个地方各写一遍）。\n"
            f"当前灵敏度：{sensitivity}（{sens}）\n"
            "规则：\n"
            "- 只报跨章节/跨同级标题的实质重复或近义整段复述；\n"
            "- 不报必要呼应一句、固定套话、文种格式用语、同一节内正常展开；\n"
            "- 不臆造文中没有的事项名；original 与 peer 都必须是原文连续子串；\n"
            "- 同一对重复只报一条（取一处为 original，另一处为 peer）；\n"
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
    common = (
        f"当前灵敏度：{sensitivity}（{sens}）\n"
        "要求：精确标注 start/end（0-based，exclusive end）；"
        "original 必须与原文该区间完全一致；"
        "suggestion 必须与 original 不同；无问题返回 []。\n"
        "只输出 JSON 数组："
        '[{"type":"'
        + engine_id
        + '","original":"...","start":0,"end":0,"suggestion":"...","reason":"..."}]'
    )
    heads = {
        "typo": (
            "你是中文错别字校对助手。查同音字、形近字、明显笔误；"
            "汉字中间夹杂阿拉伯数字的笔误必须报（如「紧23扣」→「紧扣」）；"
            "正常数量表达不要报（如「近23年」「第2章」「共3人」）。"
        ),
        "grammar": "你是中文语法校对助手。查搭配不当、成分残缺/冗余、语序问题。",
        "sensitive": (
            "你是政务文稿政治规范审校。只检查【待校对文本】里真实出现的字句。"
            "严禁臆造、补全、引用文本中没有的人名、职务、会议或机构。"
            "original 必须是待校对文本的连续原文子串；找不到就不要报。"
            "无把握或无问题返回 []。错别字/标点不要报（其它引擎负责）。"
        ),
        "style": "你是公文文风顾问。查套话堆砌、重复用词、过长句；建议更具体表述。",
        "logic": "你是逻辑校验助手。查前后矛盾、因果不成立、概念混淆（序号由本地规则负责）。",
        "dataverify": (
            "你是数据核验专家。按参考事实比对文中数字/名称；"
            "无参考或一致则不报；不一致则标出片段并建议正确值。"
        ),
    }
    return heads.get(engine_id, "你是中文校对助手。") + "\n" + common


# ── 本地规则 ──────────────────────────────────────────────

_CN_PUNCT = "，。！？；：、"
# 句末语气 > 句号 > 分号 > 冒号 > 逗号 > 顿号
_CN_PUNCT_PRIORITY = {
    "！": 6, "？": 6,
    "。": 5,
    "；": 4,
    "：": 3,
    "，": 2,
    "、": 1,
}


def run_punctuation(text: str) -> list[dict]:
    errors: list[dict] = []

    # 连续中文标点：。。 / ，， / 。， / ，。 等 → 保留语气最强的一个
    for m in re.finditer(r"[，。！？；：、]{2,}", text):
        chunk = m.group(0)
        best = max(chunk, key=lambda c: _CN_PUNCT_PRIORITY.get(c, 0))
        if chunk == best:
            continue
        same = len(set(chunk)) == 1
        reason = (
            f"重复标点：连续 {len(chunk)} 个「{best}」"
            if same
            else f"标点连用不宜：「{chunk}」→「{best}」"
        )
        errors.append({
            "type": "punctuation",
            "original": chunk,
            "start": m.start(),
            "end": m.end(),
            "suggestion": best,
            "reason": reason,
        })

    cn = len(re.findall(r"[\u4e00-\u9fff]", text))
    if cn > len(text) * 0.3:
        for i, ch in enumerate(text):
            before = text[i - 1] if i else ""
            after = text[i + 1] if i + 1 < len(text) else ""
            if ch == "." and after != ".":
                if re.search(r"[\u4e00-\u9fff]", before + after):
                    errors.append({
                        "type": "punctuation",
                        "original": ".",
                        "start": i,
                        "end": i + 1,
                        "suggestion": "。",
                        "reason": "中英标点混用：英文句号",
                    })
            elif ch == ",":
                if re.search(r"[\u4e00-\u9fff]", before + after) and not (
                    before.isdigit() and after.isdigit()
                ):
                    errors.append({
                        "type": "punctuation",
                        "original": ",",
                        "start": i,
                        "end": i + 1,
                        "suggestion": "，",
                        "reason": "中英标点混用：英文逗号",
                    })
            elif ch == "!":
                errors.append({
                    "type": "punctuation",
                    "original": "!",
                    "start": i,
                    "end": i + 1,
                    "suggestion": "！",
                    "reason": "中英标点混用：英文感叹号",
                })
            elif ch == "?":
                errors.append({
                    "type": "punctuation",
                    "original": "?",
                    "start": i,
                    "end": i + 1,
                    "suggestion": "？",
                    "reason": "中英标点混用：英文问号",
                })

    for m in re.finditer(r"\s+[，。！？；：、]", text):
        errors.append({
            "type": "punctuation",
            "original": m.group(0),
            "start": m.start(),
            "end": m.end(),
            "suggestion": m.group(0).strip(),
            "reason": "标点前多余空格",
        })
    # 标点后紧跟另一中文标点中间夹空格：。 ，
    for m in re.finditer(r"([，。！？；：、])[ \t\u3000]+([，。！？；：、])", text):
        a, b = m.group(1), m.group(2)
        best = a if _CN_PUNCT_PRIORITY.get(a, 0) >= _CN_PUNCT_PRIORITY.get(b, 0) else b
        errors.append({
            "type": "punctuation",
            "original": m.group(0),
            "start": m.start(),
            "end": m.end(),
            "suggestion": best,
            "reason": f"标点连用不宜：「{m.group(0)}」→「{best}」",
        })
    return _dedup_overlap(errors)


def run_format(text: str) -> list[dict]:
    errors: list[dict] = []
    lines = text.split("\n")
    offset = 0
    for line in lines:
        if (
            5 < len(line) <= 40
            and re.match(r"^[^\s\d]", line)
            and re.search(r"[。！？；]$", line)
            and not re.match(
                r"^(因此|所以|但是|然而|另外|此外|同时|并且|而且|总之|综上|为此|据此|对此)",
                line,
            )
        ):
            errors.append({
                "type": "format",
                "original": line,
                "start": offset,
                "end": offset + len(line),
                "suggestion": line[:-1],
                "reason": "标题不宜以句末标点结尾",
            })
        m = re.match(r"^(\d+)[.\)]\s*", line)
        if m and len(line) < 100 and not re.search(r"[年月日]", line[:10]):
            num = int(m.group(1))
            if 1 <= num <= 12:
                cn = "一二三四五六七八九十"
                if num <= 10:
                    exp = cn[num - 1] + "、"
                elif num == 11:
                    exp = "十一、"
                else:
                    exp = "十二、"
                errors.append({
                    "type": "format",
                    "original": m.group(0).strip(),
                    "start": offset,
                    "end": offset + len(m.group(0)),
                    "suggestion": exp,
                    "reason": f"公文第一层宜用「{exp}」",
                })
        # 连续空格
        for sm in re.finditer(r" {2,}", line):
            errors.append({
                "type": "format",
                "original": sm.group(0),
                "start": offset + sm.start(),
                "end": offset + sm.end(),
                "suggestion": " ",
                "reason": "连续空格",
            })
        offset += len(line) + 1
    return _dedup_overlap(errors)


def run_dictionary(text: str, mustfix: list[dict]) -> list[dict]:
    errors: list[dict] = []
    for item in mustfix or []:
        wrong = str(item.get("wrong") or item.get("original") or "").strip()
        right = str(item.get("right") or item.get("replacement") or item.get("suggestion") or "").strip()
        if not wrong or not right or wrong == right:
            continue
        start = 0
        while True:
            idx = text.find(wrong, start)
            if idx < 0:
                break
            errors.append({
                "type": "dictionary",
                "original": wrong,
                "start": idx,
                "end": idx + len(wrong),
                "suggestion": right,
                "reason": f"词库必纠：{wrong} → {right}",
            })
            start = idx + 1
    return _dedup_overlap(errors)


# 数量语境：汉字夹数字多为「近23年 / 第2章 / 楼9层 / 证200余」，勿当笔误
# 右侧常见量词/单位/序位（宁宽勿误伤）
_NUM_UNIT_RIGHT = (
    "年|月|日|号|时|分|秒|点|成|倍|%|％|‰|"
    "个|名|人|位|项|次|届|轮|期|批|套|台|辆|家|户|所|座|"
    "章|节|条|款|项|级|类|种|页|行|列|卷|"
    "元|角|分|万|亿|吨|米|公里|千克|公斤|"
    "余|多|栋|幢|层|榀|跨|轴|间|处|片|块|根|支|件|份|册|本|篇|"
    "场|局|盘|圈|步|亩|公顷|平米|平方米|公里|米|"
    "塔|馆|室|厅|区|线|路|巷|弄|号楼|标段|标"
)
_NUM_HINT_LEFT = (
    "第|近|约|逾|达|共|计|超|不足|少于|多于|超过|低于|高于|增加|减少|增长|下降|"
    "累计|同比|环比|约为|达到|完成|实现|超过|余|至|从|满|超|近"
)

# 高置信常见错词（错 → 正）。少而稳，争议用法不进表。
_COMMON_TYPO_PAIRS: list[tuple[str, str]] = [
    ("做为", "作为"),
    ("其它", "其他"),
    ("帐号", "账号"),
    ("帐户", "账户"),
    ("按装", "安装"),
    ("既使", "即使"),
    ("即然", "既然"),
    ("再接再励", "再接再厉"),
    ("一如继往", "一如既往"),
    ("穿流不息", "川流不息"),
    ("迫不急待", "迫不及待"),
    ("走头无路", "走投无路"),
    ("直接了当", "直截了当"),
    ("不径而走", "不胫而走"),
    ("金榜提名", "金榜题名"),
    ("声名狼籍", "声名狼藉"),
    ("重迭", "重叠"),
    ("松驰", "松弛"),
    ("精萃", "精粹"),
    ("幅射", "辐射"),
    ("薰陶", "熏陶"),
    ("寒喧", "寒暄"),
    ("枯躁", "枯燥"),
    ("精减", "精简"),
    ("部置", "布置"),
    ("凑和", "凑合"),
    ("渡假", "度假"),
    ("九宵", "九霄"),
    ("幅圆辽阔", "幅员辽阔"),
    ("针贬", "针砭"),
    ("璀灿", "璀璨"),
    ("修茸", "修葺"),
    ("烩炙人口", "脍炙人口"),
    ("脏款", "赃款"),
    ("罗嗦", "啰嗦"),
    ("截止到", "截至"),
    ("报到材料", "报告材料"),
    ("反应情况", "反映情况"),
    ("反应问题", "反映问题"),
    ("登陆网站", "登录网站"),
    ("登陆系统", "登录系统"),
    ("以经", "已经"),
    ("因该", "应该"),
    ("必须品", "必需品"),
    ("供献", "贡献"),
    ("追朔", "追溯"),
    ("脉博", "脉搏"),
    ("兰球", "篮球"),
    ("兰色", "蓝色"),
    ("抽像", "抽象"),
    ("成度", "程度"),
    ("交待", "交代"),
    ("谋取暴利", "牟取暴利"),
    ("防碍", "妨碍"),
]

# 单字母馆号/线号等（心A馆、构A线）：仅大写 + 右侧为编号类名词时放行
_LETTER_LABEL_RIGHT = (
    "馆|塔|线|座|区|室|厅|栋|幢|号|路|巷|弄|楼|桥|站|井|仓|库|园|场|院|廊"
)

_DUP_FUNC_WORDS = ("的的", "了了", "是是", "在在", "和和", "与与", "及及", "把把", "被被", "将将")


def _append_typo(
    errors: list[dict],
    text: str,
    start: int,
    end: int,
    suggestion: str,
    reason: str,
) -> None:
    orig = text[start:end]
    if not orig or orig == suggestion:
        return
    errors.append({
        "type": "typo",
        "original": orig,
        "start": start,
        "end": end,
        "suggestion": suggestion,
        "reason": reason,
    })


def run_typo_local(text: str) -> list[dict]:
    """本地错别字：结构笔误 + 高置信常见错词（不替代 LLM）。"""
    errors: list[dict] = []

    # 1) 汉字夹数字：紧23扣 → 紧扣（量词/序位语境不报）
    for m in re.finditer(
        r"([\u4e00-\u9fff])([0-9０-９]{1,6})([\u4e00-\u9fff])",
        text,
    ):
        left, right = m.group(1), m.group(3)
        if re.fullmatch(_NUM_UNIT_RIGHT, right):
            continue
        if re.fullmatch(_NUM_HINT_LEFT, left):
            continue
        if right in "年月日号余多层栋" or left in "第近约共计达超余至从":
            continue
        _append_typo(
            errors, text, m.start(), m.end(), left + right,
            f"汉字中间夹杂数字，疑似笔误：{m.group(0)} → {left + right}",
        )

    # 2) 汉字夹字母：
    # - 绿电f布局 / 紧abc扣 → 报
    # - 心A馆 / 构A线（大写单字母 + 馆塔线…）→ 不报
    for m in re.finditer(
        r"([\u4e00-\u9fff])([A-Za-zＡ-Ｚａ-ｚ]{1,8})([\u4e00-\u9fff])",
        text,
    ):
        left, mid, right = m.group(1), m.group(2), m.group(3)
        mid_ascii = "".join(ch for ch in mid if ("A" <= ch <= "Z") or ("a" <= ch <= "z"))
        if not mid_ascii:
            # 全角字母：按长度与大小写近似处理
            mid_ascii = mid
        if len(mid_ascii) == 1:
            ch = mid_ascii[0]
            is_upper = ch.isupper() or ("Ａ" <= ch <= "Ｚ")
            if is_upper and re.fullmatch(_LETTER_LABEL_RIGHT, right):
                continue
        elif mid_ascii.upper() in (
            "CEO", "CFO", "CTO", "AI", "IT", "OK", "GDP", "KPI", "ESG", "VPN", "IPO", "PPP"
        ):
            continue
        _append_typo(
            errors, text, m.start(), m.end(), left + right,
            f"汉字中间夹杂字母，疑似笔误：{m.group(0)} → {left + right}",
        )

    # 3) 中文之间多余空格
    for m in re.finditer(r"([\u4e00-\u9fff])([ \t\u3000]+)([\u4e00-\u9fff])", text):
        _append_typo(
            errors, text, m.start(), m.end(), m.group(1) + m.group(3),
            "中文之间不宜空格",
        )

    # 4) 助词叠写：的的 / 了了 …
    for dup in _DUP_FUNC_WORDS:
        start = 0
        while True:
            idx = text.find(dup, start)
            if idx < 0:
                break
            _append_typo(
                errors, text, idx, idx + len(dup), dup[0],
                f"叠字笔误：{dup} → {dup[0]}",
            )
            start = idx + 1

    # 5) 同一汉字连写 3 次及以上
    for m in re.finditer(r"([\u4e00-\u9fff])\1{2,}", text):
        ch = m.group(1)
        _append_typo(
            errors, text, m.start(), m.end(), ch + ch,
            f"连续重复用字：{m.group(0)} → {ch + ch}",
        )

    # 6) 固定常见错词表
    for wrong, right in _COMMON_TYPO_PAIRS:
        start = 0
        while True:
            idx = text.find(wrong, start)
            if idx < 0:
                break
            _append_typo(
                errors, text, idx, idx + len(wrong), right,
                f"常见错词：{wrong} → {right}",
            )
            start = idx + 1

    return _dedup_overlap(errors)


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


def deterministic_merge(errors: list[dict], text: str) -> list[dict]:
    if len(errors) <= 1:
        return errors
    sorted_e = sorted(errors, key=lambda e: e["start"])
    groups: list[list[dict]] = []
    for e in sorted_e:
        if groups:
            last_end = max(x["end"] for x in groups[-1])
            if e["start"] <= last_end + 2:
                groups[-1].append(e)
                continue
        groups.append([e])
    merged: list[dict] = []
    for g in groups:
        if len(g) == 1:
            e = dict(g[0])
            e["sources"] = e.get("sources") or [e.get("type")]
            merged.append(e)
            continue
        primary = max(g, key=lambda x: x["end"] - x["start"])
        cs, ce = min(x["start"] for x in g), max(x["end"] for x in g)
        original = text[cs:ce]
        # 从右向左套用 suggestion
        pieces = sorted(g, key=lambda x: -x["start"])
        sug = original
        for p in pieces:
            rel_s = p["start"] - cs
            rel_e = p["end"] - cs
            if 0 <= rel_s < rel_e <= len(sug) and sug[rel_s:rel_e] == p["original"]:
                sug = sug[:rel_s] + p["suggestion"] + sug[rel_e:]
        if sug == original:
            # 合并失败时绝不能丢组：保留可定位的单条
            kept = False
            for p in sorted(g, key=lambda x: -(x["end"] - x["start"])):
                if text[p["start"]:p["end"]] == p.get("original") and p.get("suggestion") != p.get("original"):
                    e = dict(p)
                    e["sources"] = list({str(x.get("type")) for x in g})
                    merged.append(e)
                    kept = True
                    break
            if not kept:
                e = dict(primary)
                e["sources"] = list({str(x.get("type")) for x in g})
                # 必须能在原文定位，禁止保留悬空臆造条
                if (
                    e.get("suggestion")
                    and e.get("suggestion") != e.get("original")
                    and 0 <= int(e.get("start") or 0) < int(e.get("end") or 0) <= len(text)
                    and text[int(e["start"]):int(e["end"])] == e.get("original")
                ):
                    merged.append(e)
            continue
        merged.append({
            "type": primary.get("type") or "typo",
            "original": original,
            "start": cs,
            "end": ce,
            "suggestion": sug,
            "reason": "综合：" + "；".join(
                str(x.get("reason") or "") for x in g if x.get("reason")
            )[:120],
            "sources": list({str(x.get("type")) for x in g}),
        })
    return _dedup_overlap(merged)


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
    provider: str | None,
    model: str | None,
) -> list[dict]:
    import suggest

    prompt = _prompt(engine_id, sensitivity)
    if engine_id == "dataverify" and facts_block:
        prompt = prompt + "\n\n【参考事实数据】\n" + facts_block
    elif engine_id == "dataverify" and not facts_block:
        return []

    # 内容重复必须看全文；分段会拆掉跨「一、」「三、」的对照
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


def _facts_block(facts: list[dict] | None) -> str:
    if not facts:
        return ""
    lines = []
    for it in facts[:40]:
        if not isinstance(it, dict):
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


def proofread(
    text: str,
    engines: list[str] | None = None,
    *,
    sensitivity: str = "normal",
    whitelist: list[str] | None = None,
    mustfix: list[dict] | None = None,
    facts: list[dict] | None = None,
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
    wl = [str(w).strip() for w in (whitelist or []) if str(w).strip()]
    mf = list(mustfix or [])
    facts_block = _facts_block(facts)

    by_engine: dict[str, int] = {}
    raw: list[dict] = []
    failed: list[dict] = []

    # 本地引擎先跑
    for eid in eng:
        meta = ENGINE_META[eid]
        if meta["kind"] != "local":
            continue
        try:
            if eid == "punctuation":
                errs = run_punctuation(text)
            elif eid == "format":
                errs = run_format(text)
            else:
                errs = run_dictionary(text, mf)
            errs = filter_whitelist(errs, wl)
            by_engine[eid] = len(errs)
            raw.extend(errs)
        except Exception as e:
            failed.append({"engineId": eid, "error": str(e)})
            by_engine[eid] = 0

    # 错别字：本地规则必跑（不依赖模型是否漏报），再叠加 LLM
    if "typo" in eng:
        try:
            local_typo = filter_whitelist(run_typo_local(text), wl)
            by_engine["typo"] = by_engine.get("typo", 0) + len(local_typo)
            raw.extend(local_typo)
        except Exception as e:
            failed.append({"engineId": "typo", "error": str(e)})

    llm_ids = [e for e in eng if ENGINE_META[e]["kind"] == "llm"]
    if llm_ids:
        with ThreadPoolExecutor(max_workers=min(4, len(llm_ids))) as pool:
            futs = {
                pool.submit(
                    _run_llm_engine,
                    text,
                    eid,
                    sensitivity=sens,
                    facts_block=facts_block,
                    provider=provider,
                    model=model,
                ): eid
                for eid in llm_ids
            }
            for fut in as_completed(futs):
                eid = futs[fut]
                try:
                    errs = filter_whitelist(fut.result(), wl)
                    by_engine[eid] = by_engine.get(eid, 0) + len(errs)
                    raw.extend(errs)
                except Exception as e:
                    failed.append({"engineId": eid, "error": str(e)})
                    by_engine.setdefault(eid, 0)

    # 内容重复不与邻近错敏合并，否则会丢 peer / 路径
    raw_dups = [e for e in raw if e.get("type") == "duplicate"]
    raw_rest = [e for e in raw if e.get("type") != "duplicate"]
    merged = correct_positions(deterministic_merge(raw_rest, text), text)
    merged.extend(correct_positions(raw_dups, text))
    # 终检：original 必须是原文子串（防模型串稿/臆造）
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
    merged = kept
    # 再滤：LLM 可能把量词/馆号误报成错别字，与本地白名单对齐
    cleaned: list[dict] = []
    for e in merged:
        orig = str(e.get("original") or "")
        if re.fullmatch(r"[\u4e00-\u9fff][0-9０-９]{1,6}[\u4e00-\u9fff]", orig):
            if re.fullmatch(_NUM_UNIT_RIGHT, orig[-1]) or re.fullmatch(_NUM_HINT_LEFT, orig[0]):
                continue
        m_let = re.fullmatch(
            r"([\u4e00-\u9fff])([A-Za-zＡ-Ｚａ-ｚ]+)([\u4e00-\u9fff])",
            orig,
        )
        if m_let:
            mid, right = m_let.group(2), m_let.group(3)
            mid_ascii = "".join(ch for ch in mid if ("A" <= ch <= "Z") or ("a" <= ch <= "z")) or mid
            if len(mid_ascii) == 1:
                ch = mid_ascii[0]
                is_upper = ch.isupper() or ("Ａ" <= ch <= "Ｚ")
                if is_upper and re.fullmatch(_LETTER_LABEL_RIGHT, right):
                    continue
            elif mid_ascii.upper() in (
                "CEO", "CFO", "CTO", "AI", "IT", "OK", "GDP", "KPI", "ESG", "VPN", "IPO", "PPP"
            ):
                continue
            # 小写单字母 / 多字母乱入：保留
        cleaned.append(e)
    merged = cleaned
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
