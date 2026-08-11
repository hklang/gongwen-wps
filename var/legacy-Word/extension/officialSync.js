/**
 * 官方内容包：云端只读下发 → 本机 .gongwen/official/
 * 禁止把用户正文回传云端。
 */
const fs = require("fs");
const path = require("path");
const gwWs = require("./gongwenWorkspace");
const localCorpus = require("./localCorpus");

const OFFICIAL_REL = path.join(".gongwen", "official");

/** 未同步云包时的默认剧本（文案权威：relay control_content.SUMMARY_FLOW_STAGES） */
const DEFAULT_PLAYBOOK = {
  code: "summary-flow",
  title: "工作总结分步写",
  category_id: null,
  version: "local",
  stages: [
    {
      id: "intent",
      title: "立意",
      hint: "先定读者与主旨；可选参照稿学口气",
      prompt:
        "帮助用户明确本稿读者、主旨一句话、不写的边界。只讨论立意，勿大段正文。",
      tab: "write",
    },
    {
      id: "outline",
      title: "搭架",
      hint: "先一、二、三级标题，再填血肉",
      prompt: "帮助搭标题骨架；输出可落稿的层级标题，少写段落正文。",
      tab: "write",
    },
    {
      id: "fill",
      title: "充填",
      hint: "据实写数，素材不足标明待核实",
      prompt:
        "按已有标题充填事实与数据；无依据不编造数字；可提示需读哪些素材。",
      tab: "write",
    },
    {
      id: "polish",
      title: "精修",
      hint: "语气、条理、去套话",
      prompt: "进入精修：按用户意见改写选区，必须有可见差异，禁原样返回。",
      tab: "suite",
    },
    {
      id: "proof",
      title: "校对",
      hint: "标点、错别字、规范用语",
      prompt:
        "引导用户使用校对 Tab 做定稿检查；勿在对话里假装已完成校对引擎。",
      tab: "proof",
    },
  ],
};

function vscodeApi() {
  return require("vscode");
}

function resolveRoot(mdPath) {
  let folders = [];
  try {
    folders = vscodeApi().workspace.workspaceFolders || [];
  } catch (_) {
    /* node 冒烟无 vscode */
  }
  return gwWs.resolveRoot(mdPath || "", folders);
}

function officialDir(root) {
  return path.join(path.resolve(root), OFFICIAL_REL);
}

function safeCode(code) {
  return (
    String(code || "")
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "item"
  );
}

function normalizePlaybook(p) {
  if (!p || typeof p !== "object") return null;
  const stages = Array.isArray(p.stages)
    ? p.stages.filter((s) => s && typeof s === "object")
    : [];
  if (!stages.length) return null;
  return {
    code: String(p.code || "").trim() || "playbook",
    title: String(p.title || p.code || "剧本"),
    category_id: p.category_id != null ? p.category_id : null,
    version: String(p.version || ""),
    stages: stages.map((s) => ({
      id: String(s.id || "").trim(),
      title: String(s.title || s.id || ""),
      hint: String(s.hint || ""),
      prompt: String(s.prompt || ""),
      tab: ["write", "suite", "proof"].includes(s.tab) ? s.tab : "write",
    })),
  };
}

function writePack(root, pack) {
  const base = officialDir(root);
  fs.mkdirSync(path.join(base, "manuals"), { recursive: true });
  fs.mkdirSync(path.join(base, "templates"), { recursive: true });
  fs.mkdirSync(path.join(base, "playbooks"), { recursive: true });
  const playbooks = [];
  for (const raw of pack.playbooks || []) {
    const pb = normalizePlaybook(raw);
    if (!pb) continue;
    playbooks.push({
      code: pb.code,
      title: pb.title,
      version: pb.version,
      category_id: pb.category_id,
    });
    fs.writeFileSync(
      path.join(base, "playbooks", safeCode(pb.code) + ".json"),
      JSON.stringify(pb, null, 2),
      "utf8"
    );
  }
  const meta = {
    synced_at: new Date().toISOString(),
    pack_version: pack.pack_version || 0,
    categories: pack.categories || [],
    manuals: (pack.manuals || []).map((m) => ({
      code: m.code,
      title: m.title,
      version: m.version,
      category_id: m.category_id,
    })),
    templates: (pack.templates || []).map((t) => ({
      code: t.code,
      title: t.title,
      version: t.version,
      category_id: t.category_id,
    })),
    playbooks,
  };
  fs.writeFileSync(
    path.join(base, "index.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );
  for (const m of pack.manuals || []) {
    const fp = path.join(base, "manuals", safeCode(m.code) + ".md");
    const head =
      "<!-- official manual " +
      String(m.code) +
      " v" +
      String(m.version || "") +
      " -->\n\n";
    fs.writeFileSync(fp, head + String(m.body_md || ""), "utf8");
  }
  for (const t of pack.templates || []) {
    const fp = path.join(base, "templates", safeCode(t.code) + ".md");
    const head =
      "<!-- official template " +
      String(t.code) +
      " v" +
      String(t.version || "") +
      " -->\n\n";
    fs.writeFileSync(fp, head + String(t.body_md || ""), "utf8");
  }
  return {
    ok: true,
    path: OFFICIAL_REL.replace(/\\/g, "/"),
    manuals: (pack.manuals || []).length,
    templates: (pack.templates || []).length,
    categories: (pack.categories || []).length,
    playbooks: playbooks.length,
  };
}

function readLocalIndex(root) {
  const fp = path.join(officialDir(root), "index.json");
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (_) {
    return null;
  }
}

function readLocalPlaybook(root, code) {
  const fp = path.join(
    officialDir(root),
    "playbooks",
    safeCode(code) + ".json"
  );
  if (!fs.existsSync(fp)) return null;
  try {
    return normalizePlaybook(JSON.parse(fs.readFileSync(fp, "utf8")));
  } catch (_) {
    return null;
  }
}

function listLocalPlaybooks(root) {
  const dir = path.join(officialDir(root), "playbooks");
  const out = [];
  if (fs.existsSync(dir)) {
    for (const n of fs.readdirSync(dir)) {
      if (!n.toLowerCase().endsWith(".json")) continue;
      const pb = readLocalPlaybook(root, n.replace(/\.json$/i, ""));
      if (pb) out.push(pb);
    }
  }
  return out;
}

function listLocalTemplates(root) {
  const dir = path.join(officialDir(root), "templates");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .map((n) => ({
      file: n,
      path: path.join(OFFICIAL_REL, "templates", n).replace(/\\/g, "/"),
    }));
}

function activeMdPath() {
  try {
    const ed = vscodeApi().window.activeTextEditor;
    if (ed && ed.document.uri.scheme === "file") return ed.document.uri.fsPath;
  } catch (_) {
    /* node 冒烟 */
  }
  return "";
}

async function syncFromCloud(mdPath) {
  const { relayRequest } = require("./relayProxy");
  const accountAuth = require("./accountAuth");
  const root = resolveRoot(mdPath);
  const base = accountAuth.serverUrl();
  if (!base) throw new Error("未配置 gongwen.serverUrl");
  const auth = await accountAuth.resolveAuthToken();
  if (!auth.token) throw new Error("请先登录账号或配置过渡令牌");
  const r = await relayRequest(base, auth.token, "GET", "/api/content/pack");
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) {
    throw new Error((r.json && r.json.error) || "HTTP " + r.status);
  }
  const result = writePack(root, r.json);
  try {
    require("./log").info("official.sync.ok", result);
  } catch (_) {
    /* ignore */
  }
  return result;
}

async function syncInteractive() {
  const vscode = vscodeApi();
  const mdPath = activeMdPath();
  try {
    const r = await syncFromCloud(mdPath);
    vscode.window.showInformationMessage(
      `官方包已同步：手册 ${r.manuals} · 模板 ${r.templates} · 剧本 ${r.playbooks} · 分类 ${r.categories} → ${r.path}`
    );
    return r;
  } catch (e) {
    vscode.window.showErrorMessage(
      "同步官方包失败：" + String(e && e.message ? e.message : e)
    );
    return null;
  }
}

async function applyTemplateInteractive() {
  const vscode = vscodeApi();
  const mdPath = activeMdPath();
  const root = resolveRoot(mdPath);
  let local = listLocalTemplates(root);
  if (!local.length) {
    const ok = await vscode.window.showInformationMessage(
      "本机尚无官方模板，是否先同步？",
      "同步"
    );
    if (ok !== "同步") return;
    const syn = await syncFromCloud(mdPath);
    if (!syn) return;
    local = listLocalTemplates(root);
  }
  if (!local.length) {
    vscode.window.showWarningMessage("官方包里没有模板");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    local.map((t) => ({ label: t.file, description: t.path, t })),
    { placeHolder: "选择官方模板（将新建本地 md，不覆盖当前稿）" }
  );
  if (!pick) return;
  const src = path.join(root, pick.t.path.replace(/\//g, path.sep));
  const body = fs.readFileSync(src, "utf8");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const destName = "草稿-" + stamp + "-" + pick.t.file;
  const destDir = path.dirname(mdPath || path.join(root, "draft.md"));
  const dest = path.join(destDir, destName);
  if (fs.existsSync(dest)) {
    vscode.window.showErrorMessage("目标已存在：" + destName);
    return;
  }
  fs.writeFileSync(dest, body, "utf8");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dest));
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage("已从官方模板新建：" + destName);
}

function listCatalog(root) {
  const idx = readLocalIndex(root) || {
    categories: [],
    manuals: [],
    templates: [],
    playbooks: [],
  };
  let playbooks = listLocalPlaybooks(root);
  if (!playbooks.length) playbooks = [DEFAULT_PLAYBOOK];
  return {
    ok: true,
    path: OFFICIAL_REL.replace(/\\/g, "/"),
    synced_at: idx.synced_at || "",
    categories: idx.categories || [],
    manuals: idx.manuals || [],
    templates: idx.templates || [],
    playbooks,
  };
}

function resolvePlaybook(root, write) {
  const w = write || {};
  const catalog = listCatalog(root);
  const list = catalog.playbooks || [];
  const code = String(w.playbookCode || "").trim();
  let pb = code ? list.find((p) => p.code === code) : null;
  if (!pb && w.categoryCode) {
    const cats = catalog.categories || [];
    const cat = cats.find((c) => c.code === w.categoryCode);
    if (cat && cat.id != null) {
      pb = list.find((p) => p.category_id === cat.id) || null;
    }
  }
  if (!pb) pb = list[0] || DEFAULT_PLAYBOOK;
  return { playbook: normalizePlaybook(pb) || DEFAULT_PLAYBOOK, catalog };
}

/**
 * 按工程配置拼写作用上下文（手册节选 + 参照稿 + 当前阶段），只读本机。
 */
function buildWritingContext(mdPath, folders, config) {
  const root = gwWs.resolveRoot(mdPath || "", folders || []);
  const write = (config && config.write) || {};
  const catCode = String(write.categoryCode || "").trim();
  const manCode = String(write.manualCode || "").trim();
  const refRel = String(write.referencePath || "")
    .trim()
    .replace(/\\/g, "/");
  const cmpRel = String(write.comparePath || "")
    .trim()
    .replace(/\\/g, "/");
  const tplRel = String(write.templatePath || "")
    .trim()
    .replace(/\\/g, "/");
  const catalog = listCatalog(root);
  const cat = (catalog.categories || []).find((c) => c.code === catCode);
  const parts = [];
  if (cat) {
    parts.push("【公文文种】" + cat.name + "（" + cat.code + "）");
  } else if (catCode) {
    parts.push("【公文文种】" + catCode);
  }
  // 官方手册由中转按 category 注入；本机带参照/对照。模板靠用户 @，不代选注入正文。
  if (refRel) {
    const abs = path.join(root, refRel.replace(/\//g, path.sep));
    let tip = "【参照稿】" + refRel + "（学口气与结构，禁止整篇照抄）";
    if (fs.existsSync(abs)) {
      const raw = fs.readFileSync(abs, "utf8");
      const head = raw.replace(/\r\n/g, "\n").trim().slice(0, 1600);
      tip += "\n" + head + (raw.length > 1600 ? "\n…(已截断)" : "");
    } else {
      tip += "\n（文件不存在，请在设置里重选）";
    }
    parts.push(tip);
  }
  if (cmpRel) {
    let curMd = "";
    try {
      if (mdPath && fs.existsSync(mdPath)) {
        curMd = fs.readFileSync(mdPath, "utf8");
      }
    } catch (_) {
      curMd = "";
    }
    const cmpAbs = localCorpus.resolveAbs(root, cmpRel);
    const cmp = localCorpus.compareDrafts(curMd, cmpAbs, cmpRel);
    parts.push(localCorpus.formatCompareInject(cmp));
  }
  return {
    ok: true,
    inject: parts.join("\n\n"),
    categoryCode: catCode,
    manualCode: manCode,
    referencePath: refRel,
    comparePath: cmpRel,
    templatePath: tplRel,
    catalog,
  };
}

module.exports = {
  syncFromCloud,
  syncInteractive,
  applyTemplateInteractive,
  readLocalIndex,
  listLocalTemplates,
  listCatalog,
  buildWritingContext,
  writePack,
  resolvePlaybook,
  OFFICIAL_REL,
};
