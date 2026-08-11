#!/usr/bin/env python3
"""HTTP 服务：静态资源 + 公文编辑 API。"""
import importlib
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import dialogs
from session import (
    BASE, atomic_write, clear_session, create_markdown, cur, has_session,
    import_markdown, md_hash, open_document, read_md, rename_markdown,
    run_converter, save_version, snapshot,
)

# 校对逻辑唯一定稿在中转目录，本机离线兜底从此加载（勿再复制一份到 editor/）
_PROOFREAD_MOD = None


def _proofread_mod():
    global _PROOFREAD_MOD
    if _PROOFREAD_MOD is not None:
        return _PROOFREAD_MOD
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "deploy", "relay", "proofread.py")
    )
    if not os.path.isfile(path):
        raise FileNotFoundError(f"缺少校对模块: {path}")
    spec = importlib.util.spec_from_file_location("gongwen_relay_proofread", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _PROOFREAD_MOD = mod
    return mod

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".gif": "image/gif",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
}

_POST_ONLY = (
    "/api/open-pick", "/api/create-md", "/api/import-md", "/api/rename-md",
    "/api/close", "/api/open-path", "/api/save", "/api/save-version",
    "/api/convert-materials",
    "/api/suggest", "/api/chat", "/api/proofread",
    "/api/chats/save", "/api/chats/new", "/api/chats/switch",
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, content_type):
        path = os.path.normpath(path)
        if not (path == BASE or path.startswith(BASE + os.sep)) or not os.path.isfile(path):
            self._json({"error": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, url_path):
        if url_path in ("/", "/editor.html"):
            self._file(os.path.join(BASE, "editor.html"), CONTENT_TYPES[".html"])
        elif url_path == "/demo-dual-write.html":
            self._file(os.path.join(BASE, "demo-dual-write.html"), CONTENT_TYPES[".html"])
        elif url_path == "/gongwen.css":
            self._file(os.path.join(BASE, "gongwen.css"), CONTENT_TYPES[".css"])
        elif url_path.startswith("/vditor/"):
            rel = url_path[len("/vditor/"):]
            ext = os.path.splitext(rel)[1].lower()
            self._file(
                os.path.join(BASE, "vendor", "vditor", rel),
                CONTENT_TYPES.get(ext, "application/octet-stream"),
            )
        else:
            self._json({"error": "not found"}, 404)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            if url.path in _POST_ONLY:
                self._json({"error": f"{url.path} 请用 POST"}, 405)
                return
            self._api_get(url)
        else:
            self._static(url.path)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            self._api_post(url)
        else:
            self._json({"error": "not found"}, 404)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _api_get(self, url):
        if url.path == "/api/content":
            s = cur()
            payload = {
                "md": read_md(), "hash": md_hash(),
                "base": s.get("work_base") or "",
                "work_dir": s.get("work_dir") or "",
                "filename": os.path.basename(s["md_path"]) if s.get("md_path") else "",
                "path": s.get("md_path") or "",
            }
            if s.get("md_path"):
                try:
                    import workspace
                    payload["workspace"] = workspace.summary_for_ai(s["md_path"])
                except Exception:
                    pass
            self._json(payload)
        elif url.path == "/api/workspace":
            self._workspace_get()
        elif url.path == "/api/project-files":
            self._project_files()
        elif url.path == "/api/chats":
            self._chats_get()
        elif url.path == "/api/poll":
            self._json({"hash": md_hash()})
        elif url.path == "/api/ai-config":
            self._ai_config(url)
        elif url.path == "/api/ai-models":
            self._ai_models(url)
        elif url.path == "/api/proofread/engines":
            try:
                self._json(_proofread_mod().engines_catalog())
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif url.path == "/api/export":
            self._export(parse_qs(url.query).get("fmt", ["docx"])[0])
        else:
            self._json({"error": "not found"}, 404)

    def _ai_cwd(self):
        s = cur()
        d = (s.get("work_dir") or s.get("work_base") or "").strip()
        return d if d and os.path.isdir(d) else BASE

    def _workspace_get(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            import workspace
            data = workspace.summary_for_ai(s["md_path"])
            data["materials"] = workspace.material_snippets(s["md_path"])
            self._json({"ok": True, "workspace": data})
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _project_files(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            import workspace
            self._json(workspace.list_project_files(s["md_path"]))
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _chats_get(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            import chats
            active = chats.load_active(s["md_path"])
            listing = chats.list_sessions(s["md_path"])
            self._json({
                "ok": True,
                "active": active,
                "sessions": listing.get("sessions") or [],
            })
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _chats_save(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        try:
            import chats
            r = chats.save_session(
                s["md_path"],
                body.get("id") or "",
                body.get("messages") or [],
                title=body.get("title") or "",
            )
            if not r.get("ok"):
                self._json({"error": r.get("error") or "保存失败"}, 400)
                return
            self._json(r)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _chats_new(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            import chats
            self._json(chats.new_session(s["md_path"]))
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _chats_switch(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        try:
            import chats
            r = chats.switch_session(s["md_path"], body.get("id") or "")
            if not r.get("ok"):
                self._json({"error": r.get("error") or "切换失败"}, 400)
                return
            self._json(r)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _ai_config(self, url):
        try:
            import suggest
            suggest = importlib.reload(suggest)
            q = parse_qs(url.query)
            provider = (q.get("provider") or [None])[0]
            self._json(suggest.ai_config(provider))
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _ai_models(self, url):
        try:
            import suggest
            suggest = importlib.reload(suggest)
            q = parse_qs(url.query)
            provider = (q.get("provider") or [None])[0]
            self._json(suggest.list_models(provider))
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _export(self, fmt):
        s = cur()
        if not has_session() or not s.get("md_path") or not os.path.exists(s["md_path"]):
            self._json({"error": "请先打开文档"}, 400)
            return
        if fmt == "docx":
            rc, _, err = run_converter("md2docx.py", s["md_path"], s["docx_path"])
            if rc != 0:
                self._json({
                    "error": f"md2docx 转换失败：{err.strip()}（请确认 Word 未占用导出的 docx）",
                }, 500)
                return
            with open(s["docx_path"], "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            self.send_header("Content-Disposition", 'attachment; filename="output.docx"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = read_md().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="output.md"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api_post(self, url):
        if url.path == "/api/save":
            self._save()
        elif url.path == "/api/open-path":
            self._open_path_api()
        elif url.path == "/api/open-pick":
            self._open_pick(url)
        elif url.path == "/api/create-md":
            self._create_md()
        elif url.path == "/api/import-md":
            self._import_md()
        elif url.path == "/api/rename-md":
            self._rename_md()
        elif url.path == "/api/close":
            clear_session()
            self._json({"ok": True})
        elif url.path == "/api/save-version":
            r = save_version()
            if not r.get("ok"):
                self._json({"error": r.get("error") or "保存版本失败"}, 400)
                return
            self._json(r)
        elif url.path == "/api/convert-materials":
            self._convert_materials()
        elif url.path == "/api/suggest":
            self._suggest()
        elif url.path == "/api/chat":
            self._chat()
        elif url.path == "/api/proofread":
            self._proofread()
        elif url.path == "/api/chats/save":
            self._chats_save()
        elif url.path == "/api/chats/new":
            self._chats_new()
        elif url.path == "/api/chats/switch":
            self._chats_switch()
        else:
            self._json({"error": "not found"}, 404)

    def _convert_materials(self):
        s = cur()
        if not s.get("md_path"):
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            body = self._read_json()
        except Exception:
            body = {}
        try:
            import workspace
            r = workspace.convert_materials(s["md_path"], force=bool((body or {}).get("force")))
            if r.get("error") and not r.get("ok"):
                self._json(r, 400)
                return
            self._json(r)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _suggest(self):
        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        try:
            import suggest
            suggest = importlib.reload(suggest)
            mats = body.get("materials")
            if not isinstance(mats, list):
                mats = None
            r = suggest.generate_options(
                md=body.get("md") or "",
                requirement=body.get("requirement") or "",
                count=body.get("count") or 3,
                tab=body.get("tab") or "write",
                round_n=body.get("round") or 0,
                items=body.get("items"),
                context_before=body.get("context_before") or "",
                context_after=body.get("context_after") or "",
                materials=mats,
                provider=body.get("provider"),
                model=body.get("model"),
                cwd=self._ai_cwd(),
            )
            self._json(r)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _chat(self):
        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        try:
            import suggest
            suggest = importlib.reload(suggest)
            ws = body.get("workspace") if isinstance(body.get("workspace"), dict) else None
            if not ws and has_session() and cur().get("md_path"):
                try:
                    import workspace
                    ws = workspace.summary_for_ai(cur()["md_path"])
                    # 读材料与授权解耦：对话始终可带素材摘录
                    ws["materials"] = workspace.material_snippets(cur()["md_path"])
                    listed = workspace.list_project_files(cur()["md_path"])
                    if listed.get("ok"):
                        cat = []
                        for key in ("docs", "materials", "versions"):
                            for it in listed.get(key) or []:
                                cat.append(it)
                        ws["catalog"] = cat
                except Exception:
                    ws = None
            r = suggest.chat(
                message=body.get("message") or "",
                context_md=body.get("context_md") or "",
                doc_md=body.get("doc_md") or "",
                history=body.get("history") or [],
                tab=body.get("tab") or "write",
                provider=body.get("provider"),
                model=body.get("model"),
                cwd=self._ai_cwd(),
                allow_edit=bool(body.get("allow_edit")),
                workspace=ws,
                tool_results=body.get("tool_results"),
                session_summary=body.get("session_summary") or "",
                read_set=body.get("read_set"),
                project_memory=body.get("project_memory") or "",
                force_final=bool(body.get("force_final")),
            )
            self._json(r)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _proofread(self):
        try:
            body = self._read_json()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        try:
            import suggest
            # 本地若启用中转，走云端同一套校对
            if getattr(suggest, "_relay_cfg", lambda: None)():
                r = suggest._relay_request("POST", "/api/proofread", {
                    "text": body.get("text") or body.get("md") or "",
                    "engines": body.get("engines"),
                    "sensitivity": body.get("sensitivity") or "normal",
                    "whitelist": body.get("whitelist"),
                    "mustfix": body.get("mustfix"),
                    "facts": body.get("facts"),
                    "provider": body.get("provider"),
                    "model": body.get("model"),
                })
                self._json(r)
                return
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
            r = _proofread_mod().proofread(
                text=body.get("text") or body.get("md") or "",
                engines=engines,
                sensitivity=body.get("sensitivity") or "normal",
                whitelist=wl,
                mustfix=mf,
                facts=facts,
                provider=body.get("provider"),
                model=body.get("model"),
            )
            self._json(r)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _save(self):
        if not has_session():
            self._json({"error": "请先打开文档"}, 400)
            return
        try:
            md = self._read_json().get("md", "")
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        snapshot()
        atomic_write(cur()["md_path"], md)
        try:
            import workspace
            workspace.touch_for_md(cur()["md_path"])
        except Exception:
            pass
        self._json({"ok": True, "hash": md_hash()})

    def _respond_open(self, r):
        """打开结果：成功 / 需确认覆盖 / 错误。"""
        if r.get("ok"):
            self._json(r)
            return
        if r.get("need_confirm"):
            self._json(r)  # 200，由前端弹确认后再 force 打开
            return
        self._json({"error": r.get("error") or "打开失败"}, 400)

    def _open_path_api(self):
        try:
            body = self._read_json()
            path = (body.get("path") or "").strip()
            force = bool(body.get("force"))
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        if not path:
            self._json({"error": "路径不能为空"}, 400)
            return
        # 工程内相对路径
        if not os.path.isabs(path) and has_session() and cur().get("md_path"):
            try:
                import workspace
                root = workspace.resolve_root(cur()["md_path"])
                path = os.path.normpath(os.path.join(root, path.replace("/", os.sep)))
                if not path.startswith(os.path.abspath(root)):
                    self._json({"error": "禁止访问工作区外路径"}, 400)
                    return
            except Exception as e:
                self._json({"error": str(e)}, 400)
                return
        self._respond_open(open_document(path, force=force))

    def _open_pick(self, url):
        qs = parse_qs(url.query)
        kind = (qs.get("kind", ["all"])[0] or "all").lower()
        if kind not in ("docx", "md", "all", "file", "any"):
            kind = "all"
        path = dialogs.pick_file_dialog(kind=kind)
        if not path:
            self._json({"error": "已取消选择文件"}, 400)
            return
        if kind == "md" and not path.lower().endswith(".md"):
            self._json({"error": "请选择 .md 文件"}, 400)
            return
        if kind == "docx" and not path.lower().endswith(".docx"):
            self._json({"error": "请选择 .docx 文件"}, 400)
            return
        if kind in ("all", "file", "any") and not (
            path.lower().endswith(".md") or path.lower().endswith(".docx")
        ):
            self._json({"error": "请选择 .md 或 .docx 文件"}, 400)
            return
        # 选文件后先探测；已有 md 时返回 need_confirm，等用户确认再 force
        self._respond_open(open_document(path, force=False))

    def _rename_md(self):
        try:
            body = self._read_json()
            name = (body.get("filename") or body.get("rename") or "").strip()
        except Exception:
            self._json({"error": "请求体不是合法 JSON"}, 400)
            return
        r = rename_markdown(name)
        if not r.get("ok"):
            self._json({"error": r.get("error") or "重命名失败"}, 400)
            return
        self._json(r)

    def _create_md(self):
        """另存为新建 md，并打开为当前文稿。"""
        try:
            body = self._read_json() if int(self.headers.get("Content-Length", 0) or 0) else {}
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        path = (body.get("path") or "").strip()
        if not path:
            path = dialogs.save_file_dialog(kind="md", default_name="未命名.md")
            if not path:
                self._json({"error": "已取消创建"}, 400)
                return
        self._respond_open(create_markdown(path, title=body.get("title") or ""))

    def _import_md(self):
        """导入外部 md → 写入当前工作文件（无会话则打开该文件）。"""
        try:
            body = self._read_json() if int(self.headers.get("Content-Length", 0) or 0) else {}
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        force = bool(body.get("force"))
        path = (body.get("path") or "").strip()
        if not path:
            path = dialogs.pick_file_dialog(kind="md")
            if not path:
                self._json({"error": "已取消选择文件"}, 400)
                return
        if not path.lower().endswith(".md"):
            self._json({"error": "请选择 .md 文件"}, 400)
            return
        self._respond_open(import_markdown(path, force=force))
