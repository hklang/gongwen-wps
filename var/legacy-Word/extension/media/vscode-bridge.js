/**
 * 现网 editor.html ↔ VS Code：
 * - AI 经扩展宿主代打云中转
 * - content/save/打开/导出/关闭 走宿主 RPC（等结果再回）
 */
(function () {
  const vscode = acquireVsCodeApi();
  const boot = window.__GONGWEN_VSCODE__ || {};
  const state = {
    serverUrl: String(boot.serverUrl || "").replace(/\/$/, ""),
    token: String(boot.token || ""),
    path: String(boot.path || ""),
    filename: String(boot.filename || "document.md"),
    md: typeof boot.initialMd === "string" ? boot.initialMd : "",
    hash: "vscode-init",
  };
  let reqSeq = 0;
  /** @type {Map<number, {resolve:Function, reject:Function}>} */
  const pending = new Map();

  function log(level, message, data) {
    try {
      vscode.postMessage({ type: "log", level: level, message: message, data: data || {} });
    } catch (e) { /* ignore */ }
  }

  function jsonRes(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function parseUrl(input) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        return { path: u.pathname, search: u.search, href: raw };
      }
    } catch (e) { /* ignore */ }
    const q = raw.indexOf("?");
    return {
      path: q >= 0 ? raw.slice(0, q) : raw,
      search: q >= 0 ? raw.slice(q) : "",
      href: raw,
    };
  }

  function apiKind(pathname) {
    const p = String(pathname || "");
    if (p.indexOf("/api/ai-config") >= 0) return "ai";
    if (p.indexOf("/api/ai-models") >= 0) return "ai";
    if (p.indexOf("/api/suggest") >= 0) return "ai";
    if (p.indexOf("/api/proofread") >= 0) return "ai";
    // chats* 必须在 /api/chat 之前（否则 indexOf('/api/chat') 会误吃 chats）
    if (p.indexOf("/api/chats/save") >= 0) return "chats-save";
    if (p.indexOf("/api/chats/new") >= 0) return "chats-new";
    if (p.indexOf("/api/chats/switch") >= 0) return "chats-switch";
    if (p.indexOf("/api/chats") >= 0) return "chats";
    if (p.indexOf("/api/config/save") >= 0) return "config-save";
    if (p.indexOf("/api/config/pick-reference") >= 0) return "pick-reference";
    if (p.indexOf("/api/config/pick-compare") >= 0) return "pick-compare";
    if (p.indexOf("/api/config") >= 0) return "config-get";
    if (p.indexOf("/api/memory/append-scaffold") >= 0) return "memory-append-scaffold";
    if (p.indexOf("/api/memory/append") >= 0) return "memory-append";
    if (p.indexOf("/api/memory") >= 0) return "memory-get";
    if (p.indexOf("/api/chat") >= 0) return "ai";
    if (p.indexOf("/api/genres") >= 0) return "ai";
    if (p.indexOf("/api/templates/land") >= 0) return "land-template";
    if (p.indexOf("/api/delete-md") >= 0) return "delete-md";
    if (p.indexOf("/api/user/templates") >= 0) return "ai";
    if (p.indexOf("/api/templates") >= 0) return "ai";
    if (p.indexOf("/api/template") >= 0) return "ai";
    if (p.indexOf("/api/skeleton") >= 0) return "ai";
    if (p.indexOf("/api/content") >= 0) return "content";
    if (p.indexOf("/api/save-version") >= 0) return "save-version";
    if (p.indexOf("/api/save") >= 0) return "save";
    if (p.indexOf("/api/close") >= 0) return "close";
    if (p.indexOf("/api/open-pick") >= 0) return "open-pick";
    if (p.indexOf("/api/open-path") >= 0) return "open-path";
    if (p.indexOf("/api/create-md") >= 0) return "create-md";
    if (p.indexOf("/api/import-md") >= 0) return "import-md";
    if (p.indexOf("/api/rename-md") >= 0) return "rename-md";
    if (p.indexOf("/api/workspace") >= 0) return "workspace";
    if (p.indexOf("/api/project-files") >= 0) return "project-files";
    if (p.indexOf("/api/convert-materials") >= 0) return "convert-materials";
    if (p.indexOf("/api/export") >= 0) return "export";
    return "";
  }

  async function readBody(init) {
    if (!init || init.body == null) return null;
    if (typeof init.body === "string") {
      try { return JSON.parse(init.body); } catch (e) { return null; }
    }
    if (init.body instanceof Blob) {
      const t = await init.body.text();
      try { return JSON.parse(t); } catch (e) { return null; }
    }
    return null;
  }

  function basename(p) {
    const s = String(p || "").replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function hostCall(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const id = ++reqSeq;
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("宿主响应超时"));
      }, timeoutMs || 120000);
      pending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); },
      });
      const msg = Object.assign({ type: type, id: id }, payload || {});
      vscode.postMessage(msg);
    });
  }

  function applyDocPayload(json) {
    if (!json || typeof json !== "object") return;
    if (typeof json.md === "string") state.md = json.md;
    if (json.hash) state.hash = String(json.hash);
    if (json.path) {
      state.path = String(json.path);
      state.filename = basename(json.path);
    }
    if (json.filename) state.filename = String(json.filename);
  }

  window.gongwenBridge = {
    writeClipboard: function (text) {
      try {
        vscode.postMessage({ type: "clipboardWrite", text: String(text || "") });
      } catch (e) { /* ignore */ }
    },
    log: function (level, message, data) {
      log(level || "info", message || "msg", data || {});
    },
    account: function (action) {
      try {
        vscode.postMessage({
          type: "account",
          action: String(action || "").toLowerCase(),
        });
      } catch (e) { /* ignore */ }
    },
  };

  window.addEventListener("message", function (ev) {
    const msg = ev.data || {};
    if (msg.type === "init") {
      if (msg.serverUrl) state.serverUrl = String(msg.serverUrl).replace(/\/$/, "");
      if (msg.token != null) state.token = String(msg.token);
      log("info", "bridge.init", { serverUrl: state.serverUrl, hasToken: !!state.token });
      return;
    }
    if (msg.type === "setDoc") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (text !== state.md) {
        state.md = text;
        state.hash = msg.hash ? String(msg.hash) : ("ext-" + Date.now());
      } else if (msg.hash) {
        state.hash = String(msg.hash);
      }
      if (msg.path) {
        state.path = msg.path;
        state.filename = basename(msg.path);
      }
      try {
        window.dispatchEvent(
          new CustomEvent("gongwen-set-doc", {
            detail: {
              path: msg.path || state.path || "",
              filename: state.filename || "",
              hash: state.hash || "",
              text: text,
            },
          })
        );
      } catch (_) { /* ignore */ }
      return;
    }
    if (msg.type === "clipboard") {
      try {
        window.dispatchEvent(
          new CustomEvent("gongwen-clipboard", {
            detail: { op: String(msg.op || ""), text: msg.text },
          })
        );
      } catch (_) { /* ignore */ }
      return;
    }
    if (msg.type === "relayResult" || msg.type === "rpcResult") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.resolve(msg);
    }
    if (msg.type === "chatContext") {
      try {
        window.dispatchEvent(
          new CustomEvent("gongwen-chat-context", { detail: msg })
        );
      } catch (_) { /* ignore */ }
    }
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const u = parseUrl(input);
    const kind = apiKind(u.path);
    const method = ((init && init.method) || "GET").toUpperCase();

    if (kind === "ai") {
      const apiPath = (u.path || "") + (u.search || "");
      log("info", "bridge.relay.proxy", { path: apiPath, method: method });
      try {
        const body = method === "GET" || method === "HEAD" ? null : await readBody(init);
        const r = await hostCall("relay", {
          method: method,
          path: apiPath,
          body: body == null ? null : body,
        }, 125000);
        return jsonRes(r.json != null ? r.json : { error: r.error || "空响应" }, r.status || 500);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "content") {
      try {
        const r = await hostCall("rpc", { op: "getContent" }, 15000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "读取失败" }, r.status || 500);
        }
        applyDocPayload(json);
        log("info", "bridge.content", { bytes: state.md.length, hash: state.hash });
        return jsonRes({
          md: state.md == null ? "" : String(state.md),
          hash: state.hash,
          work_dir: json.work_dir || (state.path ? state.path.replace(/[/\\][^/\\]+$/, "") : "vscode"),
          filename: json.filename || state.filename || basename(state.path) || "document.md",
          path: json.path || state.path,
          switched: !!json.switched,
          workspace: json.workspace || null,
        });
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "workspace") {
      try {
        const r = await hostCall("rpc", { op: "getWorkspace" }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "工作区读取失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "project-files") {
      try {
        const r = await hostCall("rpc", { op: "listProjectFiles" }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "文件列表失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "land-template") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall(
          "rpc",
          {
            op: "landTemplate",
            body_md: body.body_md || body.bodyMd || "",
            title: body.title || "",
            category: body.category || body.categoryCode || "",
            force: !!body.force,
          },
          30000
        );
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "落地模板失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "delete-md") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall(
          "rpc",
          { op: "deleteMd", path: body.path || body.rel || "" },
          120000
        );
        const json = r.json || {};
        if (json.cancelled) return jsonRes(json, 200);
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "删除失败" }, r.status || 500);
        }
        if (json.switched) applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "convert-materials") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall(
          "rpc",
          { op: "convertMaterials", force: !!body.force },
          180000
        );
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "转换素材失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "chats") {
      try {
        const r = await hostCall("rpc", { op: "chatsGet" }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "读取会话失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "chats-save") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "chatsSave",
          sessionId: body.id || body.sessionId || "",
          messages: body.messages || [],
          title: body.title || "",
          summary: body.summary || "",
          readSet: body.readSet || body.read_set || [],
        }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "保存会话失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "chats-new") {
      try {
        const r = await hostCall("rpc", { op: "chatsNew" }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "新建会话失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "chats-switch") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "chatsSwitch",
          sessionId: body.id || body.sessionId || "",
        }, 20000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "切换会话失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "config-get") {
      try {
        const r = await hostCall("rpc", { op: "configGet" }, 15000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "读取配置失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "config-save") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "configSave",
          config: body.config || body,
        }, 15000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "保存配置失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "pick-reference") {
      try {
        const r = await hostCall("rpc", { op: "pickReference" }, 120000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "选择失败" }, r.status || 400);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "pick-compare") {
      try {
        const r = await hostCall("rpc", { op: "pickCompare" }, 120000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "选择失败" }, r.status || 400);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "memory-get") {
      try {
        const r = await hostCall("rpc", { op: "memoryGet" }, 15000);
        return jsonRes(r.json || {});
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "memory-append") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "memoryAppend",
          note: body.note || body.text || "",
        }, 15000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "写入记忆失败" }, r.status || 400);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "memory-append-scaffold") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "memoryAppendScaffold",
          md: body.md || "",
          summary: body.summary || "",
        }, 15000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "写入框架记忆失败" }, r.status || 400);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "save") {
      const body = (await readBody(init)) || {};
      const md = typeof body.md === "string" ? body.md : state.md;
      try {
        const r = await hostCall("rpc", {
          op: "save",
          md: md,
          expectedPath: body.expectedPath || body.path || state.path || "",
        }, 60000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "保存失败" }, r.status || 500);
        }
        state.md = md;
        state.hash = json.hash || ("save-" + Date.now());
        log("info", "bridge.save", { bytes: md.length, hash: state.hash });
        return jsonRes({
          ok: true,
          hash: state.hash,
          path: json.path || state.path,
          workspace: json.workspace || null,
        });
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "save-version") {
      const body = (await readBody(init)) || {};
      const md = typeof body.md === "string" ? body.md : state.md;
      try {
        const r = await hostCall("rpc", { op: "saveVersion", md: md }, 60000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "存版本失败" }, r.status || 500);
        }
        if (typeof md === "string") state.md = md;
        if (json.hash) state.hash = String(json.hash);
        return jsonRes({ ok: true, filename: json.filename || "version.md" });
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "close") {
      try {
        const r = await hostCall("rpc", { op: "close" }, 30000);
        const json = r.json || { ok: true };
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "关闭失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "open-pick") {
      const qs = new URLSearchParams((u.search || "").replace(/^\?/, ""));
      const openKind = (qs.get("kind") || "all").toLowerCase();
      try {
        const r = await hostCall("rpc", { op: "openPick", kind: openKind }, 300000);
        const json = r.json || {};
        if (json.need_confirm) return jsonRes(json, 200);
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "打开失败" }, r.status || 400);
        }
        applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "open-path") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "openPath",
          path: body.path,
          force: !!body.force,
          inplace: body.inplace !== false,
        }, 300000);
        const json = r.json || {};
        if (json.need_confirm) return jsonRes(json, 200);
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "打开失败" }, r.status || 400);
        }
        applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "create-md") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "createMd",
          path: body.path || "",
          title: body.title || "",
        }, 300000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "创建失败" }, r.status || 400);
        }
        applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "rename-md") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "renameMd",
          filename: body.filename || body.rename || "",
          md: typeof body.md === "string" ? body.md : null,
        }, 60000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "重命名失败" }, r.status || 400);
        }
        applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "import-md") {
      const body = (await readBody(init)) || {};
      try {
        const r = await hostCall("rpc", {
          op: "importMd",
          path: body.path || "",
          force: !!body.force,
        }, 300000);
        const json = r.json || {};
        if (json.need_confirm) return jsonRes(json, 200);
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "导入失败" }, r.status || 400);
        }
        applyDocPayload(json);
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    if (kind === "export") {
      const qs = new URLSearchParams((u.search || "").replace(/^\?/, ""));
      const fmt = (qs.get("fmt") || "docx").toLowerCase();
      try {
        const r = await hostCall("rpc", { op: "export", fmt: fmt, md: state.md }, 180000);
        const json = r.json || {};
        if (r.ok === false || (r.status && r.status >= 400)) {
          return jsonRes(json.error ? json : { error: r.error || "导出失败" }, r.status || 500);
        }
        return jsonRes(json);
      } catch (e) {
        return jsonRes({ error: String(e.message || e) }, 502);
      }
    }

    return origFetch(input, init);
  };

  const origBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  if (origBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (String(url).indexOf("/api/save") >= 0) {
        Promise.resolve(readBody({ body: data })).then(function (body) {
          const md = body && typeof body.md === "string" ? body.md : state.md;
          // 空/缺失正文不落盘（预览跳过 beacon 时不应误用旧 state.md）
          if (typeof md !== "string") return;
          state.md = md;
          hostCall("rpc", { op: "save", md: md, reason: "beacon" }, 60000).catch(function () { /* ignore */ });
        });
        return true;
      }
      return origBeacon(url, data);
    };
  }

  log("info", "bridge.boot", {
    path: state.path,
    bytes: state.md.length,
    serverUrl: state.serverUrl,
    hasToken: !!state.token,
  });
  vscode.postMessage({ type: "ready" });
})();
