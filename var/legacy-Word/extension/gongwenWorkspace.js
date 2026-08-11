/**
 * 本机工作区元数据（.gongwen/）。仅在扩展宿主读写用户磁盘；
 * 云中转不得调用本模块。
 */
const fs = require("fs");
const path = require("path");

const GONGWEN_DIR = ".gongwen";
const WORKSPACE_JSON = "workspace.json";
const CONFIG_JSON = "config.json";
const MATERIAL_DIR = "素材";
const VERSION_DIR = "版本";
const REF_DIR = "参照";
const TEMPLATE_DIR = "模板";
const SKIP_DIRS = new Set([
  "var",
  "快照",
  VERSION_DIR,
  REF_DIR,
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "dist",
  ".cursor",
  "Word", // 编辑器源码，不计入公文素材
]);

const DEFAULT_ENGINES = {
  punctuation: true,
  format: true,
  dictionary: true,
  typo: true,
  grammar: true,
  sensitive: true,
  style: false,
  logic: false,
  dataverify: false,
};

/** 场景默认引擎集（ID 与 proofread.ENGINE_META 同步） */
const DEFAULT_SCENE_ENGINE_MAP = {
  政务公文: [
    "punctuation", "format", "dictionary", "typo", "grammar", "sensitive",
    "style", "logic", "dataverify",
  ],
  新闻资讯: ["dictionary", "dataverify", "typo", "punctuation", "sensitive"],
  个人写作: ["dictionary", "dataverify", "typo", "punctuation"],
};

const DEFAULT_CONFIG = {
  version: 2,
  note: "公文工作区配置",
  general: {
    autoSave: true,
    autoVersion: false,
  },
  write: {
    defaultEditAuth: false,
    /** 官方分类 code；手册 code；本机参照/对照/当前模板相对路径 */
    categoryCode: "",
    manualCode: "",
    referencePath: "",
    comparePath: "",
    templatePath: "",
  },
  suite: {
    count: 3,
    optView: "diff",
    requireSelection: true,
  },
  proofread: {
    engines: Object.assign({}, DEFAULT_ENGINES),
    sensitivity: "strict",
    defaultScope: "full",
    scene: "政务公文",
    sceneEngineMap: JSON.parse(JSON.stringify(DEFAULT_SCENE_ENGINE_MAP)),
    whitelist: [],
    mustfix: [],
    factGroups: [
      { id: "default", name: "默认", enabled: true, items: [] },
    ],
    facts: [],
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(over).forEach((k) => {
    const v = over[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  });
  return out;
}

function loadConfig(root) {
  ensureDir(root);
  const data = readJson(configJsonPath(root));
  return deepMerge(DEFAULT_CONFIG, data && typeof data === "object" ? data : {});
}

function saveConfig(root, patch) {
  ensureDir(root);
  const cur = loadConfig(root);
  const next = deepMerge(cur, patch && typeof patch === "object" ? patch : {});
  next.version = Math.max(2, Number(next.version) || 2);
  next.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "");
  writeJson(configJsonPath(root), next);
  return { ok: true, config: next };
}

function loadConfigForMd(mdPath) {
  const root = resolveRoot(mdPath);
  return { ok: true, root, config: loadConfig(root) };
}

function saveConfigForMd(mdPath, patch) {
  const root = resolveRoot(mdPath);
  return saveConfig(root, patch);
}

const MATERIAL_README =
  "# 素材文件夹\n\n" +
  "请把写稿要用的参考材料（旧稿、提纲、会议纪要、数据说明等）放到这里。\n" +
  "侧栏只显示 `.md`。放入 `.docx` / `.txt` / `.pdf` 后，点「转换」生成同名 md；源文件保留。\n" +
  "对话授权改稿时会优先读取本目录的 md。\n";

const MATERIAL_CONVERT_EXTS = new Set([".docx", ".txt", ".pdf"]);

const VERSION_README =
  "# 版本文件夹\n\n" +
  "「存版本」会把当前文稿副本放在这里，不影响正在编辑的正文。\n" +
  "也可自行备份重要稿件到本目录。\n";

const TEMPLATE_README =
  "# 模板文件夹\n\n" +
  "云端骨架经你同意后下载到这里（本机副本，可改）。\n" +
  "需要参考时，在侧栏右键「引用」挂上文件标记；不会自动写入对话正文。\n" +
  "不会覆盖正在编辑的正文；官方写作规范仍由云端按文种注入。\n";

function gongwenDir(root) {
  return path.join(path.resolve(root), GONGWEN_DIR);
}

function workspaceJsonPath(root) {
  return path.join(gongwenDir(root), WORKSPACE_JSON);
}

function configJsonPath(root) {
  return path.join(gongwenDir(root), CONFIG_JSON);
}

function isGongwenMarker(p) {
  try {
    return fs.existsSync(p) && (fs.statSync(p).isDirectory() || fs.statSync(p).isFile());
  } catch (_) {
    return false;
  }
}

/**
 * 工作目录 = 当前 md 所在目录（打开/创建哪个文件，根就定在哪）。
 * 若文件在「素材/版本/work/快照」内，上抬到其父目录作为工程根。
 * 不再向上搜索父级 .gongwen，也不回落到 VS Code 工作区根（避免 src2 扯进上层工程）。
 */
function resolveRoot(mdPath) {
  const abs = path.resolve(mdPath || "");
  let dir = path.dirname(abs);
  if (!dir || dir === ".") return process.cwd();
  const lift = new Set([
    MATERIAL_DIR,
    VERSION_DIR,
    REF_DIR,
    TEMPLATE_DIR,
    "work",
    "Work",
    "快照",
  ]);
  for (let i = 0; i < 3; i++) {
    const base = path.basename(dir);
    if (!lift.has(base) && base.toLowerCase() !== "work") break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function relTo(root, fp) {
  try {
    return path.relative(root, fp).split(path.sep).join("/");
  } catch (_) {
    return path.basename(fp);
  }
}

function titleOf(mdPath) {
  try {
    const head = fs.readFileSync(mdPath, "utf8").slice(0, 4000);
    const m = /^#\s+(.+)$/m.exec(head);
    if (m) return m[1].trim();
  } catch (_) { /* ignore */ }
  return path.basename(mdPath, path.extname(mdPath));
}

function scanMdFiles(root, limit) {
  const max = limit || 40;
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      const name = ent.name;
      if (name.startsWith(".")) continue;
      const fp = path.join(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(fp);
        continue;
      }
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (name === "说明.md") continue;
      let st;
      try {
        st = fs.statSync(fp);
      } catch (_) {
        continue;
      }
      out.push({
        path: relTo(root, fp),
        title: titleOf(fp),
        bytes: st.size,
      });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path, "zh"));
}

function readJson(fp) {
  if (!fs.existsSync(fp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch (_) {
    return null;
  }
}

function writeJson(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, fp);
  return fp;
}

function ensureFolderWithReadme(root, name, readme) {
  const d = path.join(path.resolve(root), name);
  fs.mkdirSync(d, { recursive: true });
  const tip = path.join(d, "说明.md");
  if (!fs.existsSync(tip)) {
    fs.writeFileSync(tip, readme.endsWith("\n") ? readme : readme + "\n", "utf8");
  }
  return d;
}

function ensureUserFolders(root) {
  return {
    materials: ensureFolderWithReadme(root, MATERIAL_DIR, MATERIAL_README),
    versions: ensureFolderWithReadme(root, VERSION_DIR, VERSION_README),
    templates: ensureFolderWithReadme(root, TEMPLATE_DIR, TEMPLATE_README),
  };
}

function ensureDir(root) {
  const marker = path.join(path.resolve(root), GONGWEN_DIR);
  let legacyData = null;
  if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
    legacyData = readJson(marker) || {};
    try {
      fs.unlinkSync(marker);
    } catch (_) {
      try {
        fs.renameSync(marker, marker + ".legacy.json");
      } catch (__) { /* ignore */ }
    }
  }
  fs.mkdirSync(marker, { recursive: true });
  const cfg = configJsonPath(root);
  if (!fs.existsSync(cfg)) writeJson(cfg, Object.assign({}, DEFAULT_CONFIG));
  const wsFp = workspaceJsonPath(root);
  if (legacyData && !fs.existsSync(wsFp)) writeJson(wsFp, legacyData);
  ensureUserFolders(root);
  return marker;
}

function load(root) {
  ensureDir(root);
  const data = readJson(workspaceJsonPath(root));
  if (data) return data;
  return readJson(path.join(path.resolve(root), GONGWEN_DIR + ".legacy.json"));
}

function save(root, data) {
  ensureDir(root);
  const payload = Object.assign({}, data || {}, {
    version: 1,
    updatedAt: new Date().toISOString().replace(/\.\d+Z$/, ""),
  });
  return writeJson(workspaceJsonPath(root), payload);
}

function listProjectMdIndex(root, curRel) {
  /** 仅文稿根一层 + 素材/模板/版本（及遗留参照夹，若仍存在） */
  return []
    .concat(listMdInSubdir(root, "", curRel))
    .concat(listMdInSubdir(root, MATERIAL_DIR, curRel))
    .concat(listMdInSubdir(root, REF_DIR, curRel))
    .concat(listMdInSubdir(root, TEMPLATE_DIR, curRel))
    .concat(listMdInSubdir(root, VERSION_DIR, curRel));
}

function touchForMd(mdPath, workspaceFolders, workspaceName) {
  const abs = path.resolve(mdPath);
  const root = resolveRoot(abs);
  ensureDir(root);
  const prev = load(root) || {};
  const curRel = relTo(root, abs);
  const files = listProjectMdIndex(root, curRel);
  const name = String(
    workspaceName || prev.name || path.basename(root) || "公文工作区"
  ).trim();
  const data = {
    version: 1,
    name,
    root,
    current: curRel,
    currentTitle: fs.existsSync(abs) ? titleOf(abs) : "",
    files,
    // 与素材夹实时对齐（勿沿用空的旧数组）
    materials: listMdInSubdir(root, MATERIAL_DIR, curRel),
  };
  const folders = ensureUserFolders(root);
  save(root, data);
  data.gongwenPath = gongwenDir(root);
  data.workspaceFile = workspaceJsonPath(root);
  data.materialDir = folders.materials;
  data.versionDir = folders.versions;
  return data;
}

function summaryForAi(mdPath, workspaceFolders) {
  if (!mdPath || !fs.existsSync(mdPath)) return {};
  const data = touchForMd(mdPath, workspaceFolders);
  return {
    name: data.name || "",
    root: data.root || "",
    current: data.current || "",
    currentTitle: data.currentTitle || "",
    files: (data.files || []).slice(0, 12),
    gongwenPath: data.gongwenPath || "",
  };
}

function listMdInSubdir(root, sub, curRel, limit) {
  const max = limit || 40;
  const d = path.join(path.resolve(root), sub);
  const out = [];
  if (!fs.existsSync(d)) return out;
  let names;
  try {
    names = fs.readdirSync(d).sort();
  } catch (_) {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md") || name.startsWith(".") || name === "说明.md") {
      continue;
    }
    const fp = path.join(d, name);
    let st;
    try {
      st = fs.statSync(fp);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    const rel = relTo(root, fp);
    out.push({
      path: rel,
      title: titleOf(fp),
      bytes: st.size,
      current: rel === curRel,
    });
    if (out.length >= max) break;
  }
  return out;
}

function safeTemplateFileName(categoryCode, title) {
  const code =
    String(categoryCode || "tpl")
      .replace(/[^\w\-]+/g, "")
      .slice(0, 32) || "tpl";
  const base =
    String(title || "骨架")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "骨架";
  return code + "-" + base + ".md";
}

/**
 * 云端骨架落到本机「模板/」（只落盘，不改文种/当前模板/对话）。
 */
function landUserTemplate(mdPath, opts) {
  const o = opts || {};
  if (!mdPath) return { ok: false, error: "请先打开文档" };
  const root = resolveRoot(mdPath);
  const folders = ensureUserFolders(root);
  const body = String(o.body_md || o.bodyMd || "").trim();
  if (!body) return { ok: false, error: "模板正文为空" };
  const code = String(o.category || o.categoryCode || "tpl").trim();
  const title = String(o.title || "骨架").trim();
  const force = !!o.force;
  const name = safeTemplateFileName(code, title);
  const abs = path.join(folders.templates, name);
  const rel = (TEMPLATE_DIR + "/" + name).replace(/\\/g, "/");
  if (fs.existsSync(abs) && !force) {
    return { ok: false, need_confirm: true, path: rel, error: "已存在同名模板" };
  }
  fs.writeFileSync(abs, body.endsWith("\n") ? body : body + "\n", "utf8");
  return { ok: true, path: rel, absolute: abs, title, category: code };
}

function deleteProjectMd(mdPath, relPath) {
  if (!mdPath) return { ok: false, error: "请先打开文档" };
  const root = resolveRoot(mdPath);
  const rel = String(relPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!rel || rel.includes("..") || !rel.toLowerCase().endsWith(".md")) {
    return { ok: false, error: "非法路径" };
  }
  if (path.basename(rel) === "说明.md") {
    return { ok: false, error: "说明文件请保留" };
  }
  const top = rel.split("/")[0];
  const allowed = new Set([MATERIAL_DIR, REF_DIR, TEMPLATE_DIR, VERSION_DIR]);
  const isRootDoc = rel.indexOf("/") < 0;
  if (!isRootDoc && !allowed.has(top)) {
    return { ok: false, error: "仅可删除文稿根或素材/参照/模板/版本内文件" };
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...rel.split("/"));
  const rootKey = process.platform === "win32" ? rootAbs.toLowerCase() : rootAbs;
  const absKey = process.platform === "win32" ? abs.toLowerCase() : abs;
  if (absKey !== rootKey && !absKey.startsWith(rootKey + path.sep)) {
    return { ok: false, error: "路径越出工程根" };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: "文件不存在：" + rel };
  }
  const curAbs = path.resolve(mdPath);
  const deletedCurrent =
    process.platform === "win32"
      ? path.normalize(abs).toLowerCase() === path.normalize(curAbs).toLowerCase()
      : path.normalize(abs) === path.normalize(curAbs);
  fs.unlinkSync(abs);
  return { ok: true, path: rel, deletedCurrent };
}

function listProjectFiles(mdPath, workspaceFolders) {
  if (!mdPath) {
    return {
      ok: false,
      error: "请先打开文档",
      docs: [],
      materials: [],
      references: [],
      templates: [],
      versions: [],
    };
  }
  const abs = path.resolve(mdPath);
  // 壳内软切换后文件可能已删：仍按路径定根并列出，避免三区全空
  const missingCurrent = !fs.existsSync(abs);
  const root = resolveRoot(abs);
  ensureUserFolders(root);
  const curRel = relTo(root, abs);
  const cfg = loadConfig(root);
  const activeTpl = String((cfg.write && cfg.write.templatePath) || "").replace(
    /\\/g,
    "/"
  );
  const activeRef = String((cfg.write && cfg.write.referencePath) || "").replace(
    /\\/g,
    "/"
  );
  const markTpl = (list) =>
    (list || []).map((it) =>
      Object.assign({}, it, {
        activeTemplate: !!(activeTpl && it.path === activeTpl),
      })
    );
  // 文稿=工程根一层；不扫 src2/work 等子目录；各分区列表仅 md
  // 不再创建/展示「参照」夹；旧目录若仍在磁盘也不进侧栏
  return {
    ok: true,
    name: (load(root) || {}).name || path.basename(root),
    root,
    current: curRel,
    activeTemplate: activeTpl,
    activeReference: activeRef,
    missingCurrent,
    warning: missingCurrent
      ? "当前文件已不在磁盘，已按工程根刷新列表"
      : undefined,
    docs: listMdInSubdir(root, "", curRel),
    materials: listMdInSubdir(root, MATERIAL_DIR, curRel),
    references: [],
    templates: markTpl(listMdInSubdir(root, TEMPLATE_DIR, curRel)),
    versions: listMdInSubdir(root, VERSION_DIR, curRel),
  };
}

/** 素材夹一层待转源文件：docx / txt / pdf（不含 ~$ 临时文件） */
function listMaterialSources(mdPath) {
  if (!mdPath) {
    return { ok: false, error: "请先打开文档", items: [], root: "" };
  }
  // 定根只依赖路径，不要求当前 md 仍存在（刷新/转换后可继续扫素材夹）
  const root = resolveRoot(mdPath);
  const matDir = ensureUserFolders(root).materials;
  let names = [];
  try {
    names = fs.readdirSync(matDir);
  } catch (_) {
    return { ok: true, items: [], root, materialsDir: matDir };
  }
  const items = [];
  for (const name of names) {
    if (!name || name.startsWith("~$")) continue;
    const ext = path.extname(name).toLowerCase();
    if (!MATERIAL_CONVERT_EXTS.has(ext)) continue;
    const src = path.join(matDir, name);
    try {
      if (!fs.statSync(src).isFile()) continue;
    } catch (_) {
      continue;
    }
    const base = path.basename(name, path.extname(name));
    const md = path.join(matDir, base + ".md");
    items.push({
      name,
      ext,
      src,
      md,
      hasMd: fs.existsSync(md),
      relSrc: relTo(root, src),
      relMd: relTo(root, md),
    });
  }
  return { ok: true, items, root, materialsDir: matDir };
}

/** @deprecated 使用 listMaterialSources */
function listMaterialDocx(mdPath, workspaceFolders) {
  return listMaterialSources(mdPath, workspaceFolders);
}

function materialSnippets(mdPath, workspaceFolders, limit, each) {
  const max = limit || 3;
  const n = each || 800;
  if (!mdPath) return [];
  const root = resolveRoot(mdPath);
  ensureUserFolders(root);
  const rootAbs = path.resolve(root);
  const curRel = relTo(root, path.resolve(mdPath));
  // 只读本工程「素材/」，绝不扫 src2/终稿/work
  const items = listMdInSubdir(root, MATERIAL_DIR, curRel, 40)
    .filter(
      (it) =>
        it.path !== curRel &&
        (it.bytes || 0) >= 80 &&
        path.basename(it.path) !== "说明.md"
    )
    .sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  const out = [];
  for (const item of items) {
    const fp = path.resolve(root, item.path);
    if (!fp.startsWith(rootAbs)) continue;
    try {
      const text = fs.readFileSync(fp, "utf8").slice(0, n);
      out.push({ path: item.path, title: item.title || item.path, snippet: text });
    } catch (_) {
      continue;
    }
    if (out.length >= max) break;
  }
  return out;
}

module.exports = {
  GONGWEN_DIR,
  MATERIAL_DIR,
  VERSION_DIR,
  REF_DIR,
  TEMPLATE_DIR,
  touchForMd,
  summaryForAi,
  materialSnippets,
  listProjectFiles,
  landUserTemplate,
  deleteProjectMd,
  safeTemplateFileName,
  listMaterialSources,
  listMaterialDocx,
  MATERIAL_CONVERT_EXTS,
  resolveRoot,
  ensureDir,
  ensureUserFolders,
  loadConfig,
  saveConfig,
  loadConfigForMd,
  saveConfigForMd,
  DEFAULT_CONFIG,
};
