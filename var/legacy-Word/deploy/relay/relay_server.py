#!/usr/bin/env python3
"""公文 AI 模型中转：对外 /api/suggest、/api/chat、/api/proofread；厂商 Key 仅服务器持有。

安全红线（重大）：
- 本进程只做「收文本 → 调模型 → 回文本」，禁止任何文件读写、shell、改服务器目录。
- 用户文稿的读/写/建/改名只允许发生在用户本机 VS Code 扩展（workspace.fs）。
- 请求体里的 path/ops/execute 等字段一律忽略，不得当作执行指令。

S1 控制面：
- /api/auth/* 登录短票；AI 接口验票 → 配额 → model_routes 再调模。
- 过渡期可同时接受长期 RELAY_TOKEN（legacy）与用户 access_token。
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 对话接口只允许这些键进入模型层；其余（含 path/execute/shell）丢弃
_CHAT_ALLOW_KEYS = frozenset({
    "message", "context_md", "doc_md", "history", "tab",
    "provider", "model", "allow_edit", "workspace",
    "tool_results", "session_summary", "read_set",
    "project_memory", "force_final", "capability",
    "category_code", "category", "template_path",
    "materials", "assistant_reasoning", "gather_only",
    "want_options", "write_levels", "option_count",
})

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("relay")

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 简易注册/登录限流：ip -> [timestamps]
_AUTH_HITS: dict[str, list[float]] = {}
_AUTH_LIMIT = 30  # 每窗口次数
_AUTH_WINDOW = 600.0


def _auth_rate_ok(handler: BaseHTTPRequestHandler) -> bool:
    ip = (handler.client_address or ("?", 0))[0]
    now = time.time()
    hits = [t for t in _AUTH_HITS.get(ip, []) if now - t < _AUTH_WINDOW]
    if len(hits) >= _AUTH_LIMIT:
        _AUTH_HITS[ip] = hits
        return False
    hits.append(now)
    _AUTH_HITS[ip] = hits
    return True


def _token() -> str:
    return (os.environ.get("RELAY_TOKEN") or "").strip()


def _control_on() -> bool:
    v = (os.environ.get("CONTROL_ENABLED") or "1").strip().lower()
    return v not in ("0", "false", "off", "no")


def _require_user() -> bool:
    v = (os.environ.get("CONTROL_REQUIRE_USER") or "0").strip().lower()
    return v in ("1", "true", "on", "yes")


def _maintenance() -> str:
    """非空则对 AI 接口返回该文案（503）。"""
    return (os.environ.get("CONTROL_MAINTENANCE") or "").strip()


def _bearer(handler: BaseHTTPRequestHandler) -> str:
    auth = handler.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (handler.headers.get("X-Relay-Token") or "").strip()


def _auth_ctx(handler: BaseHTTPRequestHandler):
    """返回 dict: mode=legacy|user|open；失败返回 None。"""
    got = _bearer(handler)
    want = _token()

    if _control_on():
        try:
            import control_auth
            payload = control_auth.verify_access(got) if got else None
            if payload:
                if not control_auth.access_still_valid(payload):
                    return None
                return {"mode": "user", "access": payload, "token": got}
        except Exception:
            log.exception("verify_access")

    if want:
        if got == want:
            return {"mode": "legacy", "access": None, "token": got}
        if _require_user():
            return None
        return None

    # 无 RELAY_TOKEN：仅内网调试
    if got and _control_on():
        return None
    return {"mode": "open", "access": None, "token": got}


def _chars_guess(body: dict, api: str) -> int:
    if api == "suggest":
        parts = [
            body.get("md") or "",
            body.get("requirement") or "",
            body.get("context_before") or "",
            body.get("context_after") or "",
        ]
    elif api == "chat":
        parts = [
            body.get("message") or "",
            body.get("context_md") or "",
            body.get("doc_md") or "",
            body.get("session_summary") or "",
        ]
    else:
        parts = [body.get("text") or body.get("md") or ""]
    return sum(len(str(p)) for p in parts)


def _capability_for(api: str, body: dict) -> str:
    raw = (body.get("capability") or "").strip().lower()
    if raw in ("fast", "strong", "proof"):
        return raw
    if api == "proofread":
        return "proof"
    # UI 尚未传 capability 时：默认标准档
    return "fast"


def _apply_route(api: str, body: dict, ctx: dict) -> tuple[str, str | None, str | None]:
    """返回 (capability, provider, model)；legacy/open 可保留客户端 provider。"""
    cap = _capability_for(api, body)
    if ctx.get("mode") != "user":
        return cap, body.get("provider"), body.get("model")
    try:
        import control_gate
        task = "proofread" if api == "proofread" else api
        route = control_gate.resolve_route(cap, task)
        if route:
            return cap, route["provider"], route["model"]
    except Exception:
        log.exception("resolve_route")
    # 无路由时仍允许走默认，但不信任客户端厂商名（防白嫖指定贵模）
    return cap, None, None


def _official_inject(body: dict) -> str:
    """按文种挂官方手册（用户侧不可见货架）。"""
    code = (body.get("category_code") or body.get("category") or "").strip()
    if not code:
        return ""
    try:
        import control_content
        return control_content.manual_inject_for_category(code)
    except Exception:
        return ""


def _gate_user(ctx: dict, api: str, body: dict, capability: str) -> str | None:
    """用户态门闩；返回错误文案，None 表示放行。"""
    if ctx.get("mode") != "user":
        return None
    try:
        import control_gate
        control_gate.check_quota(ctx["access"], capability, _chars_guess(body, api))
    except ValueError as e:
        return str(e)
    except Exception as e:
        log.exception("check_quota")
        return "配额检查失败：" + str(e)
    return None


def _record(ctx: dict, api: str, capability: str, body: dict, ok: bool, t0: float):
    if ctx.get("mode") != "user":
        return
    try:
        import control_gate
        control_gate.record_usage(
            int(ctx["access"]["uid"]),
            api,
            capability,
            chars_in=_chars_guess(body, api),
            ms=int((time.time() - t0) * 1000),
            ok=ok,
        )
    except Exception:
        log.exception("record_usage")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, X-Relay-Token, X-Gongwen-Client",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _legacy_ctx(self):
        """运维令牌上下文；失败时已写 JSON，返回 None。"""
        ctx = _auth_ctx(self)
        if ctx is None or ctx.get("mode") != "legacy":
            self._json({"error": "需要运维令牌"}, 403)
            return None
        return ctx

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _serve_admin(self):
        path = os.path.join(HERE, "admin.html")
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._json({"error": "admin.html missing"}, 404)
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/api/health"):
            try:
                from control_invite import register_mode
                reg_mode = register_mode()
            except Exception:
                reg_mode = "open"
            self._json({
                "ok": True,
                "service": "gongwen-relay",
                "control": _control_on(),
                "require_user": _require_user(),
                "maintenance": bool(_maintenance()),
                "register_mode": reg_mode,
            })
            return
        if url.path in ("/admin", "/admin.html"):
            # 页面公开；写操作仍要运维令牌
            self._serve_admin()
            return
        if url.path == "/api/genres":
            # 仅文种名录，无手册正文；可未登录拉取
            import control_content
            self._json(control_content.list_genres())
            return
        if url.path == "/api/templates":
            # 模板名录/摘要；可未登录浏览，正文另取
            import control_content
            q = parse_qs(url.query)
            code = (q.get("category") or q.get("code") or [""])[0]
            try:
                self._json(control_content.list_templates(code))
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            return

        # 公开：无
        ctx = _auth_ctx(self)
        if ctx is None:
            self._json({"error": "unauthorized"}, 401)
            return

        try:
            if url.path == "/api/auth/me":
                if ctx.get("mode") != "user":
                    self._json({"error": "请先登录账号"}, 401)
                    return
                import control_auth
                self._json(control_auth.me(ctx["access"]))
                return
            if url.path == "/api/quota":
                if ctx.get("mode") != "user":
                    self._json({"error": "请先登录账号"}, 401)
                    return
                import control_gate
                self._json(control_gate.quota_snapshot(ctx["access"]))
                return
            if url.path == "/api/user/templates":
                if ctx.get("mode") != "user":
                    self._json({"error": "请先登录账号"}, 401)
                    return
                import control_user_tpl
                q = parse_qs(url.query)
                tid = (q.get("id") or [""])[0]
                try:
                    uid = int(ctx["access"]["uid"])
                    if tid:
                        self._json(control_user_tpl.get_user_template(uid, int(tid)))
                    else:
                        self._json(control_user_tpl.list_user_templates(uid))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                return
            if url.path == "/api/user/proof":
                if ctx.get("mode") != "user":
                    self._json({"error": "请先登录账号"}, 401)
                    return
                import control_user_proof
                try:
                    uid = int(ctx["access"]["uid"])
                    self._json(control_user_proof.list_user_proof(uid))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                return
            if url.path in ("/api/content/pack", "/api/content/index"):
                # 用户短票或运维票均可拉官方包（无用户文稿）
                if ctx.get("mode") not in ("user", "legacy"):
                    self._json({"error": "请先登录"}, 401)
                    return
                import control_content
                if url.path.endswith("/index"):
                    self._json(control_content.content_index())
                else:
                    self._json(control_content.content_pack())
                return
            if url.path == "/api/skeleton":
                if ctx.get("mode") not in ("user", "legacy", "open"):
                    self._json({"error": "请先登录"}, 401)
                    return
                import control_content
                q = parse_qs(url.query)
                tcode = (q.get("template") or q.get("tpl") or [""])[0]
                code = (q.get("category") or q.get("code") or [""])[0]
                try:
                    if tcode:
                        self._json(control_content.get_template(tcode, code))
                    else:
                        self._json(control_content.skeleton_for_category(code))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                return
            if url.path == "/api/template":
                if ctx.get("mode") not in ("user", "legacy", "open"):
                    self._json({"error": "请先登录"}, 401)
                    return
                import control_content
                q = parse_qs(url.query)
                tcode = (q.get("code") or q.get("template") or [""])[0]
                ccode = (q.get("category") or [""])[0]
                try:
                    self._json(control_content.get_template(tcode, ccode))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                return
            if url.path in (
                "/api/admin/routes",
                "/api/admin/users",
                "/api/admin/invites",
                "/api/admin/orgs",
            ):
                if ctx.get("mode") != "legacy":
                    self._json({"error": "需要运维令牌"}, 403)
                    return
                lim = int((parse_qs(url.query).get("limit") or ["100"])[0] or 100)
                if url.path == "/api/admin/routes":
                    import control_gate
                    self._json({"ok": True, "routes": control_gate.list_routes()})
                elif url.path == "/api/admin/users":
                    import control_auth
                    self._json({"ok": True, "users": control_auth.list_users(lim)})
                elif url.path == "/api/admin/invites":
                    import control_invite
                    self._json({
                        "ok": True,
                        "register_mode": control_invite.register_mode(),
                        "invites": control_invite.list_invites(lim),
                    })
                else:
                    import control_org
                    self._json({"ok": True, "orgs": control_org.list_orgs(lim)})
                return

            import suggest
            q = parse_qs(url.query)
            provider = (q.get("provider") or [None])[0]
            if url.path == "/api/ai-config":
                self._json(suggest.ai_config(provider))
            elif url.path == "/api/ai-models":
                # 正式 C 端不应依赖；保留给 legacy 调试
                if ctx.get("mode") == "user":
                    self._json({
                        "ok": True,
                        "capabilities": ["fast", "strong", "proof"],
                        "labels": {"fast": "标准", "strong": "增强", "proof": "校对"},
                        "note": "模型由服务端路由，客户端勿选厂商",
                    })
                else:
                    self._json(suggest.list_models(provider))
            elif url.path == "/api/proofread/engines":
                import proofread as pr
                self._json(pr.engines_catalog())
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            log.exception("GET %s", url.path)
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        url = urlparse(self.path)

        # 认证端点：不要求已登录
        if url.path in (
            "/api/auth/register",
            "/api/auth/login",
            "/api/auth/refresh",
        ):
            if not _control_on():
                self._json({"error": "控制面未启用"}, 503)
                return
            if not _auth_rate_ok(self):
                self._json({"error": "尝试过于频繁，请稍后再试"}, 429)
                return
            try:
                body = self._read_json()
            except Exception:
                self._json({"error": "请求体不是合法 JSON"}, 400)
                return
            try:
                import control_auth
                if url.path == "/api/auth/register":
                    self._json(control_auth.register(
                        body.get("email") or "",
                        body.get("password") or "",
                        body.get("invite_code") or body.get("invite") or "",
                    ))
                elif url.path == "/api/auth/login":
                    self._json(control_auth.login(
                        body.get("email") or "",
                        body.get("password") or "",
                        body.get("device_id") or "",
                    ))
                else:
                    self._json(control_auth.refresh(
                        body.get("refresh_token") or "",
                        body.get("device_id") or "",
                    ))
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                log.exception("auth %s", url.path)
                self._json({"error": str(e)}, 500)
            return

        if url.path == "/api/admin/routes":
            if not self._legacy_ctx():
                return
            try:
                body = self._read_json()
                import control_gate
                control_gate.upsert_route(
                    body.get("capability") or "",
                    body.get("task") or "",
                    body.get("provider") or "",
                    body.get("model") or "",
                    weight=int(body.get("weight") or 100),
                    enabled=int(body.get("enabled") if body.get("enabled") is not None else 1),
                    exclusive=bool(body.get("exclusive")),
                )
                self._json({"ok": True, "routes": control_gate.list_routes()})
            except Exception as e:
                self._json({"error": str(e)}, 400)
            return

        if url.path in (
            "/api/admin/user-status",
            "/api/admin/kick",
            "/api/admin/grant",
            "/api/admin/manual",
            "/api/admin/template",
            "/api/admin/playbook",
            "/api/admin/invites",
            "/api/admin/invite-revoke",
            "/api/admin/orgs",
            "/api/admin/org-member",
            "/api/admin/org-member-remove",
        ):
            if not self._legacy_ctx():
                return
            try:
                body = self._read_json()
                import control_auth
                import control_content
                import control_invite
                import control_org
                email = body.get("email") or ""
                if url.path == "/api/admin/user-status":
                    self._json(control_auth.set_user_status(
                        email, body.get("status") or ""
                    ))
                elif url.path == "/api/admin/kick":
                    uid = control_auth.find_user_id(email)
                    if uid is None:
                        self._json({"error": "用户不存在"}, 404)
                        return
                    n = control_auth.revoke_user_sessions(uid)
                    self._json({"ok": True, "email": email, "revoked_sessions": n})
                elif url.path == "/api/admin/manual":
                    self._json(control_content.upsert_manual(
                        body.get("code") or "",
                        body.get("title") or "",
                        body.get("body_md") or body.get("body") or "",
                        category_code=body.get("category") or body.get("category_code") or "summary",
                        version=str(body.get("version") or "1"),
                        published=int(body.get("published") if body.get("published") is not None else 1),
                    ))
                elif url.path == "/api/admin/template":
                    self._json(control_content.upsert_template(
                        body.get("code") or "",
                        body.get("title") or "",
                        body.get("body_md") or body.get("body") or "",
                        category_code=body.get("category") or body.get("category_code") or "summary",
                        version=str(body.get("version") or "1"),
                        published=int(body.get("published") if body.get("published") is not None else 1),
                    ))
                elif url.path == "/api/admin/playbook":
                    self._json(control_content.upsert_playbook(
                        body.get("code") or "",
                        body.get("title") or "",
                        body.get("stages") or body.get("stages_json") or [],
                        category_code=body.get("category") or body.get("category_code") or "summary",
                        version=str(body.get("version") or "1"),
                        published=int(body.get("published") if body.get("published") is not None else 1),
                    ))
                elif url.path == "/api/admin/invites":
                    self._json(control_invite.create_invite(
                        plan_code=body.get("plan") or body.get("plan_code") or "free",
                        max_uses=int(body.get("max_uses") or body.get("uses") or 1),
                        days=int(body.get("days") if body.get("days") is not None else 30),
                        note=body.get("note") or "",
                        code=body.get("code") or "",
                    ))
                elif url.path == "/api/admin/invite-revoke":
                    self._json(control_invite.revoke_invite(
                        body.get("code") or ""
                    ))
                elif url.path == "/api/admin/orgs":
                    self._json(control_org.create_org(
                        body.get("code") or "",
                        body.get("name") or "",
                        seat_limit=int(body.get("seat_limit") or body.get("seats") or 5),
                        manual_pack=body.get("manual_pack") or body.get("pack") or "",
                    ))
                elif url.path == "/api/admin/org-member":
                    self._json(control_org.add_member(
                        body.get("org") or body.get("org_code") or "",
                        email,
                        role=body.get("role") or "member",
                    ))
                elif url.path == "/api/admin/org-member-remove":
                    self._json(control_org.remove_member(email))
                else:
                    self._json(control_auth.grant_subscription(
                        email,
                        body.get("plan") or body.get("plan_code") or "pro",
                        int(body.get("days") or 30),
                    ))
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        ctx = _auth_ctx(self)
        if ctx is None:
            self._json({"error": "unauthorized"}, 401)
            return
        if _require_user() and ctx.get("mode") != "user":
            self._json({"error": "请登录账号后再使用智能功能"}, 401)
            return
        maint = _maintenance()
        if maint and url.path in ("/api/suggest", "/api/chat", "/api/proofread"):
            self._json({"error": maint}, 503)
            return

        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return

        if url.path == "/api/user/templates":
            if ctx.get("mode") != "user":
                self._json({"error": "请先登录账号"}, 401)
                return
            import control_user_tpl
            try:
                uid = int(ctx["access"]["uid"])
                op = str(body.get("op") or body.get("action") or "create").lower()
                if op == "create":
                    self._json(
                        control_user_tpl.create_user_template(
                            uid,
                            body.get("title") or "",
                            body.get("body_md") or body.get("body") or "",
                            category_code=body.get("category")
                            or body.get("category_code")
                            or "",
                        )
                    )
                elif op == "update":
                    kw = {}
                    if "title" in body:
                        kw["title"] = body.get("title")
                    if "body_md" in body or "body" in body:
                        kw["body_md"] = (
                            body.get("body_md")
                            if "body_md" in body
                            else body.get("body")
                        )
                    if "category_code" in body or "category" in body:
                        kw["category_code"] = (
                            body.get("category_code") or body.get("category") or ""
                        )
                    self._json(
                        control_user_tpl.update_user_template(
                            uid, int(body.get("id") or 0), **kw
                        )
                    )
                elif op == "delete":
                    self._json(
                        control_user_tpl.delete_user_template(
                            uid, int(body.get("id") or 0)
                        )
                    )
                else:
                    self._json({"error": "未知 op：create|update|delete"}, 400)
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        if url.path == "/api/user/proof":
            if ctx.get("mode") != "user":
                self._json({"error": "请先登录账号"}, 401)
                return
            import control_user_proof
            try:
                uid = int(ctx["access"]["uid"])
                op = str(body.get("op") or body.get("action") or "").lower()
                provider = model = None
                if op == "extract_facts":
                    api = "proofread"
                    cap, provider, model = _apply_route(api, body, ctx)
                    err = _gate_user(ctx, api, body, cap)
                    if err:
                        self._json({"error": err}, 402)
                        return
                    t0 = time.time()
                    try:
                        r = control_user_proof.handle_post(
                            uid, body, provider=provider, model=model
                        )
                        _record(ctx, api, cap, body, True, t0)
                        self._json(r)
                    except Exception:
                        _record(ctx, api, cap, body, False, t0)
                        raise
                    return
                self._json(control_user_proof.handle_post(uid, body))
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        try:
            import suggest
            if url.path == "/api/suggest":
                api = "suggest"
                cap, provider, model = _apply_route(api, body, ctx)
                err = _gate_user(ctx, api, body, cap)
                if err:
                    self._json({"error": err}, 402)
                    return
                t0 = time.time()
                mats = body.get("materials")
                if not isinstance(mats, list):
                    mats = None
                try:
                    req = body.get("requirement") or ""
                    inj = _official_inject(body)
                    if inj:
                        req = (req + "\n\n" + inj).strip() if req else inj
                    r = suggest.generate_options(
                        md=body.get("md") or "",
                        requirement=req,
                        count=body.get("count") or 3,
                        tab=body.get("tab") or "write",
                        round_n=body.get("round") or 0,
                        items=body.get("items"),
                        context_before=body.get("context_before") or "",
                        context_after=body.get("context_after") or "",
                        materials=mats,
                        provider=provider,
                        model=model,
                        capability=cap,
                    )
                    if isinstance(r, dict):
                        r.pop("model", None)
                        r["capability"] = cap
                    _record(ctx, api, cap, body, True, t0)
                    self._json(r)
                except Exception:
                    _record(ctx, api, cap, body, False, t0)
                    raise

            elif url.path == "/api/chat":
                api = "chat"
                cap, provider, model = _apply_route(api, body, ctx)
                err = _gate_user(ctx, api, body, cap)
                if err:
                    self._json({"error": err}, 402)
                    return
                t0 = time.time()
                safe = {k: body.get(k) for k in _CHAT_ALLOW_KEYS if k in body}
                ws = safe.get("workspace")
                if not isinstance(ws, dict):
                    ws = None
                else:
                    ws = {
                        "name": ws.get("name") or "",
                        "current": ws.get("current") or "",
                        "currentTitle": ws.get("currentTitle") or "",
                        "files": ws.get("files") if isinstance(ws.get("files"), list) else [],
                        "materials": ws.get("materials")
                        if isinstance(ws.get("materials"), list)
                        else [],
                        "catalog": ws.get("catalog")
                        if isinstance(ws.get("catalog"), list)
                        else [],
                    }
                try:
                    mem = safe.get("project_memory") or ""
                    inj = _official_inject(body)
                    if inj:
                        mem = (mem + "\n\n" + inj).strip() if mem else inj
                    r = suggest.chat(
                        message=safe.get("message") or "",
                        context_md=safe.get("context_md") or "",
                        doc_md=safe.get("doc_md") or "",
                        history=safe.get("history") or [],
                        tab=safe.get("tab") or "write",
                        provider=provider,
                        model=model,
                        allow_edit=bool(safe.get("allow_edit")),
                        workspace=ws,
                        tool_results=safe.get("tool_results"),
                        session_summary=safe.get("session_summary") or "",
                        read_set=safe.get("read_set"),
                        project_memory=mem,
                        force_final=bool(safe.get("force_final")),
                        materials=safe.get("materials"),
                        capability=cap,
                        assistant_reasoning=safe.get("assistant_reasoning") or "",
                        gather_only=False,
                        want_options=safe.get("want_options"),
                        write_levels=safe.get("write_levels") if isinstance(safe.get("write_levels"), list) else [],
                        option_count=safe.get("option_count"),
                    )
                    if isinstance(r, dict):
                        r.pop("model", None)
                        r.pop("provider", None)
                        r["capability"] = cap
                    _record(ctx, api, cap, body, True, t0)
                    self._json(r)
                except Exception:
                    _record(ctx, api, cap, body, False, t0)
                    raise

            elif url.path == "/api/proofread":
                api = "proofread"
                cap, provider, model = _apply_route(api, body, ctx)
                err = _gate_user(ctx, api, body, cap)
                if err:
                    self._json({"error": err}, 402)
                    return
                t0 = time.time()
                import proofread as pr
                engines = body.get("engines")
                if not isinstance(engines, list):
                    engines = None
                wl = body.get("whitelist")
                if not isinstance(wl, list):
                    wl = None
                mf = body.get("mustfix")
                if not isinstance(mf, list):
                    mf = None
                facts = body.get("facts")
                if not isinstance(facts, list):
                    facts = None
                industry_on = (
                    True
                    if "industryPack" not in body
                    else bool(body.get("industryPack"))
                )
                if ctx.get("mode") == "user":
                    try:
                        import control_user_proof
                        pack = control_user_proof.pack_for_proofread(
                            int(ctx["access"]["uid"])
                        )
                        wl = pack["whitelist"]
                        mf = pack["mustfix"]
                        facts = pack["facts"]
                    except Exception:
                        log.exception("user_proof pack")
                try:
                    r = pr.proofread(
                        text=body.get("text") or body.get("md") or "",
                        engines=engines,
                        sensitivity=body.get("sensitivity") or "normal",
                        whitelist=wl,
                        mustfix=mf,
                        facts=facts,
                        industry_pack=industry_on,
                        provider=provider,
                        model=model,
                    )
                    if isinstance(r, dict):
                        r.pop("model", None)
                        r.pop("provider", None)
                        r["capability"] = cap
                    _record(ctx, api, cap, body, True, t0)
                    self._json(r)
                except Exception:
                    _record(ctx, api, cap, body, False, t0)
                    raise
            else:
                self._json({"error": "not found"}, 404)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            log.exception("POST %s", url.path)
            self._json({"error": str(e)}, 500)


def main():
    port = int(os.environ.get("RELAY_PORT") or "3000")
    if not _token():
        log.warning("RELAY_TOKEN 未设置：接口不鉴权（仅建议内网调试）")
    if _control_on():
        try:
            from control_db import init_db
            from control_gate import prune_usage
            init_db()
            n = prune_usage(90)
            if n:
                log.info("pruned usage_events older than 90d: %s", n)
            log.info("control plane ready (CONTROL_REQUIRE_USER=%s)", _require_user())
        except Exception:
            log.exception("control init failed")
    host = "0.0.0.0"
    httpd = ThreadingHTTPServer((host, port), Handler)
    log.info("gongwen-relay listening http://%s:%s", host, port)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
