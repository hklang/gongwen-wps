/**
 * 授权改稿本地兜底：模型只回「结论」时，仍生成可 Keep 的 edit。
 */

/** 去掉模型误写的「首行缩进」实体；缩进由编辑器 CSS 负责 */
function sanitizeGongwenMd(md) {
  let s = String(md || "");
  s = s.replace(/&emsp;|&ensp;|&#8194;|&#8195;|&#x2002;|&#x2003;/gi, "");
  // 行首伪缩进：全角/em/en 空格（保留普通半角空格以免破坏代码块缩进意图——公文几乎无代码块）
  s = s.replace(/^((?:#{1,6}[ \t]+)?)[\u2002\u2003\u3000]+/gm, "$1");
  return s;
}

function sanitizeChatEdit(edit) {
  if (!edit || typeof edit !== "object" || !edit.md) return edit;
  const md = sanitizeGongwenMd(edit.md);
  if (md === edit.md) return edit;
  return Object.assign({}, edit, { md });
}

function docIsSparse(docMd) {
  let body = String(docMd || "")
    .replace(/^#\s+[^\n]*\n?/m, "")
    .replace(/\s+/g, "");
  return !body || body === "标题" || body === "未命名" || body.length < 12;
}

function wantsScaffold(msg) {
  return /框架|提纲|搭|起草|起个|结构|大纲|列个|架子|目录|章节/.test(
    String(msg || "")
  );
}

function wantsRename(msg) {
  return /改名|文件名|标题改为|题目改为|改成/.test(String(msg || ""));
}

function cleanTitle(raw) {
  let title = String(raw || "").trim();
  title = title
    .replace(/^(这个文件|该文件|文件|文档|文稿)\s*/, "")
    .replace(/(然后)?\s*重新打开.*$/, "")
    .replace(/[，,]\s*并.*$/, "")
    .replace(/\s*并重新打开.*$/, "")
    .replace(/(这个文件|文件名|\.md)\s*$/i, "")
    .replace(/^[「『"“]+|[」』"”]+$/g, "")
    .trim();
  return title;
}

function collectMaterialHeads(workspace, toolResults) {
  const heads = [];
  const pushLine = (line) => {
    const m = String(line || "")
      .trim()
      .match(/^#{2,3}\s+(.+)$/);
    if (!m) return;
    const h = m[1].trim();
    if (h && heads.indexOf(h) < 0) heads.push(h);
  };
  const mats = (workspace && workspace.materials) || [];
  for (let i = 0; i < mats.length && heads.length < 8; i++) {
    String((mats[i] && mats[i].snippet) || "")
      .split(/\n/)
      .forEach(pushLine);
  }
  const trs = Array.isArray(toolResults) ? toolResults : [];
  for (let i = 0; i < trs.length && heads.length < 8; i++) {
    const t = trs[i];
    if (!t || t.name !== "read_file" || !t.result || !t.result.ok) continue;
    String(t.result.content || t.result.text || "")
      .split(/\n/)
      .forEach(pushLine);
  }
  return heads;
}

function inferScaffoldEdit(msg, docMd, workspace, toolResults, history) {
  const applyOnly =
    /只要框架|落框架|落上|写到(未命名|文件|当前)|把框架|先把框架|框架落|落到未命名/.test(
      String(msg || "")
    );
  if (!wantsScaffold(msg) && !applyOnly) return null;
  if (!docIsSparse(docMd) && !applyOnly) return null;
  let title = "";
  const hm = String(docMd || "").match(/^#\s+(.+)$/m);
  if (hm && hm[1] && hm[1].trim() !== "标题" && hm[1].trim() !== "未命名") {
    title = hm[1].trim();
  } else if (workspace && workspace.currentTitle) {
    title = String(workspace.currentTitle).trim();
  }
  // 历史里常有「大标题：xxx」
  if (!title || title === "标题" || title === "未命名") {
    const hist = Array.isArray(history) ? history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const c = String((hist[i] && hist[i].content) || "");
      const tm =
        c.match(/大标题[应该用是为]?[：:]\s*[「"]?([^」"\n]+)[」"]?/) ||
        c.match(/建议大标题[：:]\s*[「"]?([^」"\n]+)[」"]?/);
      if (tm) {
        title = String(tm[1] || "")
          .replace(/\*+/g, "")
          .trim();
        if (title) break;
      }
    }
  }
  if (!title || title === "标题" || title === "未命名") title = "未命名";

  let heads = collectMaterialHeads(workspace, toolResults);
  if (heads.length < 2 && Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0 && heads.length < 8; i--) {
      const m = history[i];
      if (!m || m.role !== "assistant") continue;
      String(m.content || "")
        .split(/\n/)
        .forEach((line) => {
          const t = line.trim().replace(/^\*+|\*+$/g, "").trim();
          const h =
            t.match(/^#{1,3}\s+(.+)$/) ||
            t.match(/^([一二三四五六七八九十]+[、．.]\s*.+)$/);
          if (!h) return;
          const name = h[1].trim();
          if (name.length >= 4 && name.length <= 48 && heads.indexOf(name) < 0) {
            heads.push(name);
          }
        });
      if (heads.length >= 3) break;
    }
  }
  if (!heads.length) return null;

  const lines = ["# " + title, ""];
  heads.slice(0, 8).forEach((h) => {
    const label = /^[一二三四五六七八九十\d]/.test(h) ? h : h;
    lines.push("## " + label, "", "【待补】", "");
  });
  let md = lines.join("\n");
  if (!/\n$/.test(md)) md += "\n";
  return {
    summary: "已按商定框架写入一级标题（正文待补）",
    md,
  };
}

function inferTitleEdit(msg, docMd) {
  const text = String(msg || "").trim();
  if (!wantsRename(text)) return null;
  const patterns = [
    /(?:把)?(?:当前)?文件名改为\s*[「『"“](.+?)[」』"”]/,
    /(?:把)?(?:当前)?文件名改为\s*([^\n，。；;]+)/,
    /(?:把)?(?:当前)?文件改名为\s*[「『"“](.+?)[」』"”]/,
    /(?:把)?(?:当前)?文件改名为\s*([^\n，。；;]+)/,
    /改名[为成]\s*[「『"“](.+?)[」』"”]/,
    /改名[为成]\s*([^\n，。；;]+)/,
    /(?:标题|题目)改为\s*[「『"“](.+?)[」』"”]/,
    /(?:标题|题目)改为\s*([^\n，。；;]+)/,
  ];
  let title = "";
  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (!m) continue;
    title = cleanTitle(m[1]);
    if (title) break;
  }
  if (!title || title.length > 80) return null;
  let md = String(docMd || "");
  if (/^#\s+/m.test(md)) md = md.replace(/^#\s+[^\n]*/m, "# " + title);
  else md = "# " + title + "\n\n" + md.replace(/^\n+/, "");
  if (!/\n$/.test(md)) md += "\n";
  return {
    summary:
      "标题/文件名改为「" +
      title +
      "」" +
      (text.indexOf("重新打开") >= 0 ? "，Keep 后将重命名并打开" : ""),
    md,
    rename: title + ".md",
  };
}

const CN_NUM = "零一二三四五六七八九十";

/** 从文本抽出「一是…」行 */
function extractApplyHeads(msg) {
  const heads = [];
  String(msg || "")
    .split(/\n/)
    .forEach((line) => {
      let t = line
        .trim()
        .replace(/^【+\s*/, "")
        .replace(/】+.*$/, "")
        .replace(/^[-*•]\s*/, "")
        .replace(/^\*+|\*+$/g, "")
        .trim();
      if (!t || t.length < 4 || t.length > 80) return;
      if (
        /^[一二三四五六七八九十]+是/.test(t) ||
        /^[（(][一二三四五六七八九十\d]+[）)]/.test(t) ||
        /^#{2,3}\s+/.test(t)
      ) {
        t = t.replace(/^#{2,3}\s+/, "");
        if (heads.indexOf(t) < 0) heads.push(t);
      }
    });
  return heads;
}

function wantsApplyToFile(msg) {
  return /落到|写入|帮我落|帮我写|落位|写到(文件|未命名|当前)|写进(当前)?(稿|文件)|写入到文件|写到文件里|落到文件里|这个可以|用这个|第[一二三四五六七八九十\d]+组.*(可以|写入|落)|按(照)?第[一二三四五六七八九十\d]+组|二级(标题|题目).*(写入|落)|直接在文件里改|在文件里改|写(一下|这一段|这段|本段|这部分|该段|这一节)|改到(当前)?文件|充实|补写|整篇|全文|初稿|整个文章|整篇文章|继续(写|下一段|下节|补充|补写)?|下一段|接着写|再写(一段|下一段)/.test(
    String(msg || "")
  );
}

function wantsFillSection(msg) {
  return (
    wantsApplyToFile(msg) ||
    /写(一下|这一段|这段|本段|这部分|该段)|帮我写|充实|补写|填(写|充)|起草(一下|这段|这部分)?/.test(
      String(msg || "")
    )
  );
}

/** 整篇初稿 / 按范例补全文 */
function wantsFullDraft(msg) {
  return /整篇|全文|初稿|整个文章|整篇文章|按(照)?格式写入|写入到文件|写到文件里|落到文件里|补全写入|帮我落到|把.*写好.*文件/.test(
    String(msg || "")
  );
}

/** 续写下一个【待补】 */
function wantsContinueSection(msg) {
  return /继续(写|下一段|下节|补充|补写)?|下一段|接着写|再写(一段|下一段)|补下一段|下一段/.test(
    String(msg || "")
  );
}

/** 需要据实写作（无素材读入时禁止交编造正文） */
function wantsFactualWrite(msg) {
  return (
    wantsFullDraft(msg) ||
    wantsContinueSection(msg) ||
    wantsFillSection(msg) ||
    /要实|亮点|重点|根据素材|结合材料|参照材料|充实|补写|写进|写入|落到/.test(
      String(msg || "")
    )
  );
}

/** 消息里 @xxx.md 路径 */
function citedMdPaths(msg) {
  const out = [];
  const re = /@([^\s@，,。；;】\]]+?\.md)/g;
  let m;
  const s = String(msg || "");
  while ((m = re.exec(s))) {
    const rel = String(m[1] || "").replace(/\\/g, "/");
    if (rel && out.indexOf(rel) < 0) out.push(rel);
  }
  return out;
}

/** 明确要求写入某个 @ 文件（落稿目标，不是「据素材扩写」） */
function wantsWriteToCitedFile(msg) {
  const s = String(msg || "");
  if (!citedMdPaths(s).length) return false;
  return /写入|写到|写进|落入|落到|落到文件|替换|覆盖/.test(s);
}

/** 是否已有可用的已读正文（含 @ 指定或「素材/」预读） */
function hasUsableMaterialReads(toolResults, msg) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const cited = new Set(citedMdPaths(msg));
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || t.name !== "read_file" || !t.result || !t.result.ok) continue;
    const text = String(t.result.text || t.result.content || "").trim();
    const rel = String(t.result.path || (t.arguments && t.arguments.path) || "").replace(
      /\\/g,
      "/"
    );
    // @ 指定文件：已成功读取即可（答复稿可能很短，勿用 40 字门槛误杀）
    if (rel && cited.has(rel)) return true;
    if (rel && cited.size && [...cited].some((c) => rel.endsWith(c) || c.endsWith(rel))) {
      return true;
    }
    // 40 字足够区分空壳/错误页；勿设太高，短简报也会被误判为「未读到」
    if (text.length >= 40) return true;
  }
  return false;
}

/** 用户说「第一组」→ 1 */
function parseGroupIndex(msg) {
  const m = String(msg || "").match(/第([一二三四五六七八九十\d]+)组/);
  if (!m) return 0;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Math.max(1, Math.min(10, Number(raw)));
  const i = CN_NUM.indexOf(raw);
  return i > 0 ? i : 0;
}

/** 从历史助手消息里抠出第 N 组的「一是…」列表 */
function extractGroupHeadsFromHistory(history, groupIndex) {
  if (!groupIndex || !Array.isArray(history)) return [];
  const cn = CN_NUM.charAt(groupIndex) || String(groupIndex);
  const startRe = new RegExp(
    "(?:\\*\\*)?第" + cn + "组[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*)?第[一二三四五六七八九十\\d]+组|\\n---|\n\\*\\*我的建议|$)"
  );
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== "assistant") continue;
    const hit = String(m.content || "").match(startRe);
    if (!hit) continue;
    const heads = extractApplyHeads(hit[1]);
    if (heads.length >= 2) return heads;
  }
  return [];
}

/** 落在第几节（一、/二、/三、）——只认序号，不绑业务词 */
function detectTargetSection(msg, history) {
  const t = String(msg || "");
  if (/二[、．]|第二节|第二[点章节段]/.test(t)) return 2;
  if (/三[、．]|第三节|第三[点章节段]/.test(t)) return 3;
  if (/一[、．]|第一节|第一[点章节段]/.test(t)) return 1;
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0 && i >= list.length - 10; i--) {
    const c = String((list[i] && list[i].content) || "");
    if (/[「“『"]一[、．]|一[、．].*二级|研究.*一[、．]/.test(c)) return 1;
    if (/[「“『"]二[、．]|二[、．].*二级|研究.*二[、．]/.test(c)) return 2;
    if (/[「“『"]三[、．]|三[、．].*二级|研究.*三[、．]/.test(c)) return 3;
  }
  return 1;
}

function genericSectionTitle(sectionN) {
  const cn = CN_NUM.charAt(sectionN) || String(sectionN);
  return "## " + cn + "、";
}

function resolveApplyHeads(msg, history) {
  let heads = extractApplyHeads(msg);
  if (heads.length >= 2) return heads;
  const gi = parseGroupIndex(msg);
  if (gi) {
    heads = extractGroupHeadsFromHistory(history, gi);
    if (heads.length >= 2) return heads;
  }
  // 「这个可以 / 用这个」：取最近助手消息里最后一组「一是」块
  if (/这个可以|用这个|按(照)?这/.test(String(msg || ""))) {
    const list = Array.isArray(history) ? history : [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i] || list[i].role !== "assistant") continue;
      const h = extractApplyHeads(list[i].content);
      if (h.length >= 2) return h;
    }
  }
  return heads;
}

function applyHeadsToSection(md, heads, sectionN) {
  const cn = CN_NUM.charAt(sectionN) || String(sectionN);
  const block =
    heads.map((h) => "### " + h + "\n\n【待补】\n").join("\n") + "\n";
  const secRe = new RegExp(
    "(##\\s*" + cn + "[、．.][^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s*[一二三四五六七八九十]|$)"
  );
  if (secRe.test(md)) {
    return md.replace(secRe, (_, head) => head + "\n" + block);
  }
  return md.replace(
    /\s*$/,
    "\n\n" + genericSectionTitle(sectionN) + "\n\n" + block
  );
}

/**
 * 把用户选定的二级标题落到当前稿（默认第一节「一、」）。
 */
function inferApplySectionEdit(msg, docMd, history) {
  if (!wantsApplyToFile(msg)) return null;
  const heads = resolveApplyHeads(msg, history);
  if (heads.length < 2) return null;
  const sectionN = detectTargetSection(msg, history);

  let md = String(docMd || "").trim();
  if (
    !md ||
    md === "# 未命名" ||
    (/^#\s*未命名\s*$/m.test(md) && md.length < 40)
  ) {
    const blockAt = (n) =>
      n === sectionN
        ? heads.map((h) => "### " + h + "\n\n【待补】\n").join("\n")
        : "【待补】\n";
    md =
      "# 未命名\n\n" +
      genericSectionTitle(1) +
      "\n\n" +
      blockAt(1) +
      "\n" +
      genericSectionTitle(2) +
      "\n\n" +
      blockAt(2) +
      "\n" +
      genericSectionTitle(3) +
      "\n\n" +
      blockAt(3);
  } else {
    md = applyHeadsToSection(md, heads, sectionN);
  }
  if (!/\n$/.test(md)) md += "\n";
  return {
    summary:
      "已将第" +
      (CN_NUM.charAt(sectionN) || sectionN) +
      "节二级标题按「" +
      heads[0].slice(0, 14) +
      "…」写入（待 Keep）",
    md,
  };
}

/** 从「【（一）xxx】写这一段」类指令解析目标小标题 */
function parseTargetHeading(msg) {
  const t = String(msg || "");
  const bracket = t.match(
    /【\s*([（(]?[一二三四五六七八九十\d]+[）)]?[^\n【】]{2,60})\s*】/
  );
  if (bracket) return bracket[1].replace(/^#+\s*/, "").trim();
  const bare = t.match(
    /([（(][一二三四五六七八九十\d]+[）)][^\n。；]{2,40})/
  );
  return bare ? bare[1].trim() : "";
}

function collectToolPlain(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const chunks = [];
  for (let i = 0; i < list.length && chunks.join("").length < 6000; i++) {
    const r = list[i] && list[i].result;
    if (!r || !r.ok) continue;
    const text = String(r.text || r.content || "").trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 通用虚词，避免从标题拆出噪声；不含任何业务专名 */
const KEYWORD_STOP = /^(的|和|与|及|并|等|之|了|着|过|对|在|为|以|将|把|从|向|到|是|有|无|不|也|都|很|更|最|工作|情况|有关|相关|进行|方面|问题|内容|部分|本章|本节|公司|部门|单位)$/;

/** 只从标题/指令拆词，禁止业务词表硬编码 */
function keywordsFromHead(msg, head) {
  const keys = [];
  const add = (w) => {
    let t = String(w || "").trim();
    t = t.replace(/^[（(][一二三四五六七八九十\d]+[）)]/, "");
    if (t.length < 2 || t.length > 16) return;
    if (KEYWORD_STOP.test(t)) return;
    if (keys.indexOf(t) < 0) keys.push(t);
  };
  const sources = [head];
  const bracket = String(msg || "").match(/【\s*([^】]{2,60})\s*】/);
  if (bracket) sources.push(bracket[1]);
  sources.forEach((src) => {
    String(src || "")
      .replace(/^[（(][一二三四五六七八九十\d]+[）)]\s*/, "")
      .replace(/^#+\s*/, "")
      .split(/[——\-：:，,、；;\s「」【】（）()]+/)
      .forEach(add);
  });
  return keys;
}

/** 素材切段：兼顾 Markdown 空行与「一、二、」文体 */
function collectToolParas(toolResults) {
  const tools = collectToolPlain(toolResults);
  if (!tools.trim()) return [];
  const raw = tools
    .split(/(?=[一二三四五六七八九十]+、)|\n{2,}|\n/)
    .map((s) => s.trim().replace(/^#+\s*/, ""))
    .filter(
      (s) =>
        s.length >= 24 &&
        s.length <= 900 &&
        !/^(目录|附件|备注|索引|责任编辑)\b/.test(s) &&
        !/^[-*|=\s]+$/.test(s)
    );
  const out = [];
  raw.forEach((s) => {
    if (s.length <= 420) {
      out.push(s);
      return;
    }
    // 长段按句切，避免整篇灌进一个小标题
    const parts = s.split(/(?<=。)/);
    let buf = "";
    parts.forEach((p) => {
      if ((buf + p).length > 380 && buf.length >= 60) {
        out.push(buf);
        buf = p;
      } else buf += p;
    });
    if (buf.trim().length >= 24) out.push(buf.trim());
  });
  return out;
}

/** 从已读素材抽与标题相关的正文；used 避免各段抄同一段 */
function extractFillBody(msg, head, toolResults, used) {
  const paras = collectToolParas(toolResults);
  if (!paras.length) return "";
  const usedSet = used || new Set();
  const keys = keywordsFromHead(msg, head);
  const scored = paras
    .map((p) => {
      const mark = p.slice(0, 48);
      if (usedSet.has(mark)) return { p, s: -1 };
      let s = 0;
      for (let i = 0; i < keys.length; i++) {
        if (p.indexOf(keys[i]) >= 0) s += keys[i].length >= 3 ? 2 : 1;
      }
      return { p, s };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
  let picked = scored.filter((x) => x.s > 0).slice(0, 2).map((x) => x.p);
  if (!picked.length) {
    picked = scored.slice(0, 1).map((x) => x.p);
  }
  if (!picked.length) return "";
  picked.forEach((p) => usedSet.add(p.slice(0, 48)));
  let out = picked.join("");
  if (out.length > 650) {
    out = out.slice(0, 650);
    const cut = out.lastIndexOf("。");
    if (cut >= 120) out = out.slice(0, cut + 1);
  }
  return out;
}

/** 定位目标小标题块：优先标题关键词，其次同序号（二） */
function findSectionBlock(md, head) {
  const text = String(md || "");
  const bare = String(head || "")
    .replace(/^[（(][一二三四五六七八九十\d]+[）)]\s*/, "")
    .trim();
  const key = bare.slice(0, 10);
  if (key.length >= 4) {
    const headRe = new RegExp(
      "(#{2,4}\\s*[^\\n]*" +
        escapeRegExp(key) +
        "[^\\n]*\\n)([\\s\\S]*?)(?=\\n#{2,4}\\s+|$)"
    );
    const m = headRe.exec(text);
    if (m) {
      return { index: m.index, len: m[0].length, level: (m[1].match(/^#{2,4}/) || ["###"])[0] };
    }
  }
  const numM = String(head || "").match(/^[（(]([一二三四五六七八九十\d]+)[）)]/);
  if (!numM) return null;
  const n = numM[1];
  const re = new RegExp(
    "(#{2,4}\\s*[（(]" +
      escapeRegExp(n) +
      "[）)][^\\n]*\\n)([\\s\\S]*?)(?=\\n#{2,4}\\s+|$)",
    "g"
  );
  let best = null;
  let bestScore = -1;
  let m;
  while ((m = re.exec(text))) {
    const titleLine = m[1];
    let score = 0;
    bare.split(/[，,、]/).forEach((w) => {
      if (w.length >= 2 && titleLine.indexOf(w) >= 0) score += 2;
    });
    keywordsFromHead("", head).forEach((k) => {
      if (titleLine.indexOf(k) >= 0) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = {
        index: m.index,
        len: m[0].length,
        level: (m[1].match(/^#{2,4}/) || ["###"])[0],
      };
    }
  }
  return best;
}

function upsertSectionBody(md, head, para) {
  let text = String(md || "");
  const hit = findSectionBlock(text, head);
  const block = (hit ? hit.level : "###") + " " + head + "\n\n" + para + "\n";
  if (hit) {
    return text.slice(0, hit.index) + block + text.slice(hit.index + hit.len);
  }
  const sec1 = /(##\s*一[、．][^\n]*\n)/.exec(text);
  if (sec1) {
    const pos = sec1.index + sec1[0].length;
    return text.slice(0, pos) + "\n" + block + text.slice(pos);
  }
  return text.replace(/\s*$/, "\n\n" + block);
}

/** 按用户要点 + 已读素材，填充目标小标题下正文 */
function inferFillSectionEdit(msg, docMd, toolResults) {
  if (!wantsFillSection(msg)) return null;
  const samples = extractSampleSections(msg);
  if (samples.length === 1 && !wantsFullDraft(msg)) {
    // 单段范例 +「写这部分」：优先用用户已写好的正文
    let md = String(docMd || "");
    if (!md.trim()) return null;
    md = upsertSectionBody(md, samples[0].head, samples[0].body);
    if (!/\n$/.test(md)) md += "\n";
    return {
      summary: "已写入「" + samples[0].head.slice(0, 18) + "」（待 Keep）",
      md: sanitizeGongwenMd(md),
    };
  }
  const head = parseTargetHeading(msg);
  if (!head || head.length < 4) return null;
  let md = String(docMd || "");
  if (!md.trim()) return null;
  const para = extractFillBody(msg, head, toolResults);
  if (!para) return null;
  md = upsertSectionBody(md, head, para);
  if (!/\n$/.test(md)) md += "\n";
  return {
    summary: "已起草「" + head.slice(0, 18) + "」正文（待 Keep）",
    md: sanitizeGongwenMd(md),
  };
}

/** 从用户消息里抠已写好的 ### 范例段 */
function extractSampleSections(msg) {
  const s = String(msg || "");
  const out = [];
  const push = (head, body) => {
    const h = String(head || "")
      .replace(/^#+\s*/, "")
      .trim();
    let b = String(body || "")
      .replace(/】+\s*$/g, "")
      .replace(/\n*(这部分已经|非常好|你也知道|帮我把|帮我写)[\s\S]*$/g, "")
      .trim();
    if (!h || h.length < 4 || b.length < 20) return;
    if (out.some((x) => x.head === h)) return;
    out.push({ head: h, body: b });
  };
  // 【### 标题\n\n正文】或裸 ### 块
  const re =
    /#{2,4}\s*([^\n]+)\n+([\s\S]*?)(?=\n#{2,4}\s+|】|这部分已经|非常好|帮我把|帮我写|$)/g;
  let m;
  while ((m = re.exec(s))) {
    push(m[1], m[2]);
  }
  return out;
}

function listHeadingBodies(md) {
  const text = String(md || "");
  const re = /#{2,4}\s*([^\n]+)\n/g;
  const hits = [];
  let m;
  while ((m = re.exec(text))) {
    hits.push({ head: m[1].trim(), index: m.index, headEnd: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out.push({
      head: hits[i].head,
      body: text.slice(hits[i].headEnd, end).trim(),
    });
  }
  return out;
}

function sectionBodyWeak(body) {
  const b = String(body || "").trim();
  return !b || /^【待补】/.test(b) || b.length < 40;
}

function isPrimarySectionHead(head) {
  return /^[一二三四五六七八九十]+[、．]/.test(String(head || "").trim());
}

function listSubheads(md) {
  return listHeadingBodies(md).filter((x) => !isPrimarySectionHead(x.head));
}

function draftCoverage(md) {
  const subs = listSubheads(md);
  let weak = 0;
  for (let i = 0; i < subs.length; i++) {
    if (sectionBodyWeak(subs[i].body)) weak += 1;
  }
  return { total: subs.length, weak, strong: subs.length - weak };
}

/** 模型只写了一两段却声称整篇完成 */
function isIncompleteFullDraft(editMd, docMd, msg) {
  if (!wantsFullDraft(msg)) return false;
  const editCov = draftCoverage(editMd);
  const docCov = draftCoverage(docMd);
  if (editCov.strong <= 1) return true;
  if (editCov.total >= 3 && editCov.strong < Math.ceil(editCov.total * 0.5)) return true;
  if (docCov.total >= 3 && editCov.total > 0 && editCov.total < docCov.total - 1) return true;
  if (docCov.total >= 3 && editCov.strong < Math.min(3, docCov.total)) return true;
  return false;
}

/** 以当前稿大纲为底，叠模型已写好的段 + 用户范例 */
function mergeDraftBase(docMd, editMd, samples) {
  let md = String(docMd || "").trim();
  const edit = String(editMd || "").trim();
  if (!md) md = edit || "# 未命名\n\n## 一、\n\n";
  if (edit) {
    listSubheads(edit).forEach((sec) => {
      if (!sectionBodyWeak(sec.body)) {
        md = upsertSectionBody(md, sec.head, sec.body);
      }
    });
  }
  (samples || []).forEach((s) => {
    md = upsertSectionBody(md, s.head, s.body);
  });
  return md;
}

/**
 * 整篇初稿：写入用户范例段 + 对弱段落按素材补全（不覆盖已写好的长段）。
 */
function inferFullDraftEdit(msg, docMd, toolResults, history, editMd) {
  if (!wantsFullDraft(msg)) return null;
  const samples = extractSampleSections(msg);
  let md = mergeDraftBase(docMd, editMd || "", samples);
  if (!md.trim()) md = "# 未命名\n\n## 一、\n\n";
  const before = md;
  const sampleHeads = {};
  samples.forEach((s) => {
    sampleHeads[s.head] = true;
  });
  const used = new Set();
  // 范例正文占用，避免其它段再抄同一段
  samples.forEach((s) => {
    if (s.body) used.add(String(s.body).slice(0, 48));
  });

  let sections = listHeadingBodies(md);
  for (let i = 0; i < sections.length; i++) {
    const h = sections[i].head;
    if (sampleHeads[h]) continue;
    if (isPrimarySectionHead(h)) continue;
    if (!sectionBodyWeak(sections[i].body)) continue;
    const para = extractFillBody(msg, h, toolResults, used);
    if (para) md = upsertSectionBody(md, h, para);
  }

  // 小标题过少：从素材「一、二、」或历史补标题再填
  if (listSubheads(md).length <= 1) {
    const extras = [];
    collectToolParas(toolResults).forEach((p) => {
      const hm = p.match(/^([一二三四五六七八九十]+、[^\n。]{4,40})/);
      if (hm) {
        const title = hm[1].replace(/^([一二三四五六七八九十]+)、/, (_, n) => {
          const map = { 一: "（一）", 二: "（二）", 三: "（三）", 四: "（四）", 五: "（五）" };
          return map[n] || "（" + n + "）";
        });
        if (extras.indexOf(title) < 0) extras.push(title);
      }
    });
    if (extras.length < 2 && Array.isArray(history)) {
      for (let i = history.length - 1; i >= 0 && extras.length < 6; i--) {
        String((history[i] && history[i].content) || "")
          .split(/\n/)
          .forEach((line) => {
            const t = line.trim().replace(/^#+\s*/, "");
            if (/^[（(][一二三四五六七八九十\d]+[）)]/.test(t) && t.length < 48) {
              if (extras.indexOf(t) < 0) extras.push(t);
            }
          });
      }
    }
    extras.slice(0, 6).forEach((h) => {
      if (sampleHeads[h] || findSectionBlock(md, h)) return;
      const para = extractFillBody(msg, h, toolResults, used) || "【待补】";
      md = upsertSectionBody(md, h, para);
    });
  }

  // 再扫一遍弱段（新建标题后）
  sections = listHeadingBodies(md);
  for (let i = 0; i < sections.length; i++) {
    const h = sections[i].head;
    if (sampleHeads[h] || isPrimarySectionHead(h)) continue;
    if (!sectionBodyWeak(sections[i].body)) continue;
    const para = extractFillBody(msg, h, toolResults, used);
    if (para) md = upsertSectionBody(md, h, para);
  }

  md = sanitizeGongwenMd(md);
  if (!/\n$/.test(md)) md += "\n";
  if (md === sanitizeGongwenMd(before) && !samples.length && draftCoverage(md).strong <= 1) {
    return null;
  }
  const cov = draftCoverage(md);
  return {
    summary:
      "已按范例与素材补全初稿（已写 " +
      cov.strong +
      "/" +
      cov.total +
      " 段，待 Keep）",
    md,
  };
}

function findNextPendingSection(docMd) {
  const subs = listSubheads(docMd);
  for (let i = 0; i < subs.length; i++) {
    if (sectionBodyWeak(subs[i].body)) return subs[i];
  }
  return null;
}

/** 「继续下一段」：填当前稿里第一个【待补】/弱段 */
function inferNextPendingEdit(msg, docMd, toolResults) {
  if (!wantsContinueSection(msg)) return null;
  const pending = findNextPendingSection(docMd);
  if (!pending) return null;
  const para = extractFillBody(msg, pending.head, toolResults, new Set());
  if (!para) {
    // 无素材：不生成可 Keep 的假正文，直接失败由上层提示
    return null;
  }
  const md = upsertSectionBody(String(docMd || ""), pending.head, para);
  if (!/\n$/.test(md)) return {
    summary: "已续写「" + pending.head.slice(0, 18) + "」（待 Keep）",
    md: sanitizeGongwenMd(md + "\n"),
  };
  return {
    summary: "已续写「" + pending.head.slice(0, 18) + "」（待 Keep）",
    md: sanitizeGongwenMd(md),
  };
}

function inferChatEdit(msg, docMd, workspace, toolResults, history) {
  return (
    inferNextPendingEdit(msg, docMd, toolResults) ||
    inferFullDraftEdit(msg, docMd, toolResults, history) ||
    inferFillSectionEdit(msg, docMd, toolResults) ||
    inferApplySectionEdit(msg, docMd, history) ||
    inferScaffoldEdit(msg, docMd, workspace, toolResults, history) ||
    inferTitleEdit(msg, docMd)
  );
}

function looksLikeRefusal(reply) {
  const t = String(reply || "");
  return (
    /结论|无法直接改名|无法改写|原文内容为空|未提供任何正文|无实质内容/.test(t) ||
    (/^\*\*结论\*\*/.test(t.trim()) || t.indexOf("**结论**") >= 0)
  );
}

/** @ 落入某文件时补 rename，便于 Keep 写到目标而不是口头声称 */
function ensureEditTargetFile(msg, edit, currentRel) {
  if (!edit || !edit.md || !wantsWriteToCitedFile(msg)) return edit;
  const targets = citedMdPaths(msg);
  if (!targets.length) return edit;
  const t = targets[0];
  const cur = String(currentRel || "")
    .replace(/\\/g, "/")
    .replace(/^.*\//, "");
  const base = t.replace(/^.*\//, "");
  if (cur && (cur === t || cur === base)) return edit;
  if (!edit.rename) {
    return Object.assign({}, edit, { rename: base || t });
  }
  return edit;
}

/**
 * 据实写作但未读到素材：丢掉会编造的 edit，只保留「范例段 + 【待补】」。
 */
function blockEditWithoutMaterials(body, out) {
  const msg = (body && body.message) || "";
  if (!body || !body.allow_edit || !wantsFactualWrite(msg)) return out;
  // 用户 @ 文件并要求落入/写入：目标文件即依据，勿按「无素材」取消
  if (wantsWriteToCitedFile(msg)) return out;
  if (hasUsableMaterialReads(body.tool_results, msg)) return out;
  // 搭框架 / 改标题不在 wantsFactualWrite 的纯路径里时仍可能误伤；仅挡「写正文」
  const samples = extractSampleSections(msg);
  const safe = inferFullDraftEdit(
    msg,
    body.doc_md || "",
    [], // 故意不传素材，禁止抽假句
    body.history || null,
    null
  );
  if (safe && safe.md && samples.length) {
    out.edit = sanitizeChatEdit(
      Object.assign({}, safe, {
        summary: "仅保留范例段（未读到素材，其余【待补】）",
      })
    );
    out.reply =
      "未从工程「素材」夹读到可用正文，不能据实扩写（已取消编造）。" +
      "仅保留你贴的范例段，其余仍为【待补】。请确认材料在当前工程「素材」夹内后重试，或 @ 指定文件。";
    out._localInfer = true;
    out._blockedNoMaterial = true;
    return out;
  }
  out.edit = null;
  out.reply =
    (String(out.reply || "").replace(/\n*\（已提出改稿[\s\S]*$/, "").trim() ||
      "未读到素材") +
    "\n\n（未从「素材」夹读到可用文件，已取消改稿预览，防止胡编。请将材料 md 放入工程「素材」文件夹后重试；也可 @ 文件。）";
  out._blockedNoMaterial = true;
  return out;
}

/**
 * 中转结果补丁：无 edit、拒稿、或整篇只写了一段时，用本地兜底/补全。
 */
function patchChatResult(body, resultJson) {
  const out =
    resultJson && typeof resultJson === "object" ? Object.assign({}, resultJson) : {};
  if (!body || !body.allow_edit) {
    // 铁律：未授权绝不能带回 edit
    out.edit = null;
    return out;
  }
  const msg = body.message || "";
  const hasEdit = !!(out.edit && out.edit.md);
  const reply = String(out.reply || "");
  if (
    !body.force_final &&
    (out.type === "tool_calls" || Array.isArray(out.tool_calls))
  ) {
    return out;
  }

  const hasMats =
    hasUsableMaterialReads(body.tool_results, msg) || wantsWriteToCitedFile(msg);

  const needFull =
    wantsFullDraft(msg) &&
    (!hasEdit ||
      looksLikeRefusal(reply) ||
      isIncompleteFullDraft(out.edit.md, body.doc_md || "", msg));

  if (needFull && hasMats) {
    const local = inferFullDraftEdit(
      msg,
      body.doc_md || "",
      body.tool_results || null,
      body.history || null,
      hasEdit ? out.edit.md : ""
    );
    if (local && local.md) {
      const beforeStrong = hasEdit ? draftCoverage(out.edit.md).strong : 0;
      if (draftCoverage(local.md).strong >= Math.max(2, beforeStrong)) {
        out.edit = sanitizeChatEdit(local);
        out.reply = local.summary + "\n\n（本地已补全整篇初稿预览）";
        out._localInfer = true;
        return blockEditWithoutMaterials(body, out);
      }
    }
  }

  if (
    hasMats &&
    wantsContinueSection(msg) &&
    (!hasEdit || looksLikeRefusal(reply))
  ) {
    const local = inferNextPendingEdit(
      msg,
      body.doc_md || "",
      body.tool_results || null
    );
    if (local && local.md) {
      out.edit = sanitizeChatEdit(local);
      out.reply = local.summary + "\n\n（本地已续写下一段预览）";
      out._localInfer = true;
      return blockEditWithoutMaterials(body, out);
    }
  }

  if (hasEdit && !looksLikeRefusal(reply)) {
    out.edit = sanitizeChatEdit(
      ensureEditTargetFile(msg, out.edit, body.current_rel || "")
    );
    return blockEditWithoutMaterials(body, out);
  }

  if (!hasMats && wantsFactualWrite(msg)) {
    return blockEditWithoutMaterials(body, out);
  }

  const edit = inferChatEdit(
    msg,
    body.doc_md || "",
    body.workspace || null,
    body.tool_results || null,
    body.history || null
  );
  if (!edit) {
    if (out.edit) out.edit = sanitizeChatEdit(out.edit);
    return blockEditWithoutMaterials(body, out);
  }
  out.edit = sanitizeChatEdit(edit);
  out.reply =
    edit.summary +
    (hasEdit || looksLikeRefusal(reply) ? "\n\n（本地已生成改稿预览）" : "");
  out._localInfer = true;
  return blockEditWithoutMaterials(body, out);
}

module.exports = {
  inferChatEdit,
  patchChatResult,
  inferApplySectionEdit,
  inferFillSectionEdit,
  inferFullDraftEdit,
  inferNextPendingEdit,
  findNextPendingSection,
  extractSampleSections,
  isIncompleteFullDraft,
  draftCoverage,
  extractApplyHeads,
  extractGroupHeadsFromHistory,
  resolveApplyHeads,
  citedMdPaths,
  wantsWriteToCitedFile,
  ensureEditTargetFile,
  sanitizeGongwenMd,
  sanitizeChatEdit,
  wantsApplyToFile,
  wantsFillSection,
  wantsFullDraft,
  wantsContinueSection,
  wantsFactualWrite,
  hasUsableMaterialReads,
  blockEditWithoutMaterials,
  wantsRename,
  wantsScaffold,
};
