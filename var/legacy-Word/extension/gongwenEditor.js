const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const log = require("./log");
const { relayRequest } = require("./relayProxy");
const { buildEmbeddedHtml } = require("./embedHtml");
const gwWs = require("./gongwenWorkspace");
const localFs = require("./localFs");
const chatsStore = require("./chatsStore");
const materialTools = require("./materialTools");
const projectMemory = require("./projectMemory");
const chatToolLoop = require("./chatToolLoop");
const accountAuth = require("./accountAuth");
const officialSync = require("./officialSync");

const execFileAsync = promisify(execFile);

class GongwenMdEditorProvider {
  static viewType = "gongwen.md";
  /** @type {Set<string>} */
  static tracked = new Set();
  /** @type {vscode.WebviewPanel | null} */
  static activePanel = null;

  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
  }

  /** @param {vscode.ExtensionContext} context */
  static register(context) {
    const provider = new GongwenMdEditorProvider(context);
    const disp = vscode.window.registerCustomEditorProvider(
      GongwenMdEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
    const clip = (op) => () => GongwenMdEditorProvider.dispatchClipboard(op);
    context.subscriptions.push(
      vscode.commands.registerCommand("gongwen.clipboard.cut", clip("cut")),
      vscode.commands.registerCommand("gongwen.clipboard.copy", clip("copy")),
      vscode.commands.registerCommand("gongwen.clipboard.paste", clip("paste")),
      vscode.commands.registerCommand("gongwen.clipboard.selectAll", clip("selectAll"))
    );
    return disp;
  }

  /** VS Code 常截走 Webview 内 Ctrl+X/C/V；改由宿主转发 */
  static async dispatchClipboard(op) {
    const panel = GongwenMdEditorProvider.activePanel;
    if (!panel) return;
    try {
      if (op === "paste") {
        const text = await vscode.env.clipboard.readText();
        panel.webview.postMessage({ type: "clipboard", op, text: text || "" });
        return;
      }
      panel.webview.postMessage({ type: "clipboard", op });
    } catch (e) {
      log.warn("clipboard.dispatch.fail", {
        op,
        message: String(e && e.message ? e.message : e),
      });
    }
  }

  realExtensionPath() {
    try {
      return fs.realpathSync(this.context.extensionPath);
    } catch (_) {
      return this.context.extensionPath;
    }
  }

  editorDir() {
    return vscode.Uri.file(path.join(this.realExtensionPath(), "..", "editor"));
  }

  mediaDir() {
    return vscode.Uri.file(path.join(this.realExtensionPath(), "media"));
  }

  toolsDir() {
    return path.join(this.realExtensionPath(), "..", "tools");
  }

  /** @returns {Promise<{serverUrl:string,token:string,provider:string,authMode:string,capability:string}>} */
  async relayConfig() {
    const cfg = vscode.workspace.getConfiguration("gongwen");
    const auth = await accountAuth.resolveAuthToken();
    const capRaw = String(cfg.get("capability") || "fast").trim().toLowerCase();
    const capability = capRaw === "strong" ? "strong" : "fast";
    return {
      serverUrl: String(cfg.get("serverUrl") || "").trim().replace(/\/$/, ""),
      token: auth.token || String(cfg.get("relayToken") || "").trim(),
      provider: String(cfg.get("defaultProvider") || "deepseek"),
      authMode: auth.mode || "none",
      capability,
    };
  }

  /** 用户短票模式下去掉客户端厂商名，改传 capability */
  prepareAiBody(body, relay, apiHint) {
    if (!body || typeof body !== "object") return body;
    const out = { ...body };
    if (apiHint === "proofread") {
      out.capability = "proof";
    } else if (out.capability !== "strong" && out.capability !== "fast") {
      out.capability = relay.capability || "fast";
    }
    // 嵌入扩展：一律不信客户端厂商名（云端路由）
    delete out.provider;
    delete out.model;
    return out;
  }

  contentHash(text) {
    return crypto
      .createHash("sha1")
      .update(String(text || ""), "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  workspaceFolders() {
    return vscode.workspace.workspaceFolders || [];
  }

  workspaceSummary(mdPath, withMaterials) {
    try {
      const ws = gwWs.summaryForAi(mdPath, this.workspaceFolders());
      if (withMaterials) {
        ws.materials = gwWs.materialSnippets(mdPath, this.workspaceFolders());
      }
      try {
        const cat = materialTools.catalogForAi(mdPath);
        if (cat.ok) ws.catalog = cat.items;
      } catch (_) { /* ignore */ }
      return ws;
    } catch (e) {
      log.warn("workspace.summary.fail", {
        message: String(e && e.message ? e.message : e),
      });
      return {};
    }
  }

  /**
   * 精修：@ / pinned 优先；未引用时按选区+当前稿标题自动检索并预读材料。
   */
  enrichSuggestBody(body, ctx) {
    const fp = this.activeFsPath(ctx);
    const out = Object.assign({}, body || {});
    const pinned = [];
    const push = (p) => {
      const rel = String(p || "")
        .trim()
        .replace(/\\/g, "/");
      if (!rel || pinned.indexOf(rel) >= 0) return;
      pinned.push(rel);
    };
    (Array.isArray(out.pinned_paths) ? out.pinned_paths : []).forEach(push);
    const req = String(out.requirement || "");
    const atRe = /@([^\s@，,。；;]+?\.md)/g;
    let am;
    while ((am = atRe.exec(req))) push(am[1]);

    let auto = false;
    let materials = [];
    if (!pinned.length && materialTools.discoverMaterialsForSuggest) {
      let docMd = "";
      try {
        if (this.isShellDetached(ctx) && ctx.state && ctx.state.shellMd != null) {
          docMd = String(ctx.state.shellMd);
        } else if (ctx.document) {
          docMd = ctx.document.getText();
        }
      } catch (_) { /* ignore */ }
      const found = materialTools.discoverMaterialsForSuggest(fp, {
        selection: out.md || "",
        requirement: req,
        docMd,
      });
      materials = (found.materials || []).slice(0, 2);
      auto = materials.length > 0;
      if (auto) {
        log.info("editor.suggest.autoDiscover", {
          keys: (found.keys || []).slice(0, 12),
          paths: materials.map((m) => m.path),
        });
      }
    } else if (pinned.length) {
      const seen = new Set();
      for (let i = 0; i < pinned.length && materials.length < 3; i++) {
        if (seen.has(pinned[i])) continue;
        seen.add(pinned[i]);
        const rd = materialTools.executeTool(fp, "read_file", {
          path: pinned[i],
          max_chars: 10000,
        });
        if (!(rd.result && rd.result.ok)) {
          log.warn("editor.suggest.readPin.fail", {
            path: pinned[i],
            error: rd.result && rd.result.error,
          });
          continue;
        }
        materials.push({
          path: rd.result.path || pinned[i],
          text: String(rd.result.text || rd.result.content || ""),
        });
      }
    }
    if (materials.length) {
      out.materials = materials;
      out.pinned_paths = materials.map((m) => m.path);
      // 兼容尚未升级的中转：把素材正文并进 requirement，确保模型一定看得到
      const block = materials
        .map((m) => {
          const t = String(m.text || "");
          return (
            "【引用素材：" +
            m.path +
            "】\n" +
            (t.length > 9000 ? t.slice(0, 9000) + "\n…（已截断）" : t)
          );
        })
        .join("\n\n");
      // 有素材：优先用事实，但绝不禁止润色/表述优化（「禁止同义润色」曾导致模型零改动）
      const tip = auto
        ? "\n\n【素材】以上由系统从「素材」夹检索。有可核对事实、数据、项目则写入；无对应处按用户意见做表述优化。不得编造素材没有的数字/项目名。"
        : "\n\n【素材】优先写入上述素材中的可核对事实；无对应处按用户意见优化表述。不得编造素材没有的数字/项目名。";
      out.requirement = String(out.requirement || "").trim() + "\n\n" + block + tip;
      log.info("editor.suggest.materials", {
        n: materials.length,
        auto,
        paths: materials.map((m) => m.path),
      });
    } else {
      out.requirement =
        String(out.requirement || "").trim() +
        "\n\n【素材】本次未读到素材正文：按用户修改意见做可感知改写（语气/结构/用词/条理），不得编造具体项目名与数字。";
      log.warn("editor.suggest.noMaterial", { auto, pinned: pinned.length });
    }
    // 精修核心：无论有无素材，都强制相对原文有可见差异
    if (!/硬性·精修/.test(String(out.requirement || ""))) {
      out.requirement =
        String(out.requirement || "").trim() +
        "\n\n【硬性·精修】必须按用户意见改写选区；每套相对原文（去掉空白后）不得完全相同；" +
        "即使用户只写「润色/优化/更简洁」，也须落实用词或句式变化。严禁原样返回选区。";
    }
    try {
      const cfg = gwWs.loadConfigForMd(fp).config || {};
      const wc = officialSync.buildWritingContext(
        fp,
        this.workspaceFolders(),
        cfg
      );
      if (wc.inject) {
        out.requirement =
          String(out.requirement || "").trim() +
          "\n\n" +
          wc.inject;
        out.category_code = wc.categoryCode || "";
        out.manual_code = wc.manualCode || "";
        out.reference_path = wc.referencePath || "";
        out.template_path = wc.templatePath || "";
      }
    } catch (_) { /* ignore */ }
    return out;
  }

  /**
   * 校对身份钉死：全文一律用宿主当前打开文件正文，杜绝 webview 串稿。
   */
  enrichProofreadBody(body, ctx) {
    const fp = this.activeFsPath(ctx);
    const out = Object.assign({}, body || {});
    const scope = String(out.scope || out.proof_scope || "").toLowerCase();
    const clientPath = String(out.doc_path || out.expectedPath || out.path || "").trim();
    out.doc_path = fp;
    out.doc_filename = path.basename(fp);
    if (
      clientPath &&
      path.normalize(clientPath) !== path.normalize(fp)
    ) {
      log.warn("editor.proofread.path.mismatch", {
        active: fp,
        client: clientPath,
        scope,
      });
    }
    const useHost = scope === "full" || !!out.pin_active_doc;
    if (useHost) {
      const hostText = this.activeText(ctx);
      const clientText = String(out.text || "");
      // 身份钉宿主路径；正文优先用页面刚落盘内容，避免宿主缓冲滞后导致漏检（如「绿电f布局」）
      if (clientText.trim()) {
        if (hostText && clientText !== hostText) {
          log.warn("editor.proofread.text.keptClient", {
            path: fp,
            clientChars: clientText.length,
            hostChars: String(hostText || "").length,
          });
        }
        out.text = clientText;
      } else {
        out.text = hostText;
      }
      out.scope = "full";
      out.pinned_host_doc = true;
    }
    return out;
  }

  /**
   * 对话身份钉死：路径必须对上当前打开文件；回写 doc_path 供日志/审计。
   */
  enrichChatIdentity(body, ctx) {
    const fp = this.activeFsPath(ctx);
    const out = Object.assign({}, body || {});
    delete out.__identityError;
    const clientPath = String(
      out.doc_path || out.expectedPath || out.path || ""
    ).trim();
    if (
      clientPath &&
      path.normalize(clientPath) !== path.normalize(fp)
    ) {
      out.__identityError =
        "当前打开文件已变化。宿主文件：" +
        path.basename(fp) +
        "；页面以为：" +
        path.basename(clientPath) +
        "。请重新打开目标文稿后再对话。";
      log.warn("editor.chat.path.mismatch", {
        active: fp,
        client: clientPath,
      });
      return out;
    }
    out.doc_path = fp;
    out.doc_filename = path.basename(fp);
    try {
      const cfg = gwWs.loadConfigForMd(fp).config || {};
      const wc = officialSync.buildWritingContext(
        fp,
        this.workspaceFolders(),
        cfg
      );
      if (wc.inject) {
        const prev = String(out.project_memory || "");
        out.project_memory = prev
          ? prev + "\n\n" + wc.inject
          : wc.inject;
        out.category_code = wc.categoryCode || "";
        out.manual_code = wc.manualCode || "";
        out.reference_path = wc.referencePath || "";
        out.template_path = wc.templatePath || "";
      }
    } catch (e) {
      log.warn("editor.chat.writingContext.fail", {
        message: String(e && e.message ? e.message : e),
      });
    }
    log.info("editor.chat.identity", {
      path: fp,
      docChars: String(out.doc_md || "").length,
      allow_edit: !!out.allow_edit,
      category: out.category_code || "",
      manual: out.manual_code || "",
    });
    return out;
  }

  /**
   * 对话工具环：catalog + 素材摘录始终注入；模型要文件则本机执行后再问。
   */
  async runChatToolLoop(body, ctx, webviewPanel, relay) {
    return chatToolLoop.runChatToolLoop(body, ctx, webviewPanel, relay, this);
  }

  async resolveCustomTextEditor(document, webviewPanel) {
    GongwenMdEditorProvider.tracked.add(document.uri.toString());
    const relay = await this.relayConfig();
    const editorDir = this.editorDir();
    const mediaDir = this.mediaDir();
    const state = {
      updatingFromWebview: false,
      editCount: 0,
      /** 壳内逻辑路径：侧栏切换可不换 CustomEditor 标签，避免整页闪烁 */
      shellPath: document.uri.fsPath,
      shellMd: null,
    };

    try {
      log.bindProject(document.uri.fsPath, (p) =>
        gwWs.resolveRoot(p, this.workspaceFolders())
      );
    } catch (_) { /* ignore */ }
    log.info("editor.resolve", {
      path: document.uri.fsPath,
      bytes: document.getText().length,
      serverUrl: relay.serverUrl,
      authMode: relay.authMode,
      mode: "embed-editor.html",
      projectLog: log.getProjectLogFile && log.getProjectLogFile(),
    });
    log.info("editor.paths", {
      realPath: this.realExtensionPath(),
      editorDir: editorDir.fsPath,
      editorHtml: fs.existsSync(path.join(editorDir.fsPath, "editor.html")),
    });

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaDir, editorDir],
    };

    const pushDoc = (reason) => {
      if (state.updatingFromWebview) {
        log.debug("editor.push.skip", { reason });
        return;
      }
      // 壳已切到其它文件时，锚点 TextDocument 是旧文件，禁止回推覆盖编辑器
      if (this.isShellDetached({ document, state })) {
        log.debug("editor.push.skip.detached", { reason, shell: state.shellPath });
        return;
      }
      const text = document.getText();
      webviewPanel.webview.postMessage({
        type: "setDoc",
        text,
        path: document.uri.fsPath,
        dirty: document.isDirty,
        hash: this.contentHash(text) + "-v" + document.version,
      });
    };

    const pushInit = async () => {
      const r = await this.relayConfig();
      webviewPanel.webview.postMessage({
        type: "init",
        serverUrl: r.serverUrl,
        token: r.token,
        provider: r.provider,
        authMode: r.authMode,
        capability: r.capability,
      });
      log.info("editor.init.push", {
        serverUrl: r.serverUrl,
        hasToken: !!r.token,
        authMode: r.authMode,
      });
    };

    const changePanel = webviewPanel.webview.onDidReceiveMessage((msg) =>
      this.onWebviewMessage(msg, {
        document,
        webviewPanel,
        state,
        pushDoc,
        pushInit,
      })
    );
    const changeDoc = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        pushDoc("docChanged");
      }
    });
    const changeCfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("gongwen")) pushInit();
    });
    const changeView = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) GongwenMdEditorProvider.activePanel = webviewPanel;
    });
    if (webviewPanel.active) GongwenMdEditorProvider.activePanel = webviewPanel;

    try {
      webviewPanel.webview.html = buildEmbeddedHtml(
        webviewPanel.webview,
        document,
        relay,
        { editorDir, mediaDir }
      );
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      log.error("editor.html.fail", { message: msg });
      webviewPanel.webview.html =
        "<!DOCTYPE html><html><body style='font-family:sans-serif;padding:24px'>" +
        "<h3>公文编辑器加载失败</h3><p>" +
        msg.replace(/[<>&]/g, "") +
        "</p></body></html>";
    }

    webviewPanel.onDidDispose(() => {
      log.info("editor.dispose", {
        path: document.uri.fsPath,
        edits: state.editCount,
      });
      if (GongwenMdEditorProvider.activePanel === webviewPanel) {
        GongwenMdEditorProvider.activePanel = null;
      }
      changeDoc.dispose();
      changeCfg.dispose();
      changePanel.dispose();
      changeView.dispose();
    });
  }

  rpcReply(webviewPanel, id, status, json) {
    const ok = status < 400;
    webviewPanel.webview.postMessage({
      type: "rpcResult",
      id,
      ok,
      status,
      json: json || {},
      error: json && json.error,
    });
  }

  /**
   * @param {any} msg
   * @param {{document:vscode.TextDocument, webviewPanel:vscode.WebviewPanel, state:any, pushDoc:Function, pushInit:Function}} ctx
   */
  async onWebviewMessage(msg, ctx) {
    if (!msg || typeof msg !== "object") return;
    const { document, webviewPanel, state, pushDoc, pushInit } = ctx;

    if (msg.type === "ready") {
      log.info("editor.webview.ready", { path: this.activeFsPath(ctx) });
      pushInit();
      pushDoc("ready");
      return;
    }
    if (msg.type === "clipboardWrite") {
      const text = typeof msg.text === "string" ? msg.text : "";
      try {
        await vscode.env.clipboard.writeText(text);
      } catch (e) {
        log.warn("clipboard.write.fail", {
          message: String(e && e.message ? e.message : e),
        });
      }
      return;
    }
    if (msg.type === "log") {
      const lvl = String(msg.level || "info").toLowerCase();
      const event = "editor.webview." + String(msg.message || "msg");
      const data = msg.data && typeof msg.data === "object" ? msg.data : {};
      if (lvl === "error") log.error(event, data);
      else if (lvl === "warn") log.warn(event, data);
      else if (lvl === "debug") log.debug(event, data);
      else log.info(event, data);
      return;
    }
    if (msg.type === "account") {
      const act = String(msg.action || "").toLowerCase();
      try {
        if (act === "login") await accountAuth.loginInteractive();
        else if (act === "register") await accountAuth.registerInteractive();
        else if (act === "logout") await accountAuth.logoutInteractive();
        else if (act === "syncofficial" || act === "sync") {
          await officialSync.syncInteractive();
        } else if (act === "template") {
          await officialSync.applyTemplateInteractive();
        } else await accountAuth.showAccountStatus();
        await accountAuth.refreshStatusBar();
        // 登录后刷新 init，让后续 relay 用新短票
        if (typeof ctx.pushInit === "function") await ctx.pushInit();
      } catch (e) {
        log.warn("editor.account.fail", {
          action: act,
          message: String(e && e.message ? e.message : e),
        });
      }
      return;
    }
    if (msg.type === "relay") {
      const r = await this.relayConfig();
      const method = String(msg.method || "GET").toUpperCase();
      const apiPath = String(msg.path || "");
      let body = msg.body;
      // 精修：预读 @ 引用文件，注入 materials 供云端提示使用
      if (
        method === "POST" &&
        /\/api\/suggest(?:\?|$)/.test(apiPath) &&
        body &&
        typeof body === "object"
      ) {
        try {
          body = this.enrichSuggestBody(body, ctx);
        } catch (e) {
          log.warn("editor.suggest.enrich.fail", {
            message: String(e && e.message ? e.message : e),
          });
        }
        body = this.prepareAiBody(body, r, "suggest");
      }
      // 校对：全文钉死宿主当前打开文件，杜绝串稿
      if (
        method === "POST" &&
        /\/api\/proofread(?:\?|$)/.test(apiPath) &&
        body &&
        typeof body === "object"
      ) {
        try {
          body = this.enrichProofreadBody(body, ctx);
        } catch (e) {
          log.warn("editor.proofread.enrich.fail", {
            message: String(e && e.message ? e.message : e),
          });
        }
        body = this.prepareAiBody(body, r, "proofread");
      }
      // 对话：宿主注入工作区 + 工具环（读材料与授权解耦）
      if (
        method === "POST" &&
        /\/api\/chat(?:\?|$)/.test(apiPath) &&
        body &&
        typeof body === "object"
      ) {
        try {
          body = this.enrichChatIdentity(body, ctx);
        } catch (e) {
          log.warn("editor.chat.identity.fail", {
            message: String(e && e.message ? e.message : e),
          });
        }
        if (body && body.__identityError) {
          webviewPanel.webview.postMessage({
            type: "relayResult",
            id: msg.id,
            status: 409,
            json: { error: body.__identityError },
            error: body.__identityError,
          });
          return;
        }
        body = this.prepareAiBody(body, r, "chat");
      }
      if (
        method === "POST" &&
        /\/api\/chat(?:\?|$)/.test(apiPath) &&
        body &&
        typeof body === "object"
      ) {
        try {
          const loop = await this.runChatToolLoop(body, ctx, webviewPanel, r);
          webviewPanel.webview.postMessage({
            type: "relayResult",
            id: msg.id,
            status: loop.status,
            json: loop.json,
            error: loop.json && loop.json.error,
          });
          return;
        } catch (e) {
          log.error("editor.chat.toolLoop.fail", {
            message: String(e && e.message ? e.message : e),
          });
          webviewPanel.webview.postMessage({
            type: "relayResult",
            id: msg.id,
            status: 500,
            json: { error: String(e && e.message ? e.message : e) },
            error: String(e && e.message ? e.message : e),
          });
          return;
        }
      }
      log.info("editor.relay.start", { id: msg.id, method, path: apiPath });
      const result = await relayRequest(
        r.serverUrl,
        r.token,
        method,
        apiPath,
        body
      );
      let json = result.json;
      if (
        (result.status === 401 || result.status === 402) &&
        json &&
        typeof json === "object"
      ) {
        const tip =
          result.status === 402
            ? "智能额度不足，可用「公文：查看额度」核对"
            : r.authMode === "user"
              ? "登录已失效，请重新「公文：登录账号」"
              : "未授权：请「公文：登录账号」或配置过渡用 relayToken";
        if (!json.error) json = Object.assign({}, json, { error: tip });
        else if (typeof json.error === "string" && json.error.indexOf("额度") < 0) {
          json = Object.assign({}, json, { error: json.error + "（" + tip + "）" });
        }
      }
      webviewPanel.webview.postMessage({
        type: "relayResult",
        id: msg.id,
        status: result.status,
        json,
        error: json && json.error,
      });
      return;
    }
    if (msg.type === "rpc") {
      await this.handleRpc(msg, ctx);
      return;
    }
    // 兼容旧 bridge 的 fire-and-forget
    if (msg.type === "edit") {
      if (this.isShellDetached(ctx)) {
        state.shellMd = typeof msg.text === "string" ? msg.text : state.shellMd;
      } else {
        await this.applyEditFromWebview(document, msg.text, state);
      }
      return;
    }
    if (msg.type === "save") {
      if (this.isShellDetached(ctx)) {
        const fp = this.activeFsPath(ctx);
        const md =
          state.shellMd != null ? state.shellMd : document.getText();
        await localFs.writeText(fp, md);
      } else {
        await this.saveDocument(document);
      }
      return;
    }
    if (msg.type === "saveVersion") {
      await this.saveVersionCopy(document, ctx);
    }
  }

  /** @param {{document:vscode.TextDocument, state:any}} ctx */
  activeFsPath(ctx) {
    const sp = ctx.state && ctx.state.shellPath;
    return sp ? String(sp) : ctx.document.uri.fsPath;
  }

  /** @param {{document:vscode.TextDocument, state:any}} ctx */
  isShellDetached(ctx) {
    const sp = ctx.state && ctx.state.shellPath;
    if (!sp) return false;
    return path.normalize(sp) !== path.normalize(ctx.document.uri.fsPath);
  }

  /** @param {{document:vscode.TextDocument, state:any}} ctx */
  activeText(ctx) {
    if (this.isShellDetached(ctx) && ctx.state.shellMd != null) {
      return String(ctx.state.shellMd);
    }
    return ctx.document.getText();
  }

  async handleRpc(msg, ctx) {
    const { webviewPanel } = ctx;
    const id = msg.id;
    const op = String(msg.op || "");
    try {
      const status = await this.dispatchRpc(op, msg, ctx);
      if (status == null) {
        this.rpcReply(webviewPanel, id, 400, { error: "未知操作：" + op });
      }
    } catch (e) {
      const err = String(e && e.message ? e.message : e);
      log.error("editor.rpc.fail", { op, message: err });
      this.rpcReply(webviewPanel, id, 500, { error: err });
    }
  }

  /** @returns {Promise<number|null>} HTTP 状态；未知 op 返回 null */
  async dispatchRpc(op, msg, ctx) {
    const { document, webviewPanel } = ctx;
    const id = msg.id;
    if (op === "getContent") {
      const text = this.activeText(ctx);
      const fp = this.activeFsPath(ctx);
      const ws = this.workspaceSummary(fp, false);
      this.rpcReply(webviewPanel, id, 200, {
        md: text,
        hash: this.contentHash(text) + (this.isShellDetached(ctx) ? "-shell" : "-v" + document.version),
        work_dir: path.dirname(fp),
        filename: path.basename(fp),
        path: fp,
        workspace: ws,
      });
      return 200;
    }
    if (op === "getWorkspace") {
      const fp = this.activeFsPath(ctx);
      const ws = this.workspaceSummary(fp, true);
      this.rpcReply(webviewPanel, id, 200, { ok: true, workspace: ws });
      return 200;
    }
    if (op === "listProjectFiles") {
      const fp = this.activeFsPath(ctx);
      try {
        this.rpcReply(
          webviewPanel,
          id,
          200,
          gwWs.listProjectFiles(fp, this.workspaceFolders())
        );
      } catch (e) {
        this.rpcReply(webviewPanel, id, 500, {
          error: String(e && e.message ? e.message : e),
        });
        return 500;
      }
      return 200;
    }
    if (op === "landTemplate") {
      const fp = this.activeFsPath(ctx);
      try {
        const r = gwWs.landUserTemplate(fp, {
          body_md: msg.body_md || msg.bodyMd || "",
          title: msg.title || "",
          category: msg.category || msg.categoryCode || "",
          force: !!msg.force,
        });
        this.rpcReply(webviewPanel, id, r.ok ? 200 : r.need_confirm ? 200 : 400, r);
        return r.ok || r.need_confirm ? 200 : 400;
      } catch (e) {
        this.rpcReply(webviewPanel, id, 500, {
          error: String(e && e.message ? e.message : e),
        });
        return 500;
      }
    }
    if (op === "deleteMd") return this.rpcDeleteMd(msg, ctx);
    if (op === "convertMaterials") return this.rpcConvertMaterials(msg, ctx);
    if (op === "chatsGet") {
      const fp = this.activeFsPath(ctx);
      const folders = this.workspaceFolders();
      const active = chatsStore.loadActive(fp, folders);
      const listing = chatsStore.listSessions(fp, folders);
      this.rpcReply(webviewPanel, id, 200, {
        ok: true,
        active,
        sessions: listing.sessions || [],
      });
      return 200;
    }
    if (op === "chatsSave") {
      const fp = this.activeFsPath(ctx);
      const r = chatsStore.saveSession(
        fp,
        this.workspaceFolders(),
        msg.sessionId || "",
        msg.messages || [],
        msg.title || "",
        {
          summary: msg.summary || "",
          readSet: msg.readSet || msg.read_set || [],
        }
      );
      this.rpcReply(webviewPanel, id, r.ok ? 200 : 400, r);
      return r.ok ? 200 : 400;
    }
    if (op === "chatsNew") {
      const fp = this.activeFsPath(ctx);
      const r = chatsStore.newSession(fp, this.workspaceFolders(), "新会话");
      this.rpcReply(webviewPanel, id, 200, r);
      return 200;
    }
    if (op === "memoryGet") {
      const fp = this.activeFsPath(ctx);
      const r = projectMemory.readMemory(fp, this.workspaceFolders());
      this.rpcReply(webviewPanel, id, 200, r);
      return 200;
    }
    if (op === "memoryAppend") {
      const fp = this.activeFsPath(ctx);
      const r = projectMemory.appendMemory(
        fp,
        this.workspaceFolders(),
        msg.note || msg.text || ""
      );
      this.rpcReply(webviewPanel, id, r.ok ? 200 : 400, r);
      return r.ok ? 200 : 400;
    }
    if (op === "memoryAppendScaffold") {
      const fp = this.activeFsPath(ctx);
      const r = projectMemory.appendScaffoldMemory(
        fp,
        this.workspaceFolders(),
        msg.md || "",
        msg.summary || ""
      );
      this.rpcReply(webviewPanel, id, r.ok ? 200 : 400, r);
      return r.ok ? 200 : 400;
    }
    if (op === "chatsSwitch") {
      const fp = this.activeFsPath(ctx);
      const r = chatsStore.switchSession(
        fp,
        this.workspaceFolders(),
        msg.sessionId || msg.chatId || ""
      );
      this.rpcReply(webviewPanel, id, r.ok ? 200 : 400, r);
      return r.ok ? 200 : 400;
    }
    if (op === "configGet") {
      const fp = this.activeFsPath(ctx);
      const r = gwWs.loadConfigForMd(fp);
      const cat = officialSync.listCatalog(r.root);
      this.rpcReply(webviewPanel, id, 200, Object.assign({}, r, { official: cat }));
      return 200;
    }
    if (op === "configSave") {
      const fp = this.activeFsPath(ctx);
      const r = gwWs.saveConfigForMd(fp, msg.config || msg.patch || {});
      this.rpcReply(webviewPanel, id, r.ok ? 200 : 400, r);
      return r.ok ? 200 : 400;
    }
    if (op === "pickReference" || op === "pickCompare") {
      const fp = this.activeFsPath(ctx);
      const root = gwWs.resolveRoot(fp, this.workspaceFolders());
      const isCmp = op === "pickCompare";
      const folders = gwWs.ensureUserFolders(root);
      const startDir = folders.materials || root;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Markdown: ["md"] },
        defaultUri: vscode.Uri.file(startDir),
        openLabel: isCmp ? "选为对照旧稿" : "选为参照稿",
      });
      if (!picked || !picked[0]) {
        this.rpcReply(webviewPanel, id, 200, { ok: false, cancelled: true });
        return 200;
      }
      let rel = path.relative(root, picked[0].fsPath).replace(/\\/g, "/");
      if (rel.startsWith("..")) {
        this.rpcReply(webviewPanel, id, 400, {
          error: (isCmp ? "对照稿" : "参照稿") + "须在当前工程内",
        });
        return 400;
      }
      if (path.normalize(picked[0].fsPath) === path.normalize(fp)) {
        this.rpcReply(webviewPanel, id, 400, {
          error: "不能选择当前正在编辑的文稿",
        });
        return 400;
      }
      const patch = isCmp
        ? { write: { comparePath: rel } }
        : { write: { referencePath: rel } };
      gwWs.saveConfigForMd(fp, patch);
      const payload = isCmp
        ? { ok: true, comparePath: rel }
        : { ok: true, referencePath: rel };
      if (isCmp) {
        try {
          const localCorpus = require("./localCorpus");
          const cur = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
          const cmp = localCorpus.compareDrafts(
            cur,
            picked[0].fsPath,
            rel
          );
          payload.hits = cmp.hits.length;
          payload.injectPreview = localCorpus
            .formatCompareInject(cmp)
            .slice(0, 400);
        } catch (_) {
          /* ignore */
        }
      }
      this.rpcReply(webviewPanel, id, 200, payload);
      return 200;
    }
    if (op === "save") return this.rpcSave(msg, ctx);
    if (op === "saveVersion") return this.rpcSaveVersion(msg, ctx);
    if (op === "close") return this.rpcClose(msg, ctx);
    if (op === "openPick") return this.rpcOpenPick(msg, ctx);
    if (op === "openPath") return this.rpcOpenPath(msg, ctx);
    if (op === "createMd") return this.rpcCreateMd(msg, ctx);
    if (op === "renameMd") return this.rpcRenameMd(msg, ctx);
    if (op === "importMd") return this.rpcImportMd(msg, ctx);
    if (op === "export") return this.rpcExport(msg, ctx);
    return null;
  }

  async rpcSave(msg, ctx) {
    const { document, webviewPanel } = ctx;
    const md =
      typeof msg.md === "string" ? msg.md : this.activeText(ctx);
    const fp = this.activeFsPath(ctx);
    try {
      try {
        log.bindProject(fp, (p) =>
          gwWs.resolveRoot(p, this.workspaceFolders())
        );
      } catch (_) { /* ignore */ }
      log.info("editor.save.rpc", {
        path: fp,
        bytes: String(md || "").length,
        reason: msg.reason || "",
        clientPath: msg.expectedPath || msg.path || "",
      });
      const clientPath = String(msg.expectedPath || msg.path || "").trim();
      if (
        clientPath &&
        path.normalize(clientPath) !== path.normalize(fp)
      ) {
        log.warn("editor.save.path.mismatch", {
          active: fp,
          client: clientPath,
        });
        this.rpcReply(webviewPanel, msg.id, 409, {
          error:
            "当前打开文件已变化。宿主文件：" +
            path.basename(fp) +
            "；页面以为：" +
            path.basename(clientPath) +
            "。请重新打开目标文稿后再保存。",
          path: fp,
          expectedPath: clientPath,
        });
        return 409;
      }
      // 禁止 writeText + document.save 双写（会弹「file is newer」）
      const r = await this.persistActiveMd(ctx, md);
      if (!r.ok) {
        this.rpcReply(webviewPanel, msg.id, 500, {
          error: r.error || "保存失败",
        });
        return 500;
      }
      gwWs.touchForMd(fp, this.workspaceFolders());
      this.rpcReply(webviewPanel, msg.id, 200, {
        ok: true,
        hash: r.hash,
        path: fp,
        workspace: this.workspaceSummary(fp, false),
      });
      return 200;
    } catch (e) {
      this.rpcReply(webviewPanel, msg.id, 500, {
        error: "保存失败：" + String(e && e.message ? e.message : e),
      });
      return 500;
    }
  }

  async rpcSaveVersion(msg, ctx) {
    const { document, webviewPanel, state } = ctx;
    if (typeof msg.md === "string") {
      state.shellMd = msg.md;
      if (!this.isShellDetached(ctx)) {
        await this.applyEditFromWebview(document, msg.md, state);
      }
    }
    const r = await this.saveVersionCopy(document, ctx);
    if (!r.ok) {
      this.rpcReply(webviewPanel, msg.id, 500, { error: r.error || "存版本失败" });
      return 500;
    }
    this.rpcReply(webviewPanel, msg.id, 200, {
      ok: true,
      filename: r.filename,
      hash: this.contentHash(this.activeText(ctx)) +
        (this.isShellDetached(ctx) ? "-shell" : "-v" + document.version),
    });
    return 200;
  }

  rpcClose(msg, ctx) {
    const { document, webviewPanel } = ctx;
    // 先回包再关标签，避免 webview 销毁导致前端误报失败
    this.rpcReply(webviewPanel, msg.id, 200, { ok: true });
    setTimeout(() => {
      this.closeDocumentTab(document).catch((e) => {
        log.warn("editor.close.fail", {
          message: String(e && e.message ? e.message : e),
        });
      });
    }, 30);
    return 200;
  }

  async rpcOpenPick(msg, ctx) {
    const raw = String(msg.kind || "all").toLowerCase();
    const kind = raw === "md" || raw === "docx" ? raw : "all";
    const picked = await this.pickFile(kind);
    if (!picked) {
      this.rpcReply(ctx.webviewPanel, msg.id, 400, { error: "已取消选择文件" });
      return 400;
    }
    if (/\.md$/i.test(picked)) {
      this.replyOpen(ctx.webviewPanel, msg.id, await this.switchInShell(picked, ctx));
      return 200;
    }
    this.replyOpen(
      ctx.webviewPanel,
      msg.id,
      await this.openDocumentPath(picked, false, {
        inplace: false,
        fromDocument: ctx.document,
      })
    );
    return 200;
  }

  async rpcDeleteMd(msg, ctx) {
    const { webviewPanel, state } = ctx;
    const id = msg.id;
    const fp = this.activeFsPath(ctx);
    const rel = String(msg.path || msg.rel || "").trim().replace(/\\/g, "/");
    try {
      if (!rel) {
        this.rpcReply(webviewPanel, id, 400, { ok: false, error: "缺少路径" });
        return 400;
      }
      // Webview 里 window.confirm 不可靠；确认改走宿主模态框
      const pick = await vscode.window.showWarningMessage(
        "确认删除该文件？\n" + rel,
        { modal: true },
        "删除"
      );
      if (pick !== "删除") {
        this.rpcReply(webviewPanel, id, 200, { ok: false, cancelled: true });
        return 200;
      }
      const r = gwWs.deleteProjectMd(fp, rel);
      if (!r.ok) {
        this.rpcReply(webviewPanel, id, 400, r);
        return 400;
      }
      const out = Object.assign({ ok: true }, r);
      if (r.deletedCurrent) {
        const listed = gwWs.listProjectFiles(fp, this.workspaceFolders());
        const pool = []
          .concat(listed.docs || [])
          .concat(listed.materials || [])
          .concat(listed.references || [])
          .concat(listed.templates || [])
          .concat(listed.versions || [])
          .map((x) => x && x.path)
          .filter(Boolean);
        const nextRel = pool[0] || "";
        if (nextRel) {
          const root = gwWs.resolveRoot(fp, this.workspaceFolders());
          const nextAbs = path.join(root, nextRel.replace(/\//g, path.sep));
          const sw = await this.switchInShell(nextAbs, ctx);
          if (sw && sw.ok) {
            Object.assign(out, {
              switched: true,
              md: sw.md,
              hash: sw.hash,
              path: sw.path,
              filename: sw.filename,
              work_dir: sw.work_dir,
              workspace: sw.workspace,
            });
          }
        } else {
          // 工程内已无其它 md：壳内置空稿，路径仍挂原工程根
          const root = gwWs.resolveRoot(fp, this.workspaceFolders());
          const placeholder = path.join(root, "未命名.md");
          state.shellPath = placeholder;
          state.shellMd = "# \n\n";
          out.switched = true;
          out.md = state.shellMd;
          out.hash = this.contentHash(out.md) + "-shell";
          out.path = placeholder;
          out.filename = "未命名.md";
          out.work_dir = root;
          out.workspace = this.workspaceSummary(placeholder, false);
          try {
            webviewPanel.webview.postMessage({
              type: "setDoc",
              text: out.md,
              path: placeholder,
              hash: out.hash,
              shell: true,
            });
          } catch (_) { /* ignore */ }
        }
      }
      this.rpcReply(webviewPanel, id, 200, out);
      return 200;
    } catch (e) {
      this.rpcReply(webviewPanel, id, 500, {
        error: String(e && e.message ? e.message : e),
      });
      return 500;
    }
  }

  async rpcOpenPath(msg, ctx) {
    let p = String(msg.path || "").trim();
    if (!p) {
      this.rpcReply(ctx.webviewPanel, msg.id, 400, { error: "路径不能为空" });
      return 400;
    }
    // 工程内相对路径 → 绝对路径（沙箱；锚点用壳内逻辑路径）
    if (!path.isAbsolute(p)) {
      const anchor = this.activeFsPath(ctx);
      const root = gwWs.resolveRoot(anchor, this.workspaceFolders());
      p = path.resolve(root, p.replace(/\//g, path.sep));
      try {
        localFs.assertInWorkspace(anchor, p, { mdOnly: true });
      } catch (e) {
        this.rpcReply(ctx.webviewPanel, msg.id, 400, {
          error: String(e && e.message ? e.message : e),
        });
        return 400;
      }
    }
    // 侧栏点文件：同壳软切换（不闪、正文立刻换）。Cursor 顶栏锚点 URI 暂不跟，以编辑器内标题为准。
    this.replyOpen(
      ctx.webviewPanel,
      msg.id,
      await this.switchInShell(p, ctx)
    );
    return 200;
  }

  /**
   * 同壳软切换：换逻辑路径与正文，不销毁 webview（侧栏打开主路径）。
   * @param {string} mdPath
   * @param {{document:vscode.TextDocument, webviewPanel:vscode.WebviewPanel, state:any}} ctx
   */
  async switchInShell(mdPath, ctx) {
    const { document, webviewPanel, state } = ctx;
    const p = path.normalize(String(mdPath || "").trim());
    if (!p || !(await localFs.exists(p))) {
      return { ok: false, error: "文件不存在：" + p };
    }
    if (path.extname(p).toLowerCase() !== ".md") {
      return { ok: false, error: "壳内切换仅支持 .md" };
    }
    const cur = this.activeFsPath(ctx);
    const folders = this.workspaceFolders();
    const prevRoot = gwWs.resolveRoot(cur, folders);
    if (path.normalize(cur) === p) {
      const text = this.activeText(ctx);
      return {
        ok: true,
        switched: false,
        same: true,
        soft: true,
        projectChanged: false,
        md: text,
        hash: this.contentHash(text) + "-shell",
        filename: path.basename(p),
        path: p,
        work_dir: path.dirname(p),
        workspace: this.workspaceSummary(p, false),
      };
    }

    // 前端通常已 postSave；此处再兜底落盘当前逻辑文件
    try {
      if (this.isShellDetached(ctx)) {
        if (state.shellMd != null) await localFs.writeText(cur, state.shellMd);
      } else if (document.isDirty) {
        const saved = await this.saveDocument(document);
        if (!saved) {
          return { ok: false, error: "切换前保存失败，请先保存当前文稿" };
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: "切换前保存失败：" + String(e && e.message ? e.message : e),
      };
    }

    let text = "";
    try {
      text = await localFs.readText(p);
    } catch (e) {
      return {
        ok: false,
        error: "读取失败：" + String(e && e.message ? e.message : e),
      };
    }

    state.shellPath = p;
    state.shellMd = text;
    // 落盘/创建目标工程的 .gongwen（换根时等于进入新工程）
    try {
      gwWs.touchForMd(p, folders);
      log.bindProject(p, (x) => gwWs.resolveRoot(x, folders));
    } catch (_) { /* ignore */ }
    const nextRoot = gwWs.resolveRoot(p, folders);
    const projectChanged =
      path.normalize(prevRoot) !== path.normalize(nextRoot);
    try {
      // CustomTextEditor 标签仍可能显示锚点 URI；title 尽力同步当前逻辑文件
      webviewPanel.title = path.basename(p);
    } catch (_) { /* ignore */ }

    const hash = this.contentHash(text) + "-shell";
    webviewPanel.webview.postMessage({
      type: "setDoc",
      text,
      path: p,
      hash,
      shell: true,
    });

    log.info("editor.switchInShell", {
      from: cur,
      to: p,
      bytes: text.length,
      projectChanged,
      prevRoot,
      nextRoot,
    });
    return {
      ok: true,
      switched: false,
      inplace: true,
      soft: true,
      projectChanged,
      md: text,
      hash,
      filename: path.basename(p),
      path: p,
      work_dir: path.dirname(p),
      workspace: this.workspaceSummary(p, false),
    };
  }

  /** 重命名当前逻辑 md（同目录）；走 shellPath，勿误改锚点 URI、勿 openWith 空文件 */
  async rpcRenameMd(msg, ctx) {
    const { document, webviewPanel, state } = ctx;
    let name = String(msg.filename || msg.rename || "").trim();
    name = path.basename(name.replace(/\\/g, "/"));
    if (!name) {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "新文件名不能为空" });
      return 400;
    }
    if (!/\.md$/i.test(name)) name += ".md";
    const oldPath = this.activeFsPath(ctx);
    if (!oldPath) {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "当前无打开文件" });
      return 400;
    }
    const newPath = path.join(path.dirname(oldPath), name);
    try {
      localFs.assertInWorkspace(oldPath, newPath, { mdOnly: true });
    } catch (e) {
      this.rpcReply(webviewPanel, msg.id, 400, {
        error: String(e && e.message ? e.message : e),
      });
      return 400;
    }
    const md =
      typeof msg.md === "string" ? msg.md : this.activeText(ctx);
    if (path.normalize(newPath) === path.normalize(oldPath)) {
      this.rpcReply(webviewPanel, msg.id, 200, {
        ok: true,
        renamed: false,
        soft: true,
        path: oldPath,
        filename: path.basename(oldPath),
        md,
        hash: this.contentHash(md) + "-shell",
        work_dir: path.dirname(oldPath),
        workspace: this.workspaceSummary(oldPath, false),
      });
      return 200;
    }
    if (await localFs.exists(newPath)) {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "目标已存在：" + name });
      return 400;
    }
    if (!(await localFs.exists(oldPath))) {
      this.rpcReply(webviewPanel, msg.id, 400, {
        error: "源文件不存在：" + oldPath,
      });
      return 400;
    }
    try {
      // 锚点文件勿先 writeText 再 save/rename，否则 VS Code 报 file newer
      if (
        !this.isShellDetached(ctx) &&
        path.normalize(oldPath) === path.normalize(document.uri.fsPath)
      ) {
        await this.applyEditFromWebview(document, md, state);
        if (!(await this.saveDocument(document))) {
          this.rpcReply(webviewPanel, msg.id, 500, { error: "重命名前保存失败" });
          return 500;
        }
      } else {
        await localFs.writeText(oldPath, md);
      }
      await localFs.renameFile(oldPath, newPath);
    } catch (e) {
      this.rpcReply(webviewPanel, msg.id, 500, {
        error: "重命名失败：" + String(e && e.message ? e.message : e),
      });
      return 500;
    }
    state.shellPath = newPath;
    state.shellMd = md;
    try {
      const folders = this.workspaceFolders();
      gwWs.touchForMd(newPath, folders);
      log.bindProject(newPath, (x) => gwWs.resolveRoot(x, folders));
    } catch (_) { /* ignore */ }
    try {
      webviewPanel.title = name;
    } catch (_) { /* ignore */ }
    const hash = this.contentHash(md) + "-shell";
    webviewPanel.webview.postMessage({
      type: "setDoc",
      text: md,
      path: newPath,
      hash,
      shell: true,
    });
    this.rpcReply(webviewPanel, msg.id, 200, {
      ok: true,
      renamed: true,
      soft: true,
      path: newPath,
      filename: name,
      md,
      hash,
      work_dir: path.dirname(newPath),
      workspace: this.workspaceSummary(newPath, false),
    });
    return 200;
  }

  /** 另存为新建 md，并用公文编辑器打开（新标签） */
  async rpcCreateMd(msg, ctx) {
    const { document, webviewPanel } = ctx;
    let p = String(msg.path || "").trim();
    if (!p) {
      // 默认落到工程根（与左侧「文稿」同一层），不跟当前子目录走
      let dir = "";
      try {
        if (document.uri.scheme === "file") {
          dir = gwWs.resolveRoot(document.uri.fsPath, this.workspaceFolders());
        }
      } catch (_) { /* ignore */ }
      if (!dir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
        dir = vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
      const defaultUri = vscode.Uri.file(
        path.join(dir || os.homedir(), "未命名.md")
      );
      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ["md"] },
        saveLabel: "创建",
        title: "创建 md 文件",
      });
      if (!uri) {
        this.rpcReply(webviewPanel, msg.id, 400, { error: "已取消创建" });
        return 400;
      }
      p = uri.fsPath;
    }
    if (path.extname(p).toLowerCase() !== ".md") p = p + ".md";
    const stem = path.basename(p, path.extname(p));
    const heading = String(msg.title || stem || "标题").trim() || "标题";
    const text = "# " + heading + "\n\n";
    const anchor =
      document.uri.scheme === "file"
        ? document.uri.fsPath
        : (vscode.workspace.workspaceFolders &&
            vscode.workspace.workspaceFolders[0] &&
            vscode.workspace.workspaceFolders[0].uri.fsPath) ||
          p;
    // 对话/RPC 指定路径：必须在工作区内；另存为对话框由用户亲手选，允许区外
    const fromDialog = !String(msg.path || "").trim();
    try {
      if (!fromDialog) {
        p = await localFs.createMdInWorkspace(anchor, p, text);
      } else {
        await localFs.writeText(p, text);
      }
    } catch (e) {
      this.rpcReply(webviewPanel, msg.id, 500, {
        error: "创建失败：" + String(e && e.message ? e.message : e),
      });
      return 500;
    }
    try {
      gwWs.touchForMd(p, this.workspaceFolders());
    } catch (_) { /* ignore */ }
    const opened = await this.switchInShell(p, ctx);
    this.rpcReply(webviewPanel, msg.id, opened.ok ? 200 : 400, {
      ...opened,
      created: true,
      md: opened.md != null ? opened.md : text,
      filename: path.basename(p),
      path: p,
      work_dir: path.dirname(p),
      workspace: this.workspaceSummary(p, false),
    });
    return opened.ok ? 200 : 400;
  }

  /** 导入外部 md → 写入当前文档缓冲区（不换文件、不开新标签） */
  async rpcImportMd(msg, ctx) {
    const { document, webviewPanel, state } = ctx;
    let p = String(msg.path || "").trim();
    if (!p) {
      p = await this.pickFile("md", "导入");
      if (!p) {
        this.rpcReply(webviewPanel, msg.id, 400, { error: "已取消选择文件" });
        return 400;
      }
    }
    if (path.extname(p).toLowerCase() !== ".md") {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "请选择 .md 文件" });
      return 400;
    }
    // 导入：优先区内；区外须用户亲手选文件（无 path 走对话框）
    if (String(msg.path || "").trim()) {
      try {
        localFs.assertInWorkspace(document.uri.fsPath, p, { mdOnly: true });
      } catch (e) {
        this.rpcReply(webviewPanel, msg.id, 400, {
          error: String(e && e.message ? e.message : e),
        });
        return 400;
      }
    }
    if (!(await localFs.exists(p))) {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "文件不存在：" + p });
      return 400;
    }
    const name = path.basename(p);
    if (!msg.force) {
      this.rpcReply(webviewPanel, msg.id, 200, {
        ok: false,
        need_confirm: true,
        path: p,
        filename: name,
        message:
          "将用「" +
          name +
          "」覆盖当前文稿内容（覆盖前可先「存版本」）。\n当前文件路径不变。\n\n确定导入？",
      });
      return 200;
    }
    let text;
    try {
      text = await localFs.readText(p);
    } catch (e) {
      this.rpcReply(webviewPanel, msg.id, 500, {
        error: "读取失败：" + String(e && e.message ? e.message : e),
      });
      return 500;
    }
    await this.applyEditFromWebview(document, text, state);
    if (!(await this.saveDocument(document))) {
      this.rpcReply(webviewPanel, msg.id, 500, { error: "导入后保存失败" });
      return 500;
    }
    const fp = document.uri.fsPath;
    this.rpcReply(webviewPanel, msg.id, 200, {
      ok: true,
      imported: true,
      md: text,
      hash: this.contentHash(text) + "-v" + document.version,
      filename: name,
      path: fp,
      work_dir: path.dirname(fp),
    });
    return 200;
  }

  async rpcExport(msg, ctx) {
    const { document, webviewPanel, state } = ctx;
    if (String(msg.fmt || "docx").toLowerCase() !== "docx") {
      this.rpcReply(webviewPanel, msg.id, 400, { error: "仅支持导出 docx" });
      return 400;
    }
    const fp = this.activeFsPath(ctx);
    if (typeof msg.md === "string") {
      const r = await this.persistActiveMd(ctx, msg.md);
      if (!r.ok) {
        this.rpcReply(webviewPanel, msg.id, 500, {
          error: r.error || "导出前保存失败",
        });
        return 500;
      }
    } else if (this.isShellDetached(ctx)) {
      await localFs.writeText(fp, this.activeText(ctx));
    } else if (document.isDirty) {
      await this.saveDocument(document);
    }
    const r = await this.exportDocxFromPath(fp);
    if (!r.ok) {
      this.rpcReply(webviewPanel, msg.id, 500, { error: r.error || "导出失败" });
      return 500;
    }
    this.rpcReply(webviewPanel, msg.id, 200, {
      ok: true,
      path: r.path,
      filename: path.basename(r.path),
      vscode: true,
    });
    return 200;
  }

  replyOpen(webviewPanel, id, result) {
    if (result.need_confirm) {
      this.rpcReply(webviewPanel, id, 200, result);
      return;
    }
    if (!result.ok) {
      this.rpcReply(webviewPanel, id, 400, {
        error: result.error || "打开失败",
      });
      return;
    }
    this.rpcReply(webviewPanel, id, 200, result);
  }

  async pickFile(kind, openLabel) {
    const k = String(kind || "all").toLowerCase();
    let filters;
    let label = openLabel;
    if (k === "md") {
      filters = { Markdown: ["md"] };
      label = label || "打开";
    } else if (k === "docx") {
      filters = { Word: ["docx"] };
      label = label || "打开 docx";
    } else {
      filters = { 文稿: ["md", "docx"], Markdown: ["md"], Word: ["docx"] };
      label = label || "打开";
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: label,
      filters,
    });
    if (!uris || !uris.length) return "";
    return uris[0].fsPath;
  }

  /**
   * 打开 md/docx。默认 inplace：openWith 新标签并关掉旧壳，Cursor 标签随真实文件变。
   * docx 转为同目录同名 md，再 openWith（不写旁侧 work/）。
   * @param {string} filePath
   * @param {boolean} force
   * @param {{inplace?:boolean, fromDocument?:vscode.TextDocument, fromCtx?:any, skipConvert?:boolean}} [opts]
   */
  async openDocumentPath(filePath, force, opts) {
    const options = opts || {};
    const from = options.fromDocument;
    const fromCtx = options.fromCtx;
    const inplace = options.inplace !== false && !!from;
    const p = path.normalize(String(filePath || "").trim());
    if (!p || !fs.existsSync(p)) {
      return { ok: false, error: "文件不存在：" + p };
    }
    const ext = path.extname(p).toLowerCase();
    if (ext !== ".md" && ext !== ".docx") {
      return { ok: false, error: "仅支持 .docx 或 .md" };
    }

    let mdPath = p;
    if (ext === ".docx" && !options.skipConvert) {
      const conv = await this.convertDocxToMd(p, force);
      if (conv.need_confirm) return conv;
      if (!conv.ok) return conv;
      mdPath = conv.md_path;
    }

    // 软壳已切走时：先落盘逻辑文件，再硬开目标（禁止把锚点脏缓冲当成目标稿）
    if (fromCtx && this.isShellDetached(fromCtx)) {
      const logical = this.activeFsPath(fromCtx);
      const md = this.activeText(fromCtx);
      try {
        if (logical && md != null) await localFs.writeText(logical, md);
      } catch (e) {
        return {
          ok: false,
          error: "切换前保存失败：" + String(e && e.message ? e.message : e),
        };
      }
    }

    if (from && path.normalize(from.uri.fsPath) === path.normalize(mdPath)) {
      // 回到锚点文件：清掉软壳，用磁盘/文档正文
      if (fromCtx && fromCtx.state) {
        fromCtx.state.shellPath = from.uri.fsPath;
        fromCtx.state.shellMd = null;
      }
      const text = from.getText();
      return {
        ok: true,
        switched: false,
        same: true,
        soft: false,
        md: text,
        hash: this.contentHash(text) + "-v" + from.version,
        filename: path.basename(mdPath),
        path: mdPath,
        work_dir: path.dirname(mdPath),
        workspace: this.workspaceSummary(mdPath, false),
      };
    }

    if (inplace && from && from.isDirty) {
      const saved = await this.saveDocument(from);
      if (!saved) {
        return { ok: false, error: "切换前保存失败，请先保存当前文稿" };
      }
    }

    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand("vscode.openWith", uri, GongwenMdEditorProvider.viewType, {
      preview: !!inplace,
      preserveFocus: false,
    });

    if (inplace && from) {
      // 关掉旧锚点标签，避免「src2 幽灵页 + 新文稿」双开
      const oldUri = from.uri.toString();
      const closer = () =>
        this.closeDocumentTab(from, { fallbackActive: false }).catch((e) => {
          log.warn("editor.inplace.closePrev.fail", {
            path: oldUri,
            message: String(e && e.message ? e.message : e),
          });
        });
      await closer();
      setTimeout(closer, 120);
    }

    const text = await fs.promises.readFile(mdPath, "utf8");
    return {
      ok: true,
      switched: true,
      inplace: !!inplace,
      soft: false,
      md: text,
      hash: this.contentHash(text),
      filename: path.basename(mdPath),
      path: mdPath,
      work_dir: path.dirname(mdPath),
      workspace: this.workspaceSummary(mdPath, false),
    };
  }

  async convertDocxToMd(docxPath, force) {
    // 与 md 同目录落盘，不再写到旁侧 work/（工作目录=文件所在根，不牵扯别处）
    const d = path.dirname(docxPath);
    const n = path.basename(docxPath, path.extname(docxPath));
    const mdPath = path.join(d, n + ".md");
    const snapDir = path.join(d, "快照");
    fs.mkdirSync(snapDir, { recursive: true });

    if (fs.existsSync(mdPath) && !force) {
      return {
        ok: false,
        need_confirm: true,
        path: docxPath,
        md_path: mdPath,
        filename: path.basename(docxPath),
        message:
          "同目录已有「" +
          path.basename(mdPath) +
          "」。\n打开 docx 会按 Word 重新转换并覆盖该 md（覆盖前会先存一份快照）。\n日常请改用「打开 md」。\n\n确定覆盖？",
      };
    }

    if (fs.existsSync(mdPath)) {
      await this.snapshotMd(mdPath, snapDir);
    }

    const r = await this.convertDocxToTarget(docxPath, mdPath);
    if (!r.ok) return r;
    return { ok: true, md_path: mdPath };
  }

  /** 源文件 → 指定 md（素材转换；源文件不删） */
  async convertSourceToTarget(srcPath, mdPath) {
    const ext = path.extname(srcPath).toLowerCase();
    let script = "";
    if (ext === ".docx") script = "docx2md.py";
    else if (ext === ".txt") script = "txt2md.py";
    else if (ext === ".pdf") script = "pdf2md.py";
    else {
      return { ok: false, error: "暂不支持转换：" + ext };
    }
    const tmp = mdPath + ".converting";
    const run = await this.runConverter(script, [srcPath, tmp]);
    if (run.code !== 0) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) { /* ignore */ }
      return {
        ok: false,
        error:
          path.basename(script, ".py") +
          " 失败：" +
          (run.stderr || run.stdout || "未知错误").trim(),
      };
    }
    try {
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
      fs.renameSync(tmp, mdPath);
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) { /* ignore */ }
      return {
        ok: false,
        error: "写入 md 失败：" + String(e && e.message ? e.message : e),
      };
    }
    return { ok: true, md_path: mdPath };
  }

  /** @deprecated 使用 convertSourceToTarget */
  async convertDocxToTarget(docxPath, mdPath) {
    return this.convertSourceToTarget(docxPath, mdPath);
  }

  async rpcConvertMaterials(msg, ctx) {
    const { webviewPanel } = ctx;
    const force = !!msg.force;
    const fp = this.activeFsPath(ctx);
    const listed = gwWs.listMaterialSources(fp);
    if (!listed.ok) {
      this.rpcReply(webviewPanel, msg.id, 400, listed);
      return 400;
    }
    const items = listed.items || [];
    if (!items.length) {
      this.rpcReply(webviewPanel, msg.id, 200, {
        ok: true,
        converted: [],
        skipped: [],
        failed: [],
        message: "素材夹中没有可转换的文件（.docx / .txt / .pdf）",
      });
      return 200;
    }
    const converted = [];
    const skipped = [];
    const failed = [];
    const needConfirm = [];
    for (const it of items) {
      if (it.hasMd && !force) {
        skipped.push(it.name);
        needConfirm.push({ name: it.name, md: it.relMd });
        continue;
      }
      const r = await this.convertSourceToTarget(it.src, it.md);
      if (r.ok) converted.push(it.name);
      else failed.push({ name: it.name, error: r.error || "失败" });
    }
    log.info("editor.convertMaterials", {
      force,
      converted: converted.length,
      skipped: skipped.length,
      failed: failed.length,
    });
    this.rpcReply(webviewPanel, msg.id, 200, {
      ok: failed.length === 0,
      converted,
      skipped,
      failed,
      need_confirm: needConfirm,
      message:
        "已转换 " +
        converted.length +
        " 个" +
        (skipped.length ? "，跳过 " + skipped.length + " 个（已有 md）" : "") +
        (failed.length ? "，失败 " + failed.length + " 个" : ""),
    });
    return 200;
  }

  async snapshotMd(mdPath, snapDir) {
    try {
      fs.mkdirSync(snapDir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[-:TZ.]/g, "")
        .slice(0, 14);
      let dst = path.join(snapDir, "快照_" + stamp + ".md");
      let i = 2;
      while (fs.existsSync(dst)) {
        dst = path.join(snapDir, "快照_" + stamp + "_" + i + ".md");
        i += 1;
      }
      await fs.promises.copyFile(mdPath, dst);
    } catch (e) {
      log.warn("editor.snapshot.fail", {
        message: String(e && e.message ? e.message : e),
      });
    }
  }

  async exportDocx(document) {
    return this.exportDocxFromPath(document.uri.fsPath);
  }

  async exportDocxFromPath(mdPath) {
    const base = path.basename(mdPath, path.extname(mdPath));
    const defaultUri = vscode.Uri.file(
      path.join(path.dirname(mdPath), base + ".docx")
    );
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Word: ["docx"] },
      saveLabel: "导出 docx",
    });
    if (!saveUri) return { ok: false, error: "已取消导出" };

    const run = await this.runConverter("md2docx.py", [mdPath, saveUri.fsPath]);
    if (run.code !== 0) {
      return {
        ok: false,
        error:
          "md2docx 转换失败：" +
          (run.stderr || run.stdout || "未知错误").trim() +
          "（请确认 Word 未占用目标 docx）",
      };
    }
    vscode.window.setStatusBarMessage("已导出 · " + path.basename(saveUri.fsPath), 5000);
    try {
      await vscode.commands.executeCommand("revealFileInOS", saveUri);
    } catch (_) { /* ignore */ }
    return { ok: true, path: saveUri.fsPath };
  }

  async runConverter(script, args) {
    const scriptPath = path.join(this.toolsDir(), script);
    if (!fs.existsSync(scriptPath)) {
      return { code: 1, stdout: "", stderr: "找不到脚本：" + scriptPath };
    }
    const bins = [];
    if (process.env.GONGWEN_PYTHON) bins.push({ cmd: process.env.GONGWEN_PYTHON, prefix: [] });
    bins.push({ cmd: "python", prefix: [] });
    if (process.platform === "win32") bins.push({ cmd: "py", prefix: ["-3"] });

    let last = { code: 1, stdout: "", stderr: "未找到 Python" };
    for (const b of bins) {
      try {
        const { stdout, stderr } = await execFileAsync(
          b.cmd,
          b.prefix.concat([scriptPath], args),
          { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
        );
        return { code: 0, stdout: stdout || "", stderr: stderr || "" };
      } catch (e) {
        if (e && e.code === "ENOENT") {
          last = { code: 1, stdout: "", stderr: "未找到：" + b.cmd };
          continue;
        }
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: (e && e.stdout) || "",
          stderr: (e && e.stderr) || String(e && e.message ? e.message : e),
        };
      }
    }
    return last;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {{fallbackActive?: boolean}} [opts] fallbackActive 默认 true（用户点关闭）；
   *   壳内切换必须 false，否则旧标签已被 preview 替换时会误关新打开的文稿。
   */
  async closeDocumentTab(document, opts) {
    const fallbackActive = !opts || opts.fallbackActive !== false;
    const target = document.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!input) continue;
        const uri = input.uri || (input.modified && input.modified.uri);
        if (uri && uri.toString() === target) {
          await vscode.window.tabGroups.close(tab);
          return true;
        }
      }
    }
    if (fallbackActive) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      return true;
    }
    log.info("editor.close.prev.skip", {
      path: target,
      reason: "tab-already-replaced",
    });
    return false;
  }

  async applyEditFromWebview(document, text, state) {
    const next = typeof text === "string" ? text : "";
    if (next === document.getText()) {
      log.debug("editor.edit.noop");
      return;
    }
    state.editCount += 1;
    log.info("editor.edit.apply", {
      n: state.editCount,
      from: document.getText().length,
      to: next.length,
    });
    state.updatingFromWebview = true;
    try {
      await this.replaceWholeDocument(document, next);
    } catch (e) {
      log.error("editor.edit.fail", {
        message: String(e && e.message ? e.message : e),
      });
    } finally {
      state.updatingFromWebview = false;
    }
  }

  /**
   * 落盘当前逻辑 md：锚点只走 TextDocument.save；软切只走 writeText。禁止双写。
   * @param {{document:vscode.TextDocument, state:any}} ctx
   * @param {string} md
   * @returns {Promise<{ok:boolean, hash?:string, error?:string}>}
   */
  async persistActiveMd(ctx, md) {
    const { document, state } = ctx;
    const text = typeof md === "string" ? md : "";
    const fp = this.activeFsPath(ctx);
    state.shellPath = fp;
    state.shellMd = text;
    if (this.isShellDetached(ctx)) {
      await localFs.writeText(fp, text);
      log.info("editor.persist.shell", { path: fp, bytes: text.length });
      return { ok: true, hash: this.contentHash(text) + "-shell" };
    }
    await this.applyEditFromWebview(document, text, state);
    if (!(await this.saveDocument(document))) {
      return { ok: false, error: "保存失败" };
    }
    return {
      ok: true,
      hash: this.contentHash(text) + "-v" + document.version,
    };
  }

  async saveDocument(document) {
    log.info("editor.save.request", { path: document.uri.fsPath });
    try {
      const ok = await document.save();
      log.info("editor.save.result", { ok, dirty: document.isDirty });
      return !!ok;
    } catch (e) {
      log.error("editor.save.fail", {
        message: String(e && e.message ? e.message : e),
      });
      vscode.window.showErrorMessage(
        "保存失败：" + String(e && e.message ? e.message : e)
      );
      return false;
    }
  }

  async saveVersionCopy(document, ctx) {
    try {
      const anchor = ctx ? this.activeFsPath(ctx) : document.uri.fsPath;
      const body = ctx ? this.activeText(ctx) : document.getText();
      const folders = gwWs.ensureUserFolders(
        gwWs.resolveRoot(anchor, this.workspaceFolders())
      );
      const dir = folders.versions;
      const base = path.basename(anchor, path.extname(anchor));
      const stamp = new Date()
        .toISOString()
        .replace(/[-:TZ.]/g, "")
        .slice(0, 14);
      const fp = path.join(dir, base + "_" + stamp + ".md");
      localFs.assertInWorkspace(anchor, fp, { mdOnly: true });
      await localFs.writeText(fp, body);
      log.info("editor.saveVersion.ok", { path: fp });
      vscode.window.setStatusBarMessage(
        "已存版本 · 版本/" + path.basename(fp),
        4000
      );
      return { ok: true, filename: path.basename(fp) };
    } catch (e) {
      const err = String(e && e.message ? e.message : e);
      log.error("editor.saveVersion.fail", { message: err });
      return { ok: false, error: err };
    }
  }

  async replaceWholeDocument(document, text) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(document.uri, full, text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      log.error("editor.applyEdit.false", { path: document.uri.fsPath });
      vscode.window.showErrorMessage(
        "公文 MD：写回编辑器缓冲区失败（不会另写一份覆盖磁盘）"
      );
    } else {
      log.debug("editor.applyEdit.ok", { bytes: text.length });
    }
  }
}

module.exports = { GongwenMdEditorProvider };
