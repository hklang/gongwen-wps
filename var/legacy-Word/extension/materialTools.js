/**
 * 工程内材料工具（本机执行）。协议见 specs/2026-08-09-对话读材料与工具环.md
 * 工具：list_files / read_file / search_materials；禁止越界与写盘。
 */
const fs = require("fs");
const path = require("path");
const gwWs = require("./gongwenWorkspace");

const MAX_READ = 12000;
const MAX_SEARCH_HITS = 5;
const MAX_HIT_CHARS = 800;

function resolveSafe(root, rel) {
  const rootAbs = path.resolve(root);
  const relNorm = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!relNorm || relNorm.includes("..")) {
    throw new Error("非法路径");
  }
  const abs = path.resolve(rootAbs, relNorm.split("/").join(path.sep));
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
    throw new Error("路径越出工程根");
  }
  return { abs, rel: relNorm };
}

function catalogForAi(mdPath) {
  const listed = gwWs.listProjectFiles(mdPath);
  if (!listed.ok) {
    return { ok: false, error: listed.error || "无法列出", items: [] };
  }
  const items = []
    .concat(listed.docs || [])
    .concat(listed.materials || [])
    .concat(listed.references || [])
    .concat(listed.templates || [])
    .concat(listed.versions || [])
    .map((it) => {
      const p = String(it.path || "");
      let zone = "docs";
      if (p.startsWith("素材/")) zone = "materials";
      else if (p.startsWith("参照/")) zone = "references";
      else if (p.startsWith("模板/")) zone = "templates";
      else if (p.startsWith("版本/")) zone = "versions";
      return {
        path: it.path,
        title: it.title,
        bytes: it.bytes || 0,
        zone,
      };
    });
  return {
    ok: true,
    root: listed.root,
    name: listed.name,
    current: listed.current,
    items,
  };
}

function list_files(mdPath) {
  return catalogForAi(mdPath);
}

function read_file(mdPath, rel, maxChars) {
  const root = gwWs.resolveRoot(mdPath);
  const { abs, rel: safeRel } = resolveSafe(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: "文件不存在：" + safeRel, path: safeRel };
  }
  if (!safeRel.toLowerCase().endsWith(".md")) {
    return { ok: false, error: "仅允许读取 .md", path: safeRel };
  }
  const lim = Math.min(Math.max(Number(maxChars) || MAX_READ, 200), 40000);
  const text = fs.readFileSync(abs, "utf8");
  const truncated = text.length > lim;
  let title = path.basename(safeRel, ".md");
  try {
    const m = /^#\s+(.+)$/m.exec(text.slice(0, 4000));
    if (m) title = m[1].trim();
  } catch (_) { /* ignore */ }
  return {
    ok: true,
    path: safeRel,
    title,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated,
    text: truncated ? text.slice(0, lim) : text,
  };
}

function isMaterialRel(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .startsWith("素材/");
}

function search_materials(mdPath, query, opts) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "缺少检索词", hits: [] };
  const root = gwWs.resolveRoot(mdPath);
  const listed = gwWs.listProjectFiles(mdPath);
  const o = opts || {};
  // 默认只搜「素材/」；仅显式 includeDocs 才扩到文稿根（自动预读禁止乱扫）
  let pool = (listed.materials || []).slice();
  if (o.includeDocs) {
    pool = pool.concat(listed.docs || []);
  }
  const hits = [];
  const qLower = q.toLowerCase();
  const seen = new Set();
  for (const it of pool) {
    if (hits.length >= MAX_SEARCH_HITS) break;
    if (!it || !it.path || seen.has(it.path)) continue;
    seen.add(it.path);
    let abs;
    try {
      abs = resolveSafe(root, it.path).abs;
    } catch (_) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (_) {
      continue;
    }
    const idx = text.toLowerCase().indexOf(qLower);
    const nameHit =
      String(it.path || "").toLowerCase().includes(qLower) ||
      String(it.title || "").toLowerCase().includes(qLower);
    // 「通知」类：标题/路径含开会|通知|要求 也算命中
    const noticeHint =
      qLower === "通知" &&
      /通知|要求|开会|部署/.test(String(it.path || "") + String(it.title || ""));
    if (idx < 0 && !nameHit && !noticeHint) continue;
    let snippet;
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      snippet = text.slice(start, start + MAX_HIT_CHARS);
    } else {
      snippet = text.slice(0, Math.min(400, MAX_HIT_CHARS));
    }
    hits.push({
      path: it.path,
      title: it.title,
      snippet,
    });
  }
  return { ok: true, query: q, hits };
}

function executeTool(mdPath, name, args) {
  const n = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};
  try {
    if (n === "list_files") return { name: n, result: list_files(mdPath) };
    if (n === "read_file") {
      return {
        name: n,
        result: read_file(mdPath, a.path || a.rel || "", a.max_chars || a.maxChars),
      };
    }
    if (n === "search_materials") {
      return {
        name: n,
        result: search_materials(mdPath, a.query || a.q || ""),
      };
    }
    return { name: n, result: { ok: false, error: "未知工具：" + n } };
  } catch (e) {
    return {
      name: n,
      result: { ok: false, error: String(e && e.message ? e.message : e) },
    };
  }
}

/**
 * 从模型输出中解析 tool_calls 或 final。
 * 支持纯 JSON，或 ```json 围栏，或文中首个 { ... }。
 */
function parseAgentPayload(raw) {
  let s = String(raw || "").trim();
  if (!s) return { kind: "final", reply: "", edit: null, tool_calls: null };
  const fence = /^```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        obj = JSON.parse(s.slice(i, j + 1));
      } catch (__) {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== "object") {
    return { kind: "final", reply: String(raw || "").trim(), edit: null, tool_calls: null };
  }
  const type = String(obj.type || "").toLowerCase();
  const calls = obj.tool_calls || obj.toolCalls || obj.calls;
  if (
    type === "tool_calls" ||
    type === "tools" ||
    (Array.isArray(calls) && calls.length && !obj.reply && !obj.edit)
  ) {
    const list = Array.isArray(calls) ? calls : [];
    return {
      kind: "tools",
      tool_calls: list.map((c, idx) => ({
        id: String((c && c.id) || idx + 1),
        name: String((c && (c.name || c.tool)) || ""),
        arguments:
          c && typeof c.arguments === "object"
            ? c.arguments
            : c && typeof c.args === "object"
              ? c.args
              : {},
      })),
    };
  }
  // need_files 兼容 → 转成 read_file 调用
  if (Array.isArray(obj.need_files) && obj.need_files.length) {
    return {
      kind: "tools",
      tool_calls: obj.need_files.map((p, idx) => ({
        id: String(idx + 1),
        name: "read_file",
        arguments: { path: String(p) },
      })),
    };
  }
  let edit = obj.edit && typeof obj.edit === "object" ? obj.edit : null;
  if (edit && !edit.md) edit = null;
  return {
    kind: "final",
    reply: String(obj.reply != null ? obj.reply : raw).trim(),
    edit,
    tool_calls: null,
  };
}

/**
 * 高置信预读加速：仅目录名/标题命中时最多读 2 篇；主路径仍是模型 tool_calls。
 * 不把 search 结果塞进 tool_results，避免与原生 tools 双份占窗。
 */
function bootstrapMaterialReads(mdPath, message, docMd, alreadyRead) {
  const msg = String(message || "");
  const doc = String(docMd || "").trim();
  const bodyOnly = doc.replace(/^#.*$/m, "").trim();
  const sparse = !doc || doc.length < 80 || bodyOnly.length < 40;
  const want =
    (sparse && /通知|素材|框架|提纲|根据材料|读(取|一下)|参考/.test(msg)) ||
    /读(取|一下).*(通知|素材)|通知.*框架|按.*通知/.test(msg);
  if (!want) return { toolResults: [], steps: [], readPaths: [] };

  const have = new Set(Array.isArray(alreadyRead) ? alreadyRead : []);
  const paths = [];
  try {
    const cat = catalogForAi(mdPath);
    for (const it of cat.items || []) {
      if (!it.path || it.zone !== "materials" || !isMaterialRel(it.path)) continue;
      const key = String(it.path || "") + String(it.title || "");
      if (/通知|预通知|要求|提纲/.test(key) && paths.indexOf(it.path) < 0) {
        paths.push(it.path);
      }
    }
  } catch (_) { /* ignore */ }

  const steps = [];
  const toolResults = [];
  const readPaths = [];
  let nRead = 0;
  for (const p of paths) {
    if (nRead >= 2) break;
    if (have.has(p) || !isMaterialRel(p)) continue;
    steps.push({ name: "read_file", detail: p });
    const rd = executeTool(mdPath, "read_file", { path: p });
    toolResults.push({
      id: "boot-read-" + nRead,
      name: "read_file",
      arguments: { path: p },
      result: rd.result,
    });
    if (rd.result && rd.result.ok) {
      nRead += 1;
      readPaths.push(rd.result.path);
    }
  }
  return { toolResults, steps, readPaths };
}

function trimToolResults(list, maxChars) {
  const lim = Math.max(4000, Number(maxChars) || 24000);
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  let used = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    const chunk = JSON.stringify(item);
    if (used + chunk.length > lim && out.length) break;
    out.unshift(item);
    used += chunk.length;
  }
  return out;
}

function slimWorkspaceForChat(ws, toolResults) {
  const base = ws && typeof ws === "object" ? ws : {};
  const copy = {
    name: base.name || "",
    current: base.current || "",
    currentTitle: base.currentTitle || "",
    files: Array.isArray(base.files) ? base.files : [],
    materials: Array.isArray(base.materials) ? base.materials : [],
    catalog: Array.isArray(base.catalog) ? base.catalog : [],
  };
  const hasRead = (toolResults || []).some((t) => {
    if (!t || t.name !== "read_file" || !t.result || !t.result.ok) return false;
    const body = t.result.content || t.result.text || "";
    return String(body).length > 0;
  });
  if (hasRead) copy.materials = [];
  return copy;
}

function buildWorkingHistory(messages, opts) {
  const o = opts || {};
  const maxMsgs = o.maxMsgs || 12;
  const maxChars = o.maxChars || 10000;
  const summary = String(o.summary || "").trim();
  const list = Array.isArray(messages) ? messages : [];
  const recent = list.slice(-maxMsgs);
  let total = 0;
  const out = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = String(m.content || "");
    total += content.length;
    if (total > maxChars && out.length) break;
    out.unshift({ role: m.role, content: content.slice(0, 4000) });
  }
  return { summary, history: out, readSet: Array.isArray(o.readSet) ? o.readSet : [] };
}

/** 用户只要落框架/写到文件，不应再狂读素材 */
function wantsApplyFramework(message) {
  const m = String(message || "");
  return /只要框架|落框架|落上|写到(未命名|文件|当前)|写入到文件|写到文件里|把框架|先把框架|框架落|落到未命名|帮我落|落到文件|帮我写|这个可以|落位|第[一二三四五六七八九十\d]+组.*(可以|写入|落)|二级(标题|题目).*(写入|落)|直接在文件里改|在文件里改|写进(当前)?文件|写(一下|这一段|这段|本段|这部分)|改到(当前)?文件|整篇|初稿|整个文章|整篇文章|继续(写|下一段|下节)?|下一段|接着写/.test(
    m
  );
}

/** 从正文里找出【待补】/过短小标题，供预读素材 */
function pendingHeadsFromDoc(docMd) {
  const text = String(docMd || "");
  const re = /#{2,4}\s*([^\n]+)\n+([\s\S]*?)(?=\n#{2,4}\s+|$)/g;
  const heads = [];
  let m;
  while ((m = re.exec(text))) {
    const h = m[1].trim();
    if (/^[一二三四五六七八九十]+[、．]/.test(h)) continue;
    const body = String(m[2] || "").trim();
    if (!body || body === "【待补】" || body.length < 40) {
      if (heads.indexOf(h) < 0) heads.push(h);
    }
  }
  return heads;
}

/**
 * 按待补小标题关键词预读素材（继续下一段 / 整篇初稿）。
 */
function bootstrapPendingReads(mdPath, docMd, message, alreadyRead) {
  const msg = String(message || "");
  const doc = String(docMd || "");
  const want =
    /继续|下一段|接着写|整篇|初稿|写入到文件|落到文件|补全/.test(msg) ||
    /【待补】/.test(doc);
  if (!want) return { toolResults: [], steps: [], readPaths: [] };

  const heads = pendingHeadsFromDoc(doc).slice(0, 4);
  const keys = [];
  const add = (w) => {
    const t = String(w || "").trim();
    if (t.length < 2 || t.length > 16) return;
    if (keys.indexOf(t) < 0) keys.push(t);
  };
  // 只从待补标题与用户消息拆词，禁止业务专名词表
  const stop =
    /^(的|和|与|及|并|等|工作|情况|相关|进行|继续|下一段|接着|整篇|初稿|写入|文件|补全|帮我|落到)$/;
  heads.forEach((h) => {
    String(h)
      .replace(/[（）()]/g, "")
      .split(/[——\-：:、，,\s]/)
      .forEach((w) => {
        if (!stop.test(String(w || "").trim())) add(w);
      });
  });
  String(msg)
    .replace(/【@[^】]*】/g, "")
    .split(/[——\-：:、，,\s【】]+/)
    .forEach((w) => {
      if (!stop.test(String(w || "").trim())) add(w);
    });
  if (!keys.length) return { toolResults: [], steps: [], readPaths: [] };

  const have = new Set(Array.isArray(alreadyRead) ? alreadyRead : []);
  const paths = [];
  try {
    const cat = catalogForAi(mdPath);
    for (const it of cat.items || []) {
      if (!it.path || it.zone !== "materials" || !isMaterialRel(it.path)) continue;
      const blob = String(it.path || "") + String(it.title || "");
      if (keys.some((k) => blob.indexOf(k) >= 0) && paths.indexOf(it.path) < 0) {
        paths.push(it.path);
      }
    }
  } catch (_) { /* ignore */ }

  // 目录名没命中时，只在「素材/」内 search
  if (paths.length < 2) {
    for (let i = 0; i < keys.length && paths.length < 3; i++) {
      try {
        const hit = search_materials(mdPath, keys[i], { includeDocs: false });
        const list = (hit && hit.hits) || [];
        for (let j = 0; j < list.length && paths.length < 3; j++) {
          const p = list[j] && list[j].path;
          if (p && isMaterialRel(p) && !have.has(p) && paths.indexOf(p) < 0) {
            paths.push(p);
          }
        }
      } catch (_) { /* ignore */ }
    }
  }

  const steps = [];
  const toolResults = [];
  const readPaths = [];
  let nRead = 0;
  for (const p of paths) {
    if (nRead >= 3) break;
    if (have.has(p)) continue;
    steps.push({ name: "read_file", detail: p });
    const rd = executeTool(mdPath, "read_file", { path: p });
    toolResults.push({
      id: "pending-read-" + nRead,
      name: "read_file",
      arguments: { path: p },
      result: rd.result,
    });
    if (rd.result && rd.result.ok) {
      nRead += 1;
      readPaths.push(rd.result.path);
      have.add(rd.result.path);
    }
  }
  return { toolResults, steps, readPaths };
}

/** 历史里是否已有可落盘的一级标题 */
function historyHasOutline(history) {
  const list = Array.isArray(history) ? history : [];
  const heads = [];
  for (let i = list.length - 1; i >= 0 && heads.length < 8; i--) {
    const m = list[i];
    if (!m || m.role !== "assistant") continue;
    String(m.content || "")
      .split(/\n/)
      .forEach((line) => {
        const t = line.trim().replace(/^\*+|\*+$/g, "").trim();
        const h =
          t.match(/^#{1,3}\s+(.+)$/) ||
          t.match(/^([一二三四五六七八九十]+[、．.]\s*.+)$/) ||
          t.match(/^(\d+[\.、]\s*.+)$/);
        if (!h) return;
        const title = h[1].trim();
        if (title.length >= 4 && title.length <= 40 && heads.indexOf(title) < 0) {
          heads.push(title);
        }
      });
    if (heads.length >= 3) break;
  }
  return heads;
}

function maybeCompactSummary(messages, prevSummary, readSet) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length < 24) {
    return {
      summary: String(prevSummary || "").trim(),
      readSet: Array.isArray(readSet) ? readSet : [],
      compacted: false,
    };
  }
  const old = list.slice(0, -12);
  const constraints = [];
  const chapters = [];
  const notes = [];
  if (prevSummary) notes.push(String(prevSummary).slice(0, 600));
  for (const m of old.slice(-20)) {
    if (!m || !m.content) continue;
    const t = String(m.content);
    if (m.role === "user") {
      if (/不要|禁止|必须|按|约定|记住|别写/.test(t)) {
        constraints.push(t.replace(/\s+/g, " ").slice(0, 100));
      }
    } else {
      t.split(/\n/).forEach((line) => {
        const h = line.trim().match(/^(?:#{1,3}\s+|##\s+)?([一二三四五六七八九十]+[、．.].+)$/);
        const h2 = line.trim().match(/^##\s+(.+)$/);
        const title = (h2 && h2[1]) || (h && h[1]);
        if (title && chapters.indexOf(title.trim()) < 0 && chapters.length < 12) {
          chapters.push(title.trim());
        }
      });
    }
  }
  const bits = [];
  if (constraints.length) {
    bits.push("用户约束：" + constraints.slice(-6).join("；"));
  }
  if (chapters.length) {
    bits.push("已定章节：" + chapters.join("；"));
  }
  if (readSet && readSet.length) {
    bits.push("已读材料：" + readSet.slice(0, 12).join("、"));
  }
  if (!bits.length && notes.length) bits.push(notes[0]);
  else if (notes.length) bits.unshift(notes[0]);
  const summary = bits.join("\n").slice(0, 2000);
  return {
    summary,
    readSet: Array.isArray(readSet) ? readSet : [],
    compacted: true,
  };
}

/**
 * 精修未 @ 时：从选区/要求/当前稿标题拆词，检索并预读相关材料。
 * 不写业务专名词表。
 */
function suggestQueryKeys(selection, requirement, docMd) {
  const stop =
    /^(的|和|与|及|并|等|之|了|着|过|对|在|为|以|将|把|从|向|到|是|有|无|不|也|都|很|更|最|工作|情况|有关|相关|进行|方面|问题|内容|部分|要求|精修|润色|改写|重点|亮点|要实|抓出|一下|这里|这段|本段|公司|部门|单位|上半年|下半年|总结|汇报|坚持|通过|加大|同步|全力|完成|确保|推进|强化|创新)$/;
  const keys = [];
  const add = (w) => {
    let t = String(w || "").trim();
    t = t.replace(/^[（(][一二三四五六七八九十\d]+[）)]/, "");
    if (t.length < 2 || t.length > 16) return;
    if (stop.test(t)) return;
    if (keys.indexOf(t) < 0) keys.push(t);
  };
  const feedChunk = (chunk) => {
    add(chunk);
    // 无标点长中文：滑窗 2～4 字，便于「去库存」「促回款」对上素材
    const pure = String(chunk || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    if (pure.length >= 4 && pure.length <= 48) {
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= pure.length && keys.length < 48; i++) {
          add(pure.slice(i, i + n));
        }
      }
    }
  };
  const feed = (text) => {
    String(text || "")
      .replace(/【@[^】]*】/g, "")
      .replace(/[#>*_`]+/g, " ")
      .split(/[——\-：:，,、；;。！？\s「」【】（）()“”"'·]+/)
      .forEach(feedChunk);
  };
  feed(selection);
  feed(requirement);
  // 当前稿标题：对上「××公司…总结」类素材文件名
  String(docMd || "")
    .split(/\n/)
    .forEach((line) => {
      const t = line.trim();
      if (/^#+\s+/.test(t) || /^[一二三四五六七八九十]+[、．]/.test(t)) {
        feed(t.replace(/^#+\s+/, ""));
      }
    });
  return keys.slice(0, 36);
}

/**
 * 对话预读：与精修同一套检索，返回 tool_results 形状，便于工具环直接吞。
 */
function bootstrapAutoDiscover(mdPath, message, docMd, alreadyRead) {
  const found = discoverMaterialsForSuggest(mdPath, {
    selection: "",
    requirement: message,
    docMd,
  });
  const have = new Set(
    (Array.isArray(alreadyRead) ? alreadyRead : []).map((p) =>
      String(p || "").replace(/\\/g, "/")
    )
  );
  const steps = [];
  const toolResults = [];
  const readPaths = [];
  const list = (found && found.materials) || [];
  for (let i = 0; i < list.length && readPaths.length < 2; i++) {
    const m = list[i];
    const rel = String((m && m.path) || "").replace(/\\/g, "/");
    if (!rel || have.has(rel)) continue;
    steps.push({ name: "read_file", detail: rel });
    toolResults.push({
      id: "auto-read-" + readPaths.length,
      name: "read_file",
      arguments: { path: rel },
      result: {
        ok: true,
        path: rel,
        text: String((m && m.text) || ""),
      },
    });
    readPaths.push(rel);
    have.add(rel);
  }
  return {
    toolResults,
    steps,
    readPaths,
    keys: (found && found.keys) || [],
  };
}

/** 素材夹内可用文件（跳过说明/read 等空壳） */
function listUsableMaterialItems(mdPath) {
  try {
    const cat = catalogForAi(mdPath);
    return (cat.items || []).filter((it) => {
      if (!it || !it.path || it.zone !== "materials" || !isMaterialRel(it.path)) {
        return false;
      }
      const base = path.basename(String(it.path).replace(/\\/g, "/"));
      if (/^(说明|read)\.md$/i.test(base)) return false;
      return true;
    });
  } catch (_) {
    return [];
  }
}

/**
 * 历史 read_set 只有路径、没有正文时，按路径重新读入（防误判「未读到素材」）。
 */
function rehydrateMaterialReads(mdPath, readSet, toolResults) {
  const covered = new Set();
  const list = Array.isArray(toolResults) ? toolResults : [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || t.name !== "read_file" || !t.result || !t.result.ok) continue;
    const text = String(t.result.text || t.result.content || "").trim();
    if (text.length < 40) continue;
    covered.add(String(t.result.path || "").replace(/\\/g, "/"));
  }
  const steps = [];
  const out = [];
  const paths = Array.isArray(readSet) ? readSet : [];
  for (let i = 0; i < paths.length && out.length < 4; i++) {
    const rel = String(paths[i] || "").replace(/\\/g, "/");
    if (!isMaterialRel(rel) || covered.has(rel)) continue;
    const rd = executeTool(mdPath, "read_file", {
      path: rel,
      max_chars: 9000,
    });
    if (!(rd.result && rd.result.ok)) continue;
    const text = String(rd.result.text || rd.result.content || "").trim();
    if (text.length < 40) continue;
    out.push({
      id: "rehydrate-" + out.length,
      name: "read_file",
      arguments: { path: rel },
      result: rd.result,
    });
    steps.push({ name: "read_file", detail: rel });
    covered.add(rel);
  }
  return { toolResults: out, steps, readPaths: out.map((t) => t.result.path) };
}

function discoverMaterialsForSuggest(mdPath, opts) {
  const o = opts || {};
  const keys = suggestQueryKeys(o.selection, o.requirement, o.docMd);
  const empty = { keys, paths: [], materials: [] };

  const curRel = (() => {
    try {
      const cat = catalogForAi(mdPath);
      return String((cat && cat.current) || "").replace(/\\/g, "/");
    } catch (_) {
      return "";
    }
  })();

  const scoreMap = new Map(); // path -> score
  const bump = (p, n) => {
    const rel = String(p || "").replace(/\\/g, "/");
    if (!rel || rel === curRel) return;
    scoreMap.set(rel, (scoreMap.get(rel) || 0) + (n || 1));
  };

  const matItems = listUsableMaterialItems(mdPath);

  if (keys.length) {
    for (let i = 0; i < matItems.length; i++) {
      const it = matItems[i];
      const blob = String(it.path || "") + " " + String(it.title || "");
      let s = 0;
      for (let k = 0; k < keys.length; k++) {
        if (blob.indexOf(keys[k]) >= 0) s += keys[k].length >= 3 ? 3 : 2;
      }
      if (s > 0) bump(it.path, s);
    }
    for (let i = 0; i < Math.min(keys.length, 8); i++) {
      try {
        const hit = search_materials(mdPath, keys[i], { includeDocs: false });
        const list = (hit && hit.hits) || [];
        for (let j = 0; j < list.length && j < 4; j++) {
          const p = list[j] && list[j].path;
          if (!isMaterialRel(p)) continue;
          bump(p, 4 - j + (keys[i].length >= 3 ? 1 : 0));
        }
      } catch (_) { /* ignore */ }
    }
  }

  // 关键词对不上文件名时：仍从「素材/」按体积取 2 份，避免空读后胡编/误拦
  if (!scoreMap.size && matItems.length) {
    matItems
      .slice()
      .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
      .slice(0, 2)
      .forEach((it, idx) => bump(it.path, 2 - idx));
  }

  if (!scoreMap.size) return empty;

  const ranked = Array.from(scoreMap.entries())
    .filter((x) => isMaterialRel(x[0]))
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
  const paths = ranked.slice(0, 3);
  const materials = [];
  for (let i = 0; i < paths.length && materials.length < 2; i++) {
    if (!isMaterialRel(paths[i])) continue;
    const rd = executeTool(mdPath, "read_file", {
      path: paths[i],
      max_chars: 9000,
    });
    if (!(rd.result && rd.result.ok)) continue;
    materials.push({
      path: rd.result.path || paths[i],
      text: String(rd.result.text || rd.result.content || ""),
    });
  }
  return { keys, paths, materials };
}

module.exports = {
  catalogForAi,
  list_files,
  read_file,
  search_materials,
  executeTool,
  parseAgentPayload,
  bootstrapMaterialReads,
  bootstrapPendingReads,
  pendingHeadsFromDoc,
  discoverMaterialsForSuggest,
  bootstrapAutoDiscover,
  rehydrateMaterialReads,
  listUsableMaterialItems,
  suggestQueryKeys,
  trimToolResults,
  slimWorkspaceForChat,
  buildWorkingHistory,
  maybeCompactSummary,
  wantsApplyFramework,
  historyHasOutline,
  resolveSafe,
  MAX_READ,
};
