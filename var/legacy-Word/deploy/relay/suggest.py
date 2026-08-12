#!/usr/bin/env python3
"""人机双写：按选中 md + 要求，调用 MiniMax 或 DeepSeek 生成方案/对话。"""
from __future__ import annotations

import importlib
import json
import logging
import os
import re
import urllib.error
import urllib.request

log = logging.getLogger(__name__)


def _settings():
    try:
        import settings as s
        # 改 Key 后无需整进程重启：每次取配置时热重载
        return importlib.reload(s)
    except ImportError as e:
        raise RuntimeError("缺少 settings.py，请复制 settings.example.py 为 settings.py 并填写 Key") from e


def _provider(override: str | None = None) -> str:
    raw = (override or getattr(_settings(), "AI_PROVIDER", None) or "minimax").strip().lower()
    if raw in ("deepseek", "minimax"):
        return raw
    return "minimax"


def _minimax_cfg():
    s = _settings()
    key = (getattr(s, "MINIMAX_API_KEY", "") or "").strip()
    if not key:
        raise RuntimeError("settings.py 中 MINIMAX_API_KEY 为空")
    base = (getattr(s, "MINIMAX_BASE_URL", "") or "https://api.minimaxi.com/v1").rstrip("/")
    model = getattr(s, "MINIMAX_MODEL", None) or "MiniMax-M3"
    timeout = int(getattr(s, "MINIMAX_TIMEOUT", 90) or 90)
    return key, base, model, timeout


def _deepseek_cfg(model_override: str | None = None):
    s = _settings()
    key = (getattr(s, "DEEPSEEK_API_KEY", "") or "").strip() or (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("settings.py 中 DEEPSEEK_API_KEY 为空")
    base = (getattr(s, "DEEPSEEK_BASE_URL", "") or "https://api.deepseek.com").strip().rstrip("/")
    # /anthropic 是 Anthropic Messages 协议；本服务用 OpenAI /chat/completions，不能混用
    if base.endswith("/anthropic"):
        log.warning("DEEPSEEK_BASE_URL 含 /anthropic，已改回 OpenAI 兼容地址")
        base = "https://api.deepseek.com"
    model = (model_override or getattr(s, "DEEPSEEK_MODEL", None) or "deepseek-v4-flash").strip()
    timeout = int(getattr(s, "DEEPSEEK_TIMEOUT", 90) or 90)
    return key, base, model, timeout


DEEPSEEK_MODELS = (
    {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash"},
    {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro"},
)


def _relay_cfg():
    s = _settings()
    if not bool(getattr(s, "AI_USE_RELAY", False)):
        return None
    base = (getattr(s, "AI_RELAY_BASE", "") or "").strip().rstrip("/")
    if not base:
        return None
    token = (getattr(s, "AI_RELAY_TOKEN", "") or "").strip() or (os.environ.get("AI_RELAY_TOKEN") or "").strip()
    timeout = int(getattr(s, "AI_RELAY_TIMEOUT", 120) or 120)
    return base, token, timeout


def _relay_request(method: str, path: str, payload: dict | None = None, query: str = ""):
    cfg = _relay_cfg()
    if not cfg:
        raise RuntimeError("未启用中转")
    base, token, timeout = cfg
    url = base + path + (("?" + query) if query else "")
    data = None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-Relay-Token"] = token
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        log.warning("Relay HTTP %s %s: %s", e.code, url, detail[:400])
        try:
            err = json.loads(detail).get("error")
        except Exception:
            err = detail[:200]
        raise RuntimeError(f"中转请求失败 HTTP {e.code}" + (f"：{err}" if err else "")) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接中转 {base}：{e.reason}") from e


def _minimax_chat(messages: list, temperature: float = 0.7, model: str | None = None) -> str:
    key, base, default_model, timeout = _minimax_cfg()
    url = base + "/chat/completions"
    payload = {
        "model": (model or default_model).strip() or default_model,
        "messages": messages,
        "temperature": float(temperature),
        "max_completion_tokens": 4096,
        "thinking": {"type": "disabled"},
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        log.warning("MiniMax HTTP %s: %s", e.code, detail[:500])
        raise RuntimeError(f"MiniMax 请求失败 HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接 MiniMax：{e.reason}") from e

    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError("MiniMax 返回空 choices")
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, list):
        content = "".join(
            (p.get("text") or "") for p in content if isinstance(p, dict)
        )
    content = (content or "").strip()
    if not content:
        raise RuntimeError("MiniMax 返回空内容")
    return content


_MATERIAL_TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "列出工程内文稿根、素材/、版本/ 下的 md（路径、标题、字节）",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取工程内相对路径的 md 文本（如 素材/通知.md）",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "max_chars": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_materials",
            "description": "在素材与文稿 md 中按关键词检索，返回命中片段",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
]


def _normalize_tool_calls(raw_calls) -> list:
    out = []
    for i, c in enumerate(raw_calls or []):
        if not isinstance(c, dict):
            continue
        fn = c.get("function") if isinstance(c.get("function"), dict) else {}
        name = (fn.get("name") or c.get("name") or "").strip()
        if not name:
            continue
        args_raw = fn.get("arguments") if fn else c.get("arguments")
        if isinstance(args_raw, dict):
            args = args_raw
        else:
            try:
                args = json.loads(args_raw or "{}")
            except Exception:
                args = {}
            if not isinstance(args, dict):
                args = {}
        out.append(
            {
                "id": str(c.get("id") or f"call_{i + 1}"),
                "name": name,
                "arguments": args,
            }
        )
    return out


def _deepseek_complete(
    messages: list,
    temperature: float = 0.7,
    model: str | None = None,
    tools=None,
) -> dict:
    """返回 {content, tool_calls}；tool_calls 为插件协议列表或 None。"""
    key, base, default_model, timeout = _deepseek_cfg(model)
    url = base + "/chat/completions"
    payload = {
        "model": (model or default_model).strip() or default_model,
        "messages": messages,
        "temperature": float(temperature),
        "max_tokens": 4096,
        "thinking": {"type": "disabled"},
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        log.warning("DeepSeek HTTP %s %s: %s", e.code, url, detail[:500])
        hint = ""
        if e.code == 401:
            hint = "（鉴权失败：核对 DEEPSEEK_API_KEY；地址应为 https://api.deepseek.com，勿用 /anthropic）"
        raise RuntimeError(f"DeepSeek 请求失败 HTTP {e.code}{hint}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接 DeepSeek：{e.reason}") from e

    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError("DeepSeek 返回空 choices")
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, list):
        content = "".join(
            (p.get("text") or "") for p in content if isinstance(p, dict)
        )
    content = (content or "").strip()
    tool_calls = _normalize_tool_calls(msg.get("tool_calls"))
    if not content and not tool_calls:
        raise RuntimeError("DeepSeek 返回空内容")
    return {"content": content, "tool_calls": tool_calls or None}


def _deepseek_chat(messages: list, temperature: float = 0.7, model: str | None = None) -> str:
    r = _deepseek_complete(messages, temperature=temperature, model=model, tools=None)
    if not r.get("content"):
        raise RuntimeError("DeepSeek 返回空内容")
    return r["content"]


def _chat(
    messages: list,
    temperature: float = 0.7,
    provider: str | None = None,
    model: str | None = None,
    cwd: str | None = None,
) -> str:
    prov = _provider(provider)
    if prov == "deepseek":
        return _deepseek_chat(messages, temperature=temperature, model=model)
    return _minimax_chat(messages, temperature=temperature, model=model)


def _chat_ex(
    messages: list,
    temperature: float = 0.7,
    provider: str | None = None,
    model: str | None = None,
    tools=None,
) -> dict:
    prov = _provider(provider)
    if prov == "deepseek":
        return _deepseek_complete(
            messages, temperature=temperature, model=model, tools=tools
        )
    text = _minimax_chat(messages, temperature=temperature, model=model)
    return {"content": text, "tool_calls": None}


def _messages_from_tool_results(tool_results) -> list:
    """把宿主 tool_results 还原为 assistant.tool_calls + role=tool。"""
    if not isinstance(tool_results, list) or not tool_results:
        return []
    calls = []
    tool_msgs = []
    for i, tr in enumerate(tool_results):
        if not isinstance(tr, dict):
            continue
        name = str(tr.get("name") or "").strip()
        if not name:
            continue
        tid = str(tr.get("id") or f"tool_{i + 1}")
        args = tr.get("arguments") if isinstance(tr.get("arguments"), dict) else {}
        calls.append(
            {
                "id": tid,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args or {}, ensure_ascii=False),
                },
            }
        )
        payload = tr.get("result", tr)
        text = json.dumps(payload, ensure_ascii=False)
        if len(text) > 12000:
            text = text[:12000] + "…"
        tool_msgs.append({"role": "tool", "tool_call_id": tid, "content": text})
    if not calls:
        return []
    return [{"role": "assistant", "content": None, "tool_calls": calls}] + tool_msgs


def list_models(provider: str | None = None) -> dict:
    """供前端下拉：{provider, models:[{id,name}], default_model, ready, error?}"""
    if _relay_cfg():
        q = ("provider=" + provider) if provider else ""
        return _relay_request("GET", "/api/ai-models", query=q)
    prov = _provider(provider)
    if prov == "deepseek":
        try:
            _key, _base, default_model, _t = _deepseek_cfg()
            ready = True
            err = None
        except RuntimeError as e:
            default_model = "deepseek-v4-flash"
            ready = False
            err = str(e)
        models = [dict(m) for m in DEEPSEEK_MODELS]
        if default_model and not any(m["id"] == default_model for m in models):
            models.insert(0, {"id": default_model, "name": default_model})
        return {
            "provider": "deepseek",
            "models": models,
            "default_model": default_model,
            "ready": ready,
            "error": err,
        }
    try:
        _key, _base, model, _t = _minimax_cfg()
        ready = True
        err = None
    except RuntimeError as e:
        model = "MiniMax-M3"
        ready = False
        err = str(e)
    return {
        "provider": "minimax",
        "models": [{"id": model, "name": model}],
        "default_model": model,
        "ready": ready,
        "error": err,
    }


def ai_config(provider: str | None = None) -> dict:
    if _relay_cfg():
        q = ("provider=" + provider) if provider else ""
        data = _relay_request("GET", "/api/ai-config", query=q)
        data["relay"] = True
        return data
    prov = _provider(provider)
    s = _settings()
    minimax_ok = bool((getattr(s, "MINIMAX_API_KEY", "") or "").strip())
    deepseek_ok = bool(
        (getattr(s, "DEEPSEEK_API_KEY", "") or "").strip()
        or (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    )
    models = list_models(prov)
    return {
        "provider": prov,
        "providers": [
            {"id": "minimax", "name": "MiniMax", "ready": minimax_ok},
            {"id": "deepseek", "name": "DeepSeek", "ready": deepseek_ok},
        ],
        "model": models.get("default_model"),
        "models": models.get("models") or [],
        "ready": bool(models.get("ready")),
        "error": models.get("error"),
        "relay": False,
    }


def _strip_code_fence(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
    t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _escape_controls_in_json_strings(s: str) -> str:
    """把字符串字面量里的裸换行/控制符转成 \\n 等，便于 json.loads。"""
    out: list[str] = []
    in_str = False
    esc = False
    for ch in s:
        if not in_str:
            out.append(ch)
            if ch == '"':
                in_str = True
            continue
        if esc:
            out.append(ch)
            esc = False
            continue
        if ch == "\\":
            out.append(ch)
            esc = True
            continue
        if ch == '"':
            out.append(ch)
            in_str = False
            continue
        if ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)


def _normalize_json_punct_outside_strings(s: str) -> str:
    """字符串外的中文标点 → JSON 标点（模型常见病）。"""
    out: list[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
        elif ch == "，":
            out.append(",")
        elif ch == "：":
            out.append(":")
        else:
            out.append(ch)
    return "".join(out)


def _insert_missing_commas(s: str) -> str:
    """补全值与值之间漏掉的逗号：["甲" "乙"] / }{ → 合法 JSON。"""
    out: list[str] = []
    stack: list[str] = []  # array | object
    # key=等对象键; colon=等冒号; value=等值; comma=值已结束，下个值前需逗号
    expect = "value"
    in_str = False
    esc = False
    reading_key = False
    i = 0
    n = len(s)

    while i < n:
        ch = s[i]
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
                expect = "colon" if reading_key else "comma"
                reading_key = False
            i += 1
            continue

        if ch.isspace():
            out.append(ch)
            i += 1
            continue

        if ch == '"':
            if expect == "comma":
                out.append(",")
            reading_key = bool(stack and stack[-1] == "object" and expect in ("key", "comma"))
            in_str = True
            out.append(ch)
            i += 1
            continue

        if ch in "[{":
            if expect == "comma":
                out.append(",")
            out.append(ch)
            stack.append("array" if ch == "[" else "object")
            expect = "value" if ch == "[" else "key"
            i += 1
            continue

        if ch in "]}":
            out.append(ch)
            if stack:
                stack.pop()
            expect = "comma"
            i += 1
            continue

        if ch == ":":
            out.append(ch)
            expect = "value"
            i += 1
            continue

        if ch == ",":
            out.append(ch)
            expect = "key" if stack and stack[-1] == "object" else "value"
            i += 1
            continue

        m = re.match(r"(true|false|null)", s[i:], flags=re.I)
        if m:
            if expect == "comma":
                out.append(",")
            out.append(m.group(1).lower())
            i += len(m.group(1))
            expect = "comma"
            continue

        m = re.match(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", s[i:])
        if m:
            if expect == "comma":
                out.append(",")
            out.append(m.group(0))
            i += len(m.group(0))
            expect = "comma"
            continue

        out.append(ch)
        i += 1

    return "".join(out)


def _json_candidates(blob: str) -> list[str]:
    """生成若干可尝试 loads 的变体（去重、顺序：原样 → 修控制符/标点 → 补逗号 → 去尾逗号）。"""
    seen: list[str] = []

    def add(s: str) -> None:
        if s and s not in seen:
            seen.append(s)

    base = (blob or "").strip()
    add(base)
    add(_escape_controls_in_json_strings(base))
    for src in list(seen):
        add(_normalize_json_punct_outside_strings(src))
    for src in list(seen):
        try:
            add(_insert_missing_commas(src))
        except Exception:
            pass
    for src in list(seen):
        add(re.sub(r",\s*([}\]])", r"\1", src))
    return seen


def _loads_model_json(blob: str):
    last: Exception | None = None
    for cand in _json_candidates(blob):
        try:
            return json.loads(cand)
        except json.JSONDecodeError as e:
            last = e
    assert last is not None
    raise last


def _array_from_obj(obj: dict):
    arr = obj.get("options") or obj.get("items") or obj.get("data")
    if not isinstance(arr, list):
        return None
    rec = obj.get("recommend") or obj.get("best")
    if rec is not None and arr:
        try:
            idx = int(rec) - 1
        except (TypeError, ValueError):
            idx = -1
        if 0 <= idx < len(arr) and isinstance(arr[idx], dict):
            for i, it in enumerate(arr):
                if isinstance(it, dict):
                    it["recommend"] = i == idx
    return arr


def _extract_json_array(text: str):
    t = _strip_code_fence(text)
    # 兼容 {"options":[...], "recommend":1}
    if t.lstrip().startswith("{"):
        try:
            obj = _loads_model_json(t)
            if isinstance(obj, dict):
                arr = _array_from_obj(obj)
                if arr is not None:
                    return arr
        except Exception:
            pass
    start = t.find("[")
    end = t.rfind("]")
    if start < 0 or end <= start:
        raise RuntimeError("模型未返回 JSON 数组")
    blob = t[start : end + 1]
    try:
        arr = _loads_model_json(blob)
    except json.JSONDecodeError as e:
        snip = blob[max(0, e.pos - 40) : e.pos + 40]
        log.warning("model json parse fail pos=%s snip=%r", e.pos, snip)
        raise RuntimeError(
            f"模型返回 JSON 无法解析（{e.msg} @ {e.pos}）。请再点一次出方案，或换模型。"
        ) from e
    if not isinstance(arr, list):
        raise RuntimeError("模型返回不是数组")
    return arr


def _clip_note(note: str, limit: int = 40) -> str:
    s = re.sub(r"\s+", " ", str(note or "").strip())
    if not s:
        return ""
    return s if len(s) <= limit else s[:limit] + "…"


def _score_of(item: dict, default: int = 7) -> int:
    raw = item.get("score", item.get("rating"))
    try:
        n = int(round(float(raw)))
    except (TypeError, ValueError):
        n = default
    return max(1, min(10, n))


def _mark_recommend(out: list[dict]) -> list[dict]:
    """保证有且仅有一套 recommend=True（优先模型标注，否则取最高分）。"""
    if not out:
        return out
    flagged = [i for i, x in enumerate(out) if x.get("recommend")]
    if flagged:
        best_i = max(flagged, key=lambda i: out[i].get("score", 0))
    else:
        best_i = max(range(len(out)), key=lambda i: out[i].get("score", 0))
    for i, x in enumerate(out):
        x["recommend"] = i == best_i
    return out


def _parse_options(text: str, count: int) -> list[dict]:
    """解析单段方案，返回 [{md, score, note, recommend}]。"""
    arr = _extract_json_array(text)
    out: list[dict] = []
    for item in arr:
        rec = False
        score = 7
        note = ""
        if isinstance(item, str):
            s = item.strip()
        elif isinstance(item, dict):
            s = str(item.get("md") or item.get("text") or item.get("content") or "").strip()
            score = _score_of(item)
            note = _clip_note(item.get("note") or item.get("reason") or item.get("comment") or "")
            rec = bool(item.get("recommend") or item.get("best") or item.get("recommended"))
        elif isinstance(item, list):
            s = "\n\n".join(str(x).strip() for x in item if str(x).strip())
        else:
            s = str(item).strip()
        if s:
            out.append({"md": s, "score": score, "note": note, "recommend": rec})
    if not out:
        raise RuntimeError("解析后方案为空")
    while len(out) < count:
        out.append(dict(out[-1]))
    return _mark_recommend(out[:count])


def _parse_heading_group_options(text: str, count: int, n_titles: int) -> list[dict]:
    """解析同级标题方案，返回 [{items, score, note, recommend}]。"""
    arr = _extract_json_array(text)
    out: list[dict] = []
    for item in arr:
        score = 7
        note = ""
        rec = False
        if isinstance(item, list):
            rows = [str(x).strip() for x in item if str(x).strip()]
        elif isinstance(item, str):
            rows = [ln.strip() for ln in item.splitlines() if ln.strip()]
        elif isinstance(item, dict):
            inner = item.get("items") or item.get("titles") or item.get("md")
            if isinstance(inner, list):
                rows = [str(x).strip() for x in inner if str(x).strip()]
            else:
                rows = [ln.strip() for ln in str(inner or "").splitlines() if ln.strip()]
            score = _score_of(item)
            note = _clip_note(item.get("note") or item.get("reason") or item.get("comment") or "")
            rec = bool(item.get("recommend") or item.get("best") or item.get("recommended"))
        else:
            continue
        if not rows:
            continue
        while len(rows) < n_titles:
            rows.append(rows[-1])
        out.append({
            "items": rows[:n_titles],
            "score": score,
            "note": note,
            "recommend": rec,
        })
    if not out:
        raise RuntimeError("解析后同级标题方案为空")
    while len(out) < count:
        last = out[-1]
        out.append({**last, "items": list(last["items"])})
    return _mark_recommend(out[:count])


def _format_inventory(md: str) -> str:
    """把片段里出现的格式列成短说明，供模型对照。"""
    s = md or ""
    found = []
    if "**" in s:
        found.append("加粗(**…**)")
    if re.search(r"<u\b", s, re.I):
        found.append("下划线(<u>…</u>)")
    if re.search(r"color\s*:\s*red", s, re.I):
        found.append('红字(<span style="color:red">…</span>)')
    if re.search(r"background\s*:\s*#000", s, re.I):
        found.append('黑底(<span style="background:#000;color:#fff">…</span>)')
    if re.search(r"^#{1,6}\s+", s.strip(), re.M):
        found.append("标题(#/##/###…)")
    return "、".join(found) if found else "无特殊格式（纯文本）"


_FORMAT_RULES = (
    "格式保全（最高优先级，改字不改貌）："
    "A) 原文有哪些格式标记，替换结果必须保留同类标记；禁止擅自去掉 <u>、**、红字、黑底；"
    "B) 若某段文字整体包在一种格式内（如整段在 <u>…</u> 或 **…** 内），改写后整段仍须包在相同标记内；"
    "C) 在下划线/加粗/红字/黑底的中间插入或改写用词，新文字继承该格式；"
    "D) 紧挨格式片段改写、与之连成一词或一句时，继续沿用紧邻侧的格式，不要把有格式的字改成裸文本；"
    "E) 多种格式交错时，按原文边界分别保留，不要合并成一种，也不要打乱嵌套顺序；"
    "F) 仅当用户明确要求改格式时才可增减标记。"
)


def _materials_block(materials) -> str:
    """引用素材正文块（由宿主预读后传入，不含绝对盘符指令）。"""
    if not isinstance(materials, list) or not materials:
        return ""
    parts: list[str] = []
    for i, it in enumerate(materials[:4]):
        if not isinstance(it, dict):
            continue
        path = str(it.get("path") or ("素材" + str(i + 1))).strip()
        text = str(it.get("text") or it.get("content") or "").strip()
        if not text:
            continue
        if len(text) > 12000:
            text = text[:12000] + "\n…（已截断）"
        parts.append(f"### 引用素材：{path}\n{text}")
    if not parts:
        return ""
    return (
        "【已引用素材——有可核对事实/数据/项目则写入；"
        "无对应处仍须按用户意见做可感知改写；不得编造素材没有的数字/项目名】\n"
        + "\n\n".join(parts)
        + "\n"
    )


def _build_messages_single(
    md: str,
    requirement: str,
    count: int,
    tab: str,
    round_n: int,
    context_before: str = "",
    context_after: str = "",
    materials=None,
) -> list:
    mode = "校对润色" if tab == "proof" else "写作改写"
    req = (requirement or "").strip() or "在保持原意与公文语气的前提下给出可选写法"
    inv = _format_inventory(md)
    mats = _materials_block(materials)
    system = (
        "你是机关公文写作助手。用户给出一段带格式的 Markdown 片段（可能含 **加粗**、<u>下划线</u>、"
        '<span style="color:red">红字</span>、<span style="background:#000;color:#fff">黑底</span>、'
        "以及 #/##/### 标题）。你的输出会原样写回文档，因此格式必须可替换、可渲染。"
        "请严格按用户要求生成若干套替换方案，并给出简要评价、标出最优一套。"
        "硬性规则："
        "1) 只输出一个 JSON 数组，不要其它说明、不要代码围栏；"
        "2) 数组长度必须等于指定套数；每一项是对象，字段为："
        'md（可直接替换原文的 md 片段）、score（1-10 分整数）、note（不超过20字的短评）、'
        "recommend（布尔，且全阵有且仅有一个 true 表示最推荐）；"
        "JSON 必须可被标准解析器直接 loads：用英文逗号/冒号；"
        "md 内换行写成 \\n，md 内双引号写成 \\\"；不要用中文逗号、不要在字符串外夹杂说明；"
        f"3) {_FORMAT_RULES}"
        "4) 不要输出整篇公文，只输出该片段；"
        "5) 各套方案彼此应有差异；格式骨架与原文同构（标记种类与大致嵌套不变）；"
        "6) score/note/recommend 必须严肃区分优劣，不要全部打同分或随便推荐；"
        "7) 若提供了【已引用素材】：优先写入与选区相关的可核对事实；无对应事实时按用户意见做表述优化，不得编造数字/项目名；"
        "8) 【零改动禁止】严禁任一方案在去掉空白后与「待替换原文」完全相同；"
        "用户哪怕只写「润色/优化/更简洁」，也必须落实为可感知改写（换词、调句、理顺逻辑至少一处）；"
        "不得以「保持原意」「无素材」为由原样返回选区。"
    )
    ctx_b = (context_before or "").strip()
    ctx_a = (context_after or "").strip()
    user = (
        f"任务：{mode}\n"
        f"套数：{count}\n"
        f"轮次：第 {round_n + 1} 轮（若>1 请给出与前几轮不同的新写法）\n"
        f"要求：{req}\n"
        f"原文格式清单：{inv}\n"
    )
    if mats:
        user += mats + "\n"
    if ctx_b or ctx_a:
        user += (
            "邻接上下文（勿写入替换结果，仅用于判断紧邻格式是否应继承）：\n"
            f"⟦前文⟧{ctx_b or '（无）'}\n"
            f"⟦后文⟧{ctx_a or '（无）'}\n"
        )
    user += (
        f"待替换的原文 md 片段：\n{md}\n\n"
        "输出前自检：每一套 md 在去掉全部空白后，必须与原文不同；"
        "若自检发现相同，请立刻改写后再输出 JSON。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _build_messages_headings(
    items: list[str],
    requirement: str,
    count: int,
    tab: str,
    round_n: int,
    materials=None,
) -> list:
    mode = "校对润色" if tab == "proof" else "写作改写"
    req = (requirement or "").strip() or "统一润色这些同级小标题，保持序号风格与公文语气"
    n = len(items)
    inv = _format_inventory("\n".join(items))
    mats = _materials_block(materials)
    system = (
        "你是机关公文写作助手。用户给出同一层级、同一大标题下的若干同级小标题（Markdown）。"
        "请生成若干套替换方案：每套都包含同样数量的标题，顺序与原文一一对应；并评价、标出最优一套。"
        "硬性规则："
        "1) 只输出一个 JSON 数组，不要其它说明、不要代码围栏；"
        f"2) 外层数组长度必须等于套数；每一项是对象，字段为：items（长度为 {n} 的标题字符串数组）、"
        "score（1-10）、note（不超过20字短评）、recommend（全阵仅一个 true）；"
        "JSON 用英文逗号/冒号；字符串内换行用 \\n、双引号用 \\\"；"
        "3) 每条仍保持原有标题标记（## 或 ### 等）与序号形式（如（一）（二）或 **一是…**），除非要求改序号；"
        f"4) {_FORMAT_RULES}"
        "5) 不要输出正文段落，只输出这些标题行；"
        "6) 各套应有可感知差异；评分与推荐要能分出高下；"
        "7) 若提供了引用素材，标题用语应能与素材主题对齐，禁止空泛堆砌；"
        "8) 【零改动禁止】严禁整套 items 去掉空白后与原文完全相同。"
    )
    listed = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(items))
    user = (
        f"任务：{mode}（同级标题一组）\n"
        f"套数：{count}\n"
        f"每套标题条数：{n}\n"
        f"轮次：第 {round_n + 1} 轮\n"
        f"要求：{req}\n"
        f"原文格式清单：{inv}\n"
    )
    if mats:
        user += mats + "\n"
    user += f"原文标题：\n{listed}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _sanitize_gongwen_md(md: str) -> str:
    """去掉模型误写的首行缩进实体；缩进由编辑器 CSS 负责。"""
    s = str(md or "")
    s = re.sub(r"&emsp;|&ensp;|&#8194;|&#8195;|&#x2002;|&#x2003;", "", s, flags=re.I)
    s = re.sub(r"(?m)^((?:#{1,6}[ \t]+)?)[\u2002\u2003\u3000]+", r"\1", s)
    return s


def _normalize_chat_edit(edit):
    """edit → {summary, md, rename?} 或 None。"""
    if not isinstance(edit, dict):
        return None
    md = _sanitize_gongwen_md(str(edit.get("md") or "")).strip()
    if not md:
        return None
    if not md.endswith("\n"):
        md += "\n"
    summary = str(edit.get("summary") or "").strip() or "拟改当前文稿"
    out = {"summary": summary, "md": md}
    rename = str(edit.get("rename") or "").strip()
    if rename:
        if not rename.lower().endswith(".md"):
            rename += ".md"
        # 只允许文件名，禁止路径穿越
        rename = os.path.basename(rename.replace("\\", "/"))
        if rename and rename not in (".", ".."):
            out["rename"] = rename
    return out


def _doc_is_sparse(doc_md: str) -> bool:
    """几乎空稿：仅标题/空白/占位，无可写正文。"""
    text = (doc_md or "").strip()
    if not text:
        return True
    body = re.sub(r"(?m)^#\s+[^\n]*\n?", "", text).strip()
    body = re.sub(r"\s+", "", body)
    if not body or body in ("标题", "未命名"):
        return True
    # 去掉空段落标记后仍极短
    return len(body) < 12


def _wants_scaffold(message: str) -> bool:
    msg = (message or "").strip()
    if not msg:
        return False
    keys = (
        "框架", "提纲", "搭", "起草", "起个", "结构", "大纲",
        "列个", "架子", "目录", "章节",
    )
    return any(k in msg for k in keys)


def _title_from_doc_or_ws(doc_md: str, workspace: dict | None) -> str:
    m = re.search(r"(?m)^#\s+(.+)$", doc_md or "")
    if m and m.group(1).strip() not in ("标题", "未命名", ""):
        return m.group(1).strip()
    if isinstance(workspace, dict):
        t = str(workspace.get("currentTitle") or "").strip()
        if t and t not in ("标题", "未命名"):
            return t
        cur = str(workspace.get("current") or "").replace("\\", "/")
        base = os.path.splitext(os.path.basename(cur))[0]
        if base and base not in ("未命名", "标题"):
            return base
    return "工作总结"


def _headings_from_materials(workspace: dict | None, limit: int = 8) -> list[str]:
    if not isinstance(workspace, dict):
        return []
    out: list[str] = []
    for it in (workspace.get("materials") or [])[:5]:
        if not isinstance(it, dict):
            continue
        snip = str(it.get("snippet") or "")
        for line in snip.splitlines():
            hm = re.match(r"^(#{2,3})\s+(.+)$", line.strip())
            if not hm:
                continue
            title = hm.group(2).strip()
            if not title or title in out:
                continue
            out.append(title)
            if len(out) >= limit:
                return out
    return out


def _infer_scaffold_edit(message: str, doc_md: str, workspace: dict | None = None):
    """空稿 + 搭框架类指令：本地生成可 Keep 的章节骨架。"""
    if not _wants_scaffold(message) or not _doc_is_sparse(doc_md):
        return None
    title = _title_from_doc_or_ws(doc_md, workspace)
    heads = _headings_from_materials(workspace)
    lines = [f"# {title}", ""]
    if heads:
        for i, h in enumerate(heads):
            # 素材已是「一、」类则不再套编号
            label = h if re.match(r"^[一二三四五六七八九十\d（(]", h) else f"{i + 1}. {h}"
            lines.append(f"## {label}")
            lines.append("")
            lines.append("【待补：根据素材充实要点】")
            lines.append("")
        summary = "已按区内素材标题搭好框架（待补占位，未编造数据）"
    else:
        for block in (
            ("一、工作概况", "简述半年总体情况"),
            ("二、重点工作完成情况", "分条写主要抓手与结果"),
            ("三、存在问题与不足", "如实写差距"),
            ("四、下步工作思路", "写下半年安排"),
        ):
            lines.append(f"## {block[0]}")
            lines.append("")
            lines.append(f"【待补：{block[1]}】")
            lines.append("")
        summary = "已搭工作总结骨架（待补占位，未编造数据）"
    return _normalize_chat_edit({"summary": summary, "md": "\n".join(lines)})


def _infer_title_edit(message: str, doc_md: str):
    """用户说改名/改标题时，模型没给 edit 则本地补一刀。"""
    msg = (message or "").strip()
    patterns = (
        r"(?:把)?(?:当前)?文件名改为\s*[「『\"“](.+?)[」』\"”]",
        r"(?:把)?(?:当前)?文件名改为\s*([^\n，。；;]+)",
        r"(?:把)?(?:当前)?文件改名为\s*[「『\"“](.+?)[」』\"”]",
        r"(?:把)?(?:当前)?文件改名为\s*([^\n，。；;]+)",
        r"改名[为成]\s*[「『\"“](.+?)[」』\"”]",
        r"改名[为成]\s*([^\n，。；;]+)",
        r"(?:文件)?(?:名|标题|题目).{0,6}[为成]\s*[「『\"“](.+?)[」』\"”]",
        r"(?:文件)?(?:名|标题|题目).{0,6}[为成]\s*([^\n，。；;]+)",
        r"(?:标题|题目)改为\s*[「『\"“](.+?)[」』\"”]",
        r"(?:标题|题目)改为\s*([^\n，。；;]+)",
        r"改[成为]\s*[「『\"“](.+?)[」』\"”]",
    )
    title = None
    for pat in patterns:
        m = re.search(pat, msg)
        if not m:
            continue
        title = (m.group(1) or "").strip()
        title = re.sub(r"^(这个文件|该文件|文件|文档|文稿)\s*", "", title).strip()
        title = title.strip("「」『』\"'“” ").strip()
        if title:
            break
    if not title or len(title) > 80:
        return None
    # 去掉口令尾巴：然后重新打开 / 这个文件 等
    title = re.sub(r"(然后)?\s*重新打开.*$", "", title).strip()
    title = re.sub(r"[，,]\s*并.*$", "", title).strip()
    title = re.sub(r"\s*并重新打开.*$", "", title).strip()
    title = re.sub(r"(这个文件|文件名|\.md)$", "", title, flags=re.I).strip() or title
    title = title.strip("「」『』\"'“” ").strip()
    if not title or len(title) > 80:
        return None
    md = doc_md or ""
    if re.search(r"(?m)^#\s+", md):
        md = re.sub(r"(?m)^#\s+[^\n]*", "# " + title, md, count=1)
    else:
        md = "# " + title + "\n\n" + md.lstrip("\n")
    return _normalize_chat_edit({
        "summary": f"标题/文件名改为「{title}」" + ("，Keep 后将重命名并打开" if "重新打开" in msg else ""),
        "md": md,
        "rename": title + ".md",
    })


def _infer_chat_edit(message: str, doc_md: str, workspace: dict | None = None):
    """本地兜底：先搭框架，再改标题。"""
    return _infer_scaffold_edit(message, doc_md, workspace) or _infer_title_edit(
        message, doc_md
    )


def _host_forbids_local_scaffold(message: str) -> bool:
    """WPS/宿主已声明须由模型出稿时，禁止本地【待补】骨架顶替。"""
    msg = message or ""
    if "【宿主约束】" in msg or "严禁空壳" in msg:
        return True
    if "给多份" in msg or "出结论" in msg:
        return True
    if re.search(r"options\s*[:=]\s*\[", msg):
        return True
    return False


def _wants_options_payload(message: str) -> bool:
    msg = message or ""
    if "给多份" in msg:
        return True
    if "options" in msg and ("宿主约束" in msg or "必须输出 JSON" in msg):
        return True
    return bool(re.search(r"options\s*[:=]\s*\[", msg))


def _normalize_chat_options(raw) -> list | None:
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    for i, it in enumerate(raw):
        if not isinstance(it, dict):
            continue
        md = str(it.get("md") or it.get("body") or "").strip()
        if not md:
            continue
        oid = str(it.get("id") or "").strip() or chr(65 + len(out))
        out.append(
            {
                "id": oid,
                "md": md,
                "note": str(it.get("note") or it.get("summary") or "").strip(),
            }
        )
        if len(out) >= 5:
            break
    return out or None


def _parse_chat_edit_response(text: str) -> dict:
    """解析授权改稿 JSON；失败则整段当 reply、无 edit。"""
    raw = (text or "").strip()
    if not raw:
        return {"reply": "（无回复）", "edit": None, "options": None}
    t = _strip_code_fence(raw).strip()
    start, end = t.find("{"), t.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = _loads_model_json(t[start : end + 1])
            if isinstance(obj, dict) and (
                "reply" in obj or "edit" in obj or "options" in obj
            ):
                reply = str(obj.get("reply") or "").strip() or "（已处理）"
                return {
                    "reply": reply,
                    "edit": _normalize_chat_edit(obj.get("edit")),
                    "options": _normalize_chat_options(obj.get("options")),
                }
        except Exception:
            pass
    return {"reply": raw, "edit": None, "options": None}


_TOOL_RULES_NATIVE = (
    "【读文件工具】若【工作区】目录/会话摘要不足以回答（如要读通知、按材料搭框架），"
    "必须调用 list_files / search_materials / read_file；"
    "禁止编造未读到的通知内容。材料足够时直接最终答复，不要空转工具。"
)
_TOOL_RULES_TEXT = (
    "【读文件工具】若【工作区】目录/摘录/会话摘要不足以回答（如要读通知、按材料搭框架），"
    "先只输出一个 JSON（不要其它文字）："
    '{"type":"tool_calls","calls":[{"name":"list_files|read_file|search_materials","arguments":{...}}]}'
    "；list_files 无参；read_file 需 path（相对路径如 素材/通知.md）；"
    "search_materials 需 query。可一次要多个。禁止编造未读到的通知内容。"
    "已有工具结果或材料足够时，不要再调用工具，直接给最终答复。"
)


def chat(
    message: str,
    context_md: str = "",
    doc_md: str = "",
    history=None,
    tab: str = "write",
    provider: str | None = None,
    model: str | None = None,
    cwd: str | None = None,
    allow_edit: bool = False,
    workspace: dict | None = None,
    tool_results=None,
    session_summary: str = "",
    read_set=None,
    project_memory: str = "",
    force_final: bool = False,
) -> dict:
    """对话：返回 {ok, reply, edit?}。edit 仅 allow_edit 时可能有，由前端确认后写盘。
    也可返回 tool_calls（宿主本机执行后再请求）。"""
    if _relay_cfg():
        r = _relay_request("POST", "/api/chat", {
            "message": message,
            "context_md": context_md,
            "doc_md": doc_md,
            "history": history or [],
            "tab": tab,
            "provider": provider,
            "model": model,
            "allow_edit": bool(allow_edit),
            "workspace": workspace or {},
            "tool_results": tool_results or [],
            "session_summary": session_summary or "",
            "read_set": read_set or [],
            "project_memory": project_memory or "",
            "force_final": bool(force_final),
        })
        # 中转常回「结论」散文：本机再兜底一次改名/搭架
        if allow_edit and isinstance(r, dict) and not r.get("error"):
            # 工具调用交给宿主循环，勿本地误补 edit
            reply0 = str(r.get("reply") or "")
            if (not force_final) and (
                '"type":"tool_calls"' in reply0 or r.get("type") == "tool_calls"
            ):
                return r
            edit = (r.get("edit") if isinstance(r.get("edit"), dict) else None)
            has_opts = isinstance(r.get("options"), list) and len(r.get("options") or []) >= 1
            # 宿主声明须模型出稿 / 已有 options：禁止本地【待补】骨架覆盖
            if (
                not has_opts
                and not (edit and edit.get("md"))
                and not _host_forbids_local_scaffold(message)
            ):
                local = _infer_chat_edit(message, doc_md, workspace)
                if local:
                    r = dict(r)
                    r["edit"] = local
                    reply = str(r.get("reply") or "")
                    if (not reply) or ("结论" in reply[:30]) or ("无法" in reply[:40]):
                        r["reply"] = local.get("summary") or reply
        # 铁律：未授权时剥掉一切 edit（即使中转误回）
        if isinstance(r, dict) and not allow_edit:
            r = dict(r)
            r["edit"] = None
        return r
    msg = (message or "").strip()
    if not msg:
        raise ValueError("请输入问题")
    tab = "proof" if tab == "proof" else "write"
    role = "校对顾问" if tab == "proof" else "公文写作顾问"
    allow_edit = bool(allow_edit)
    force_final = bool(force_final)
    use_native_tools = (_provider(provider) == "deepseek") and (not force_final)
    tool_rules = (
        "【禁止调用工具】材料与框架已在历史/工程记忆中，直接最终答复。"
        if force_final
        else (_TOOL_RULES_NATIVE if use_native_tools else _TOOL_RULES_TEXT)
    )
    if allow_edit and _wants_options_payload(msg):
        system = (
            f"你是机关{role}。用户已勾选「给多份」，须由模型给出多组可落稿参考。"
            + tool_rules
            + "最终答复必须是且仅是一个 JSON 对象（禁止 markdown 代码围栏）："
            '{"reply":"一两句说明","edit":null,'
            '"options":[{"id":"A","note":"差异一句","md":"可落稿Markdown"},'
            '{"id":"B","note":"…","md":"…"},{"id":"C","note":"…","md":"…"}]}'
            "硬性规则："
            "1) edit 必须为 null；options 至少 2 组，默认 3 组，最多 5 组；"
            "2) 每组 md 必须含点选层级的标题行（## / ### 等），对仗句式优先（前半后半都要有区分度）；"
            "3) 严禁【待补】空壳占位模板；无依据处标【待核实】或不写数字；"
            "4) 紧贴用户给出的「第一点/第二点…」结构与钉住范围；举例项（如「包含…」）不得压过主干意图；"
            "5) 禁止声称已写入；reply 一两句即可。"
        )
    elif allow_edit and _host_forbids_local_scaffold(msg):
        system = (
            f"你是机关{role}。用户已授权出可落稿结论，须由模型生成。"
            + tool_rules
            + "最终答复必须是且仅是一个 JSON 对象（禁止 markdown 代码围栏）："
            '{"reply":"简短说明","edit":{"summary":"一句话","md":"可落稿Markdown"}}'
            "硬性规则："
            "1) edit.md 必须是可落稿 Markdown，禁止只在 reply 描述；"
            "2) 严禁【待补】空壳占位；无依据处标【待核实】或不写数字；"
            "3) 紧贴用户结构与钉住范围；对仗标题前半后半都要有区分度；"
            "4) 禁止声称已写入；reply 一两句即可。"
        )
    elif allow_edit:
        system = (
            f"你是机关{role}。用户已授权改稿。"
            + tool_rules
            + "最终答复必须是且仅是一个 JSON 对象"
            "（禁止输出「结论」「要点」散文，禁止 markdown 代码围栏）："
            '{"reply":"简短说明","edit":null}'
            " 或 "
            '{"reply":"说明","edit":{"summary":"一句话","md":"改后完整md","rename":"可选新文件名.md"}}'
            "硬性规则："
            "1) 用户要求改名/改标题/加标题/改某段/删句/搭框架/列提纲/起草结构时，edit 不得为 null，必须给出完整 md；"
            "2) 改名或改标题：即使正文为空也要改文首 # 标题，并设置 rename 为「新名.md」；不要以「无正文无法改写」拒绝；"
            "3) 空稿搭框架：若【历史对话】已商定一级标题/框架，或用户说「只要框架/落框架/写到文件」，"
            "**禁止再调用工具**，直接按已定标题输出 edit（## 章节 + 【待补】）；"
            "仅当历史完全没有框架且缺材料时才可工具读取；禁止编造具体业绩数字；"
            "3b) 用户说「落到文件/帮我写/写这部分/整篇初稿/写入到文件」并给出【段落标题】或范例段时："
            "必须输出 edit.md（完整改后正文），禁止只在 reply 里声称已写入或假装 Keep；"
            "4) 可参考【工作区】其它文件，但改稿默认只改【当前文件】；保留 **加黑**、<u>下划线</u> 等标记；"
            "4b) 禁止用 &emsp;、&ensp;、全角空格或 HTML 实体做首行缩进；段落直接写正文，缩进由编辑器负责；"
            "5) 纯询问、不要求改稿时 edit 才为 null；reply 一两句即可，禁止「结论/要点」长文。"
        )
    else:
        system = (
            f"你是机关{role}。用户会附上「全文」和可选「选中片段」。"
            + tool_rules
            + "最终可用纯文本，或 JSON "
            '{"type":"final","reply":"…"}。'
            "硬性规则（铁律）："
            "0) 用户未授权改稿：禁止输出 edit、禁止输出整篇替换稿、禁止声称已写入/已改稿/请 Keep；"
            "只回答问题与建议，改稿须用户先选「授权改稿」。"
            "1) 只根据提供的原文/工具结果判断与回答，禁止臆造未给出的通知或章节内容；"
            "2) 问到「与（二）是否重复」等时，必须用全文里真实的（二）对照；全文没有则明确说「原文未提供，无法判断」；"
            "3) 先给简短结论，再列最多 2～3 条要点；不要长篇分章、不要大表格，除非用户要求展开；"
            "4) 未要求改稿时不要输出整段替换稿；不要输出多套方案 JSON；"
            "5) 用户指出你说错了，应承认并仅依据原文重答。"
        )
    messages = [{"role": "system", "content": system}]
    for turn in (history or [])[-12:]:
        if not isinstance(turn, dict):
            continue
        role_name = turn.get("role")
        content = str(turn.get("content") or "").strip()
        if role_name in ("user", "assistant") and content:
            messages.append({"role": role_name, "content": content})

    doc = (doc_md or "").strip()
    ctx = (context_md or "").strip()
    parts = []
    mem = (project_memory or "").strip()
    if mem:
        parts.append("【工程记忆】\n" + mem[:1500])
    summ = (session_summary or "").strip()
    if summ:
        parts.append("【会话摘要】\n" + summ[:2000])
    if isinstance(read_set, list) and read_set:
        parts.append("【本会话已读】\n" + "、".join(str(x) for x in read_set[:20]))
    if isinstance(workspace, dict) and workspace:
        ws_lines = [
            f"名称：{workspace.get('name') or ''}",
            f"当前文件：{workspace.get('current') or ''}",
            f"当前标题：{workspace.get('currentTitle') or ''}",
        ]
        catalog = workspace.get("catalog") or []
        if isinstance(catalog, list) and catalog:
            ws_lines.append("工程目录（文稿/素材/版本）：")
            for it in catalog[:40]:
                if isinstance(it, dict):
                    ws_lines.append(
                        f"- {it.get('path') or ''}（{it.get('title') or ''}，{it.get('bytes') or 0}字节）"
                    )
        files = workspace.get("files") or []
        if isinstance(files, list) and files and not catalog:
            ws_lines.append("区内 md：")
            for it in files[:15]:
                if isinstance(it, dict):
                    ws_lines.append(
                        f"- {it.get('path') or ''}（{it.get('title') or ''}，{it.get('bytes') or 0}字节）"
                    )
        mats = workspace.get("materials") or []
        has_read = False
        if isinstance(tool_results, list):
            for tr in tool_results:
                if (
                    isinstance(tr, dict)
                    and tr.get("name") == "read_file"
                    and isinstance(tr.get("result"), dict)
                    and tr["result"].get("ok")
                    and (tr["result"].get("content") or tr["result"].get("text"))
                ):
                    has_read = True
                    break
        if isinstance(mats, list) and mats and not has_read:
            ws_lines.append("素材摘录：")
            for it in mats[:5]:
                if not isinstance(it, dict):
                    continue
                ws_lines.append(f"--- {it.get('path') or it.get('title') or ''} ---")
                ws_lines.append(str(it.get("snippet") or "")[:800])
        parts.append("【工作区】\n" + "\n".join(ws_lines))
    # 原生 tools：tool_results 走 role=tool；文本协议：仍写入 user 块（回退）
    tool_msgs = _messages_from_tool_results(tool_results) if use_native_tools else []
    if (not use_native_tools) and isinstance(tool_results, list) and tool_results:
        parts.append("【工具结果】\n" + json.dumps(tool_results, ensure_ascii=False)[:24000])
    if doc:
        parts.append("【当前文件全文 md】\n" + doc[:12000])
    if ctx:
        parts.append("【当前选中】\n" + ctx[:4000])
    if not doc and not ctx and not (isinstance(workspace, dict) and workspace):
        parts.append("【原文】（未提供任何正文，请提醒用户先打开/选中内容，不要猜测文稿内容）")
    elif _doc_is_sparse(doc) and allow_edit:
        parts.append(
            "【说明】当前文件几乎为空：改名须输出 edit（# 标题+rename）；"
            "搭框架前若缺通知内容须先调用读文件工具；"
            "禁止以无正文拒绝。"
        )
    parts.append("【用户问题】\n" + msg)
    messages.append({"role": "user", "content": "\n\n".join(parts)})
    if tool_msgs:
        messages.extend(tool_msgs)
    tools = _MATERIAL_TOOL_DEFS if use_native_tools else None
    out = _chat_ex(
        messages,
        temperature=0.3,
        provider=provider,
        model=model,
        tools=tools,
    )
    native_calls = out.get("tool_calls")
    raw = str(out.get("content") or "")
    if native_calls:
        return {
            "ok": True,
            "type": "tool_calls",
            "tool_calls": native_calls,
            "reply": raw,
            "edit": None,
            "provider": _provider(provider),
        }
    # 文本协议回退：reply 内 JSON
    if '"type":"tool_calls"' in raw or '"need_files"' in raw:
        return {
            "ok": True,
            "reply": raw,
            "edit": None,
            "provider": _provider(provider),
        }
    if allow_edit:
        parsed = _parse_chat_edit_response(raw)
        options = parsed.get("options")
        edit = parsed.get("edit")
        if (
            not options
            and not (edit and edit.get("md"))
            and not _host_forbids_local_scaffold(msg)
        ):
            edit = _infer_chat_edit(msg, doc, workspace)
        reply = parsed["reply"]
        if (
            edit
            and not options
            and (not parsed.get("edit") or "结论" in reply[:20])
        ):
            reply = edit.get("summary") or reply
        out = {
            "ok": True,
            "type": "final",
            "reply": reply,
            "edit": edit,
            "provider": _provider(provider),
        }
        if options:
            out["options"] = options
            out["edit"] = None
        return out
    return {
        "ok": True,
        "type": "final",
        "reply": raw,
        "edit": None,
        "provider": _provider(provider),
    }


def generate_options(
    md: str,
    requirement: str = "",
    count: int = 3,
    tab: str = "write",
    round_n: int = 0,
    items=None,
    context_before: str = "",
    context_after: str = "",
    materials=None,
    provider: str | None = None,
    model: str | None = None,
    cwd: str | None = None,
) -> dict:
    """返回 {ok, options:[{id,md,items?}]}。items 用于同级多标题写回。"""
    if _relay_cfg():
        return _relay_request("POST", "/api/suggest", {
            "md": md,
            "requirement": requirement,
            "count": count,
            "tab": tab,
            "round": round_n,
            "items": items,
            "context_before": context_before,
            "context_after": context_after,
            "materials": materials,
            "provider": provider,
            "model": model,
        })
    n = max(1, min(6, int(count or 3)))
    tab = "proof" if tab == "proof" else "write"
    round_n = max(0, int(round_n or 0))
    item_list = [str(x).strip() for x in (items or []) if str(x).strip()]
    chat_kw = {"provider": provider, "model": model, "cwd": cwd}

    def _norm_md(s: str) -> str:
        return re.sub(r"\s+", "", str(s or ""))

    def _opt_body(o: dict) -> str:
        if o.get("items"):
            return "\n\n".join(str(x) for x in o["items"])
        return o.get("md") or ""

    def _all_same_as_src(opts: list[dict], src: str) -> bool:
        src_n = _norm_md(src)
        if not src_n:
            return False
        return all(_norm_md(_opt_body(o)) == src_n for o in opts)

    def _retry_req(req: str) -> str:
        return (
            str(req or "").strip()
            + "\n\n【系统重试】上一轮方案与原文完全相同，不合格。"
            "请重新给出 "
            + str(n)
            + " 套有实质改动的替换（用词/句式/条理必须变化），"
            "严禁再输出与原文去空白后相同的文本。"
        )

    if len(item_list) >= 2:
        src_join = "\n\n".join(item_list)

        def _build_heading_opts(raw_text: str) -> list[dict]:
            groups = _parse_heading_group_options(raw_text, n, len(item_list))
            out = []
            for i, g in enumerate(groups):
                out.append({
                    "id": str(i + 1),
                    "md": "\n\n".join(g["items"]),
                    "items": g["items"],
                    "score": g.get("score", 7),
                    "note": g.get("note") or "",
                    "recommend": bool(g.get("recommend")),
                })
            return out

        raw = _chat(
            _build_messages_headings(
                item_list, requirement, n, tab, round_n, materials=materials
            ),
            **chat_kw,
        )
        options = _build_heading_opts(raw)
        if _all_same_as_src(options, src_join):
            raw2 = _chat(
                _build_messages_headings(
                    item_list, _retry_req(requirement), n, tab, round_n + 1,
                    materials=materials,
                ),
                **chat_kw,
            )
            options2 = _build_heading_opts(raw2)
            if not _all_same_as_src(options2, src_join):
                options = options2
        return {"ok": True, "options": options, "provider": _provider(provider)}

    md = (md or "").strip()
    if not md:
        raise ValueError("选中内容为空")

    def _build_options(raw_text: str) -> list[dict]:
        parts = _parse_options(raw_text, n)
        return [{
            "id": str(i + 1),
            "md": parts[i]["md"],
            "score": parts[i].get("score", 7),
            "note": parts[i].get("note") or "",
            "recommend": bool(parts[i].get("recommend")),
        } for i in range(len(parts))]

    msgs = _build_messages_single(
        md,
        requirement,
        n,
        tab,
        round_n,
        context_before=context_before or "",
        context_after=context_after or "",
        materials=materials,
    )
    raw = _chat(msgs, **chat_kw)
    options = _build_options(raw)
    # 零改动：强制再要一轮可感知改写（精修核心）
    if _all_same_as_src(options, md):
        raw2 = _chat(
            _build_messages_single(
                md,
                _retry_req(requirement),
                n,
                tab,
                round_n + 1,
                context_before=context_before or "",
                context_after=context_after or "",
                materials=materials,
            ),
            **chat_kw,
        )
        options2 = _build_options(raw2)
        if not _all_same_as_src(options2, md):
            options = options2
    return {"ok": True, "options": options, "provider": _provider(provider)}
