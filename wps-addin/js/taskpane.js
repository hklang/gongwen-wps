(function () {
  var CHIP_SLICE = 28;
  var LIVE_MS = 200;
  var state = {
    tab: "write",
    chat: [],
    options: [],
    proof: [],
    live: null,
    work: null,
    selPopOpen: false,
    busy: false,
    liveTimer: null,
    previewId: null,
    adoptedId: null,
    optView: "diff",
    suiteBaseline: ""
  };

  function $(id) {
    return document.getElementById(id);
  }

  function tip(msg) {
    var el = $("aiTip");
    if (el) {
      el.hidden = !msg;
      el.textContent = msg || "";
    }
  }

  function citeShortName(p) {
    var s = String(p || "").replace(/\\/g, "/");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function renderCiteBar() {
    var bar = $("aiCiteBar");
    if (!bar || !window.GwProject) return;
    var list = GwProject.getCitePaths();
    if (!list.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = list
      .map(function (p) {
        var name = citeShortName(p);
        return (
          '<span class="ai-cite-chip" title="' +
          String(p).replace(/"/g, "&quot;") +
          '"><span class="ai-cite-at">@</span><span>' +
          name.replace(/</g, "&lt;") +
          '</span><button type="button" class="ai-cite-x" data-cite-x="' +
          String(p).replace(/"/g, "&quot;") +
          '" title="移除引用" aria-label="移除">×</button></span>'
        );
      })
      .join("");
  }

  function citedMaterials() {
    if (!window.GwProject) return [];
    return GwProject.loadCitedMaterials(8000).filter(function (m) {
      return m && m.ok && m.text;
    });
  }

  function contextWithCites(base) {
    var mats = citedMaterials();
    if (!mats.length) return base || "";
    var parts = [String(base || "").trim()];
    parts.push("## 引用素材");
    mats.forEach(function (m) {
      parts.push("### " + (m.path || m.title || ""));
      parts.push(m.text);
    });
    return parts.filter(Boolean).join("\n\n");
  }

  function capability() {
    var el = $("aiCapability");
    return el && el.value === "strong" ? "strong" : "fast";
  }

  function wantDraftChecked() {
    var el = $("aiWantDraft");
    return !!(el && el.checked);
  }

  function wantVariantsChecked() {
    var el = $("aiWantVariants");
    return !!(el && el.checked);
  }

  /** 勾选「出结论」时自动勾上「给多份」；取消出结论时一并取消给多份 */
  function syncWantDraftPair() {
    var d = $("aiWantDraft");
    var v = $("aiWantVariants");
    if (!d || !v) return;
    if (d.checked) v.checked = true;
    else v.checked = false;
  }

  function selectedWriteLevels() {
    var box = $("aiWriteLevels");
    if (!box) return [];
    var out = [];
    Array.prototype.forEach.call(
      box.querySelectorAll("[data-write-level].on"),
      function (btn) {
        var lv = btn.getAttribute("data-write-level");
        if (lv) out.push(lv);
      }
    );
    return out;
  }

  function writeLevelConstraint(levels) {
    var parts = [];
    var hasH1 = levels.indexOf("h1") >= 0;
    var hasH2 = levels.indexOf("h2") >= 0;
    var hasH3 = levels.indexOf("h3") >= 0;
    var hasBody = levels.indexOf("body") >= 0;
    parts.push("用户已点选产出层级：" + levels.join(",") + "。");
    parts.push("只输出点选的层级，未点选的层级禁止出现。");
    if (hasH1) parts.push("一级：Markdown ## ，公文「一、二、三…」，措辞优先对仗。");
    if (hasH2)
      parts.push(
        "二级：Markdown ### ，公文「（一）（二）…」。" +
          "必须从钉住范围与用户要点中拆出具体子主题（如「包含/分管/要点」后的并列项），" +
          "每一条 ### 对应一个具体对象或子题；禁止空泛套话（如只写压实责任、强化考核而无具体对象）；" +
          "多组参考保持子主题集合一致，仅变换对仗措辞。"
      );
    if (hasH3)
      parts.push(
        "三级：Markdown #### 。须从上级要点继续拆具体条，禁止空泛套话。"
      );
    if (hasBody) parts.push("正文：标题下的事实与表述段落；无依据标【待核实】。");
    if (!hasBody && (hasH1 || hasH2 || hasH3)) {
      parts.push("本次只要标题骨架，少写长段正文。");
    }
    if (!hasH1 && !hasH2 && !hasH3 && hasBody) {
      parts.push("本次只要正文段落，不要新增标题行。");
    }
    return parts.join("");
  }

  function pinnedScopeHint() {
    var t = workText();
    if (!t.replace(/\s/g, "")) return "";
    return (
      "用户已钉住研究范围，产出须紧贴该范围（可含其下应出现的子级），勿改动范围外其它同级块。\n【钉住范围】\n" +
      t.slice(0, 6000)
    );
  }

  /** 上次由层级芯片自动填入的话术；用户改过则不再覆盖 */
  var lastAutoLevelPrompt = "";

  /**
   * 按多选层级拼一条不冲突的默认话术（单一任务说明，不互相否定）。
   */
  function composeWriteLevelPrompt(levels) {
    if (!levels || !levels.length) return "";
    var has = function (k) {
      return levels.indexOf(k) >= 0;
    };
    var titles = [];
    if (has("h1")) titles.push("一级标题");
    if (has("h2")) titles.push("二级标题");
    if (has("h3")) titles.push("三级标题");
    var onlyBody = !titles.length && has("body");
    var withBody = has("body");
    var pinned = !!(state.work && String(state.work.text || "").replace(/\s/g, ""));

    if (onlyBody) {
      return pinned
        ? "请在钉住范围内撰写正文，不要新增标题行；无依据处标【待核实】。"
        : "请撰写正文段落，不要新增标题行；无依据处标【待核实】。";
    }

    var scope = pinned
      ? "紧贴钉住范围展开，勿改动范围外其它同级块。"
      : "按本稿需要组织。";

    if (titles.length === 1 && titles[0] === "二级标题" && !has("h1")) {
      return (
        "请给出二级标题（### （一）（二）…）。" +
        scope +
        "子主题须从钉住范围与要点中的并列项拆出，一条对应一个具体对象；" +
        (withBody
          ? "可在各二级下附简短正文要点；"
          : "只要二级标题骨架，少写长段；") +
        "不要出现未点选的其它标题层级。"
      );
    }
    if (titles.length === 1 && titles[0] === "三级标题" && !has("h2") && !has("h1")) {
      return (
        "请给出三级标题（####）。" +
        scope +
        (withBody ? "可附简短正文要点；" : "只要三级标题骨架，少写长段；") +
        "不要出现未点选的其它标题层级。"
      );
    }
    if (titles.length === 1 && titles[0] === "一级标题") {
      return (
        "请给出一级标题（## 一、二、三…），措辞优先对仗。" +
        scope +
        (withBody
          ? "可在一级下附简短正文要点；"
          : "只要一级标题骨架，不要二级/三级，少写长段；") +
        (withBody ? "未点选的更细标题层级不要出现。" : "")
      );
    }

    /* 多选标题：一条里列齐，明确「只出点选层」 */
    var head =
      "请给出" +
      titles.join("、") +
      (withBody ? "，并在相应标题下写正文要点" : "标题骨架（少写长段正文）") +
      "。";
    var rule =
      "只输出已点选的层级，未点选的层级不要出现。" + scope;
    if (has("h1")) rule += "一级用 ##；";
    if (has("h2")) rule += "二级用 ### （一）（二）；";
    if (has("h3")) rule += "三级用 ####；";
    if (withBody) rule += "无依据标【待核实】。";
    return head + rule;
  }

  function syncWriteLevelPrompt() {
    var req = $("aiReq");
    if (!req) return;
    var next = composeWriteLevelPrompt(selectedWriteLevels());
    var cur = String(req.value || "");
    if (!cur.trim() || cur === lastAutoLevelPrompt) {
      req.value = next;
      lastAutoLevelPrompt = next;
    }
  }

  function ensureBase() {
    if (!GwRelay.baseUrl()) {
      GwRelay.setBase("http://49.233.190.103:8080/gongwen-relay");
    }
  }

  function workText() {
    return state.work && state.work.text ? state.work.text : "";
  }

  function liveText() {
    return state.live && state.live.text ? state.live.text : "";
  }

  function charCount(t) {
    return String(t || "").replace(/\s/g, "").length;
  }

  function isTruncated(t) {
    var one = String(t || "").replace(/\s+/g, " ").trim();
    return one.length > CHIP_SLICE || String(t || "").length > CHIP_SLICE + 8;
  }

  function snapshotEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      a.start === b.start &&
      a.end === b.end &&
      String(a.text || "") === String(b.text || "")
    );
  }

  /** 有非空划选则写入 live（不覆盖为空，避免点侧栏失焦把 live 冲掉） */
  function readLiveFromDoc() {
    var info = null;
    try {
      info = GwDoc.getSelectionInfo();
    } catch (e) {
      return state.live;
    }
    var t = info ? String(info.text || "").replace(/[ \t]+$/g, "") : "";
    if (!t.replace(/\s/g, "")) return state.live;
    /* 同级多选后 Selection 常停在首行，勿把 live 冲成单行 */
    if (
      state.work &&
      state.work.items &&
      state.work.items.length > 1 &&
      info.start === state.work.start &&
      t.length < String(state.work.text || "").length
    ) {
      return state.live;
    }
    var next = {
      text: t,
      start: info.start,
      end: info.end,
      heading: info.heading || null,
      endsWithPara: !!info.endsWithPara || /\n$/.test(t)
    };
    if (!snapshotEqual(state.live, next)) {
      state.live = next;
      renderWorkChip();
    }
    return state.live;
  }

  function startLiveWatch() {
    if (state.liveTimer) return;
    state.liveTimer = setInterval(function () {
      try {
        readLiveFromDoc();
      } catch (e) {}
    }, LIVE_MS);
  }

  function stopLiveWatch() {
    if (state.liveTimer) {
      clearInterval(state.liveTimer);
      state.liveTimer = null;
    }
  }

  function renderSelPop() {
    var pop = $("aiSelPop");
    var body = $("aiSelPopBody");
    var meta = $("aiSelPopMeta");
    if (!pop) return;
    if (!state.selPopOpen || !state.work) {
      pop.hidden = true;
      return;
    }
    if (body) body.textContent = state.work.text;
    if (meta) {
      meta.textContent =
        charCount(state.work.text) +
        " 字" +
        (state.work.heading && state.work.heading.via
          ? " · L" + state.work.heading.lvl
          : "") +
        (state.work.items && state.work.items.length > 1
          ? " · 同级×" + state.work.items.length
          : "");
    }
    pop.hidden = false;
  }

  function setSelPop(open) {
    state.selPopOpen = !!open && !!state.work;
    renderSelPop();
    renderWorkChip();
  }

  function toggleSelPop() {
    if (!state.work) return;
    setSelPop(!state.selPopOpen);
  }

  function renderWorkChip() {
    var btn = $("aiSel");
    var text = $("aiSelText");
    var clearBtn = $("aiSelClear");
    if (!btn || !text) return;

    var wt = workText();
    var lt = liveText();
    var hasWork = !!wt.replace(/\s/g, "");
    var hasLive = !!lt.replace(/\s/g, "");

    btn.classList.toggle("has", hasWork);
    btn.classList.toggle("open", !!state.selPopOpen);
    btn.classList.toggle("pending", !hasWork && hasLive);

    if (hasWork) {
      var one = wt.replace(/\s+/g, " ").trim();
      var n =
        state.work.items && state.work.items.length > 1
          ? state.work.items.length + "条 · "
          : "";
      text.textContent =
        n + (isTruncated(wt) ? one.slice(0, CHIP_SLICE) + "…" : one);
    } else if (hasLive) {
      var l1 = lt.replace(/\s+/g, " ").trim();
      text.textContent =
        "划选中 · " +
        (isTruncated(lt) ? l1.slice(0, CHIP_SLICE) + "…" : l1);
    } else {
      text.textContent = "未钉住 · 划选后点钉住";
    }

    if (clearBtn) clearBtn.hidden = !hasWork;
    renderSelPop();
  }

  function expandSibChecked() {
    var el = $("aiExpandSib");
    return !!(el && el.checked && state.tab === "suite");
  }

  function clearSuiteSuggestions() {
    state.options = [];
    state.previewId = null;
    state.adoptedId = null;
    state.suiteBaseline = "";
  }

  function normalizeEditMd(edit) {
    if (!edit) return "";
    if (typeof edit === "string") return String(edit).trim();
    if (typeof edit === "object") return String(edit.md || "").trim();
    return "";
  }

  /** 空壳占位稿：多处【待补】/空模板，不绑死某一种材料 */
  function isBlankSummaryScaffold(md) {
    var s = String(md || "");
    if (!s.replace(/\s/g, "")) return true;
    var pending = (s.match(/【待补[^】]*】/g) || []).length;
    if (pending >= 2) return true;
    if (/已搭.*骨架/.test(s) && pending >= 1) return true;
    if (
      /工作概况/.test(s) &&
      /重点工作/.test(s) &&
      /【待补/.test(s)
    ) {
      return true;
    }
    return false;
  }

  function userAskedForScaffold(msg) {
    return /框架|提纲|搭架|搭个|大纲|目录|起个架子|列个提纲|列个目录/.test(
      String(msg || "")
    );
  }

  /** 从中转/正文中拆多组参考 */
  function splitVariantsFromMd(md) {
    var raw = String(md || "").trim();
    if (!raw) return [];
    var re =
      /(?:^|\n)(?:#{1,3}\s*)?(?:方案|参考|组)\s*([一二三四五六七八九十\dA-Ea-e])[、.．:：)\s]*/g;
    var idxs = [];
    var m;
    while ((m = re.exec(raw))) {
      idxs.push({ i: m.index === 0 ? 0 : m.index + 1, label: m[1] });
    }
    if (idxs.length < 2) return [];
    var out = [];
    var k;
    for (k = 0; k < idxs.length; k++) {
      var start = idxs[k].i;
      var end = k + 1 < idxs.length ? idxs[k + 1].i : raw.length;
      var chunk = raw.slice(start, end).trim();
      if (chunk.replace(/\s/g, "").length < 20) continue;
      out.push({
        id: String.fromCharCode(65 + out.length),
        md: chunk,
        note: "方案" + idxs[k].label
      });
    }
    return out;
  }

  function extractWriteVariants(data, reply, editMd) {
    var list = [];
    var src =
      (data && data.options) ||
      (data && data.edit && data.edit.options) ||
      null;
    if (src && src.length) list = normalizeOptions(src);
    if (!list.length && window.GwMaterialTools) {
      var parsed = GwMaterialTools.parseAgentPayload(reply, data);
      if (parsed && parsed.options && parsed.options.length) {
        list = normalizeOptions(parsed.options);
      }
      if (parsed && parsed.edit && parsed.edit.options) {
        list = normalizeOptions(parsed.edit.options);
      }
      if (
        !list.length &&
        parsed &&
        parsed.kind === "final" &&
        parsed.edit &&
        Array.isArray(parsed.edit)
      ) {
        list = normalizeOptions(parsed.edit);
      }
    }
    if (!list.length) list = splitVariantsFromMd(editMd || "");
    if (!list.length) list = splitVariantsFromMd(reply || "");
    return (list || []).filter(function (o) {
      return o && String(o.md || "").replace(/\s/g, "").length >= 20;
    });
  }

  /**
   * 中转只回空壳时：按用户话里的「第一点/第二点…」本地生成多组一级提纲。
   * 标题用通用对仗模板套用户要点，不查行业/单位词表。
   */
  function synthVariantsFromUserOutline(msg) {
    var s = String(msg || "");
    var blocks = [];
    var re = /第([一二三四五六七八九十\d]+)点[说是：:\s]*/g;
    var hits = [];
    var m;
    while ((m = re.exec(s))) {
      hits.push({
        n: m[1],
        headEnd: m.index + m[0].length,
        headStart: m.index
      });
    }
    var i;
    for (i = 0; i < hits.length; i++) {
      var end = i + 1 < hits.length ? hits[i + 1].headStart : s.length;
      var slice = s.slice(hits[i].headEnd, end);
      var cut = slice.search(/二级标题|我比较喜欢|这样的句式|句式/);
      if (cut >= 0) slice = slice.slice(0, cut);
      var body = slice
        .replace(/[【】\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (body) blocks.push({ n: hits[i].n, body: body });
    }
    if (blocks.length < 2) return [];

    function titleFromBlock(body, tone) {
      var themes = extractThemesUniversal(body);
      if (themes.length) return pairTitleFromTheme(themes[0], tone);
      var parts = String(body || "")
        .split(/[，,、含和与]/)
        .map(function (x) {
          return String(x || "").replace(/\s+/g, "").trim();
        })
        .filter(function (x) {
          return x.length >= 2 && x.length <= 12;
        });
      if (parts.length >= 2) {
        return pairTitleFromTheme(parts[0] + parts[1].slice(0, 4), tone);
      }
      if (parts.length === 1) return pairTitleFromTheme(parts[0], tone);
      return pairTitleFromTheme(String(body || "").slice(0, 10) || "工作要点", tone);
    }

    function mdForTone(tone) {
      var lines = ["# 提纲", ""];
      var nums = ["一", "二", "三", "四", "五", "六"];
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        lines.push(
          "## " + (nums[j] || String(j + 1)) + "、" + titleFromBlock(b.body, tone)
        );
        lines.push("");
        lines.push("（要点：" + b.body + "）");
        lines.push("【待核实：补充事实、数据与成效，勿编造】");
        lines.push("");
      }
      return lines.join("\n");
    }

    var n = Math.min(3, Math.max(2, parseWantGroupCount(s) || 3));
    var out = [];
    var gi;
    for (gi = 0; gi < n; gi++) {
      out.push({
        id: String.fromCharCode(65 + gi),
        note: "参考" + String.fromCharCode(65 + gi),
        md: mdForTone(gi)
      });
    }
    return out;
  }

  /** 解析「给我N组」 */
  function parseWantGroupCount(msg) {
    var s = String(msg || "");
    var m = s.match(/([一二三四五六七八九十\d]+)\s*组/);
    if (!m) {
      if (/多组|几组|多份参考/.test(s)) return 3;
      return 0;
    }
    var map = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10
    };
    var n = map[m[1]] || parseInt(m[1], 10);
    if (!n || n < 2) return 0;
    return Math.min(n, 5);
  }

  /**
   * 通用：从文本里拆「子主题」列表（不绑死某一类材料/单位名）。
   * 来源：包含/分管/负责/要点/顿号并列/短句枚举。
   */
  function extractThemesUniversal(text) {
    var raw = String(text || "");
    var bag = [];
    function pushOne(x) {
      var t = String(x || "")
        .replace(/^[【\[（(]+|[】\]）)]+$/g, "")
        .replace(/^(包含|含|分管|负责|涉及|要点)[:：\s]*/, "")
        .replace(/(等大项目|等工作|情况|方面)$/g, "")
        .replace(/\s+/g, "")
        .trim();
      if (t.length < 2 || t.length > 16) return;
      if (/^(第一|第二|第三|第四|第五|各个|相关|取得|以及|还有|进行)$/.test(t))
        return;
      if (bag.indexOf(t) < 0) bag.push(t);
    }
    function pushList(chunk) {
      String(chunk || "")
        .split(/[、，,；;\/｜|及与和\s]+/)
        .forEach(pushOne);
    }
    var m;
    var reLead =
      /(?:包含|含有|含|分管|负责|涉及|涵盖)[:：\s]*([^\n【】。；;]+)/g;
    while ((m = reLead.exec(raw))) pushList(m[1]);
    reLead = /要点[:：\s]*([^\n【】]+)/g;
    while ((m = reLead.exec(raw))) pushList(m[1]);
    /* 括号里的枚举：（要点：A B C） */
    reLead = /[（(]([^）)]{4,80})[）)]/g;
    while ((m = reLead.exec(raw))) {
      if (/、|,|，|和|与|及/.test(m[1])) pushList(m[1]);
    }
    /* 已是对仗句，整句可作主题 */
    reLead = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:（[一二三四五六七八九十\d]+）)?\s*([^\n]{4,24}，[^\n]{4,24})\s*(?=\n|$)/g;
    while ((m = reLead.exec(raw))) {
      if (!/要点|待核实|钉住|请给出/.test(m[1])) pushOne(m[1]);
    }
    return bag.slice(0, 6);
  }

  /** 主题词 → 对仗二级标题（通用模板，不查行业词表） */
  function pairTitleFromTheme(theme, tone) {
    var w = String(theme || "").replace(/\s+/g, "");
    if (/，|,/.test(w) && w.length >= 6 && w.length <= 24) return w;
    w = w.slice(0, 10);
    var templates = [
      ["做实" + w + "工作", "推动落地见效"],
      ["抓实" + w + "重点", "提升工作质效"],
      ["统筹" + w + "推进", "增强整体成效"],
      ["深化" + w + "落实", "确保见行见效"],
      ["压实" + w + "责任", "盯牢目标进度"]
    ];
    var p = templates[tone % templates.length];
    return p[0] + "，" + p[1];
  }

  /**
   * 本地二级兜底（普惠）：只从钉住范围/本节/用户要点抽子主题，再套对仗句式。
   * 禁止写死某单位、某行业词表。抽不出主题则返回空，让上层提示用户补要点。
   */
  function synthL2VariantsForOneSection(msg, optGroups) {
    var s = String(msg || "");
    var levels = selectedWriteLevels();
    var wantH2 = levels.indexOf("h2") >= 0 || /二级/.test(s);
    if (!wantH2) return [];

    var nGroups = optGroups || parseWantGroupCount(s);
    if (nGroups < 2) nGroups = 3;
    nGroups = Math.min(nGroups, 5);

    var pin = workText() || "";
    var sec = "";
    var parentTitle = "";
    var pm = pin.match(/(?:^|\n)\s*([一二三四五六七八九十])、([^\n]+)/);
    if (pm) {
      sec = pm[1];
      parentTitle = String(pm[2] || "")
        .replace(/\s+/g, "")
        .replace(/（.*?）/g, "")
        .slice(0, 28);
    }
    if (!sec) {
      var hm = s.match(/[「"']?\s*([一二三四五六七八九十])\s*、/);
      if (hm) sec = hm[1];
    }
    if (!parentTitle && sec) {
      try {
        var full0 = GwDoc.getDocumentText() || "";
        var re0 = new RegExp("(?:^|\\n)\\s*" + sec + "、([^\\n]+)");
        var dm = full0.match(re0);
        if (dm)
          parentTitle = String(dm[1] || "")
            .replace(/\s+/g, "")
            .slice(0, 28);
      } catch (eDoc) {}
    }
    if (!parentTitle) parentTitle = "工作要点";

    /* 上下文：钉住优先；再并本节正文；用户话只作补充枚举来源 */
    var parts = [pin];
    if (sec) {
      try {
        var full = GwDoc.getDocumentText() || "";
        var re = new RegExp(
          "(?:^|\\n)(\\s*" +
            sec +
            "、[^\\n]*)([\\s\\S]*?)(?=(?:\\n\\s*[一二三四五六七八九十]、)|$)"
        );
        var m = full.match(re);
        if (m) parts.push(m[1], m[2]);
      } catch (e1) {}
    }
    var i;
    for (i = state.chat.length - 1; i >= 0 && i >= state.chat.length - 8; i--) {
      if (state.chat[i] && state.chat[i].role === "user") {
        parts.push(state.chat[i].text || "");
      }
    }
    parts.push(s);
    var ctx = parts.join("\n");

    var themes = extractThemesUniversal(pin);
    if (themes.length < 2) {
      var more = extractThemesUniversal(ctx);
      var t;
      for (t = 0; t < more.length; t++) {
        if (themes.indexOf(more[t]) < 0) themes.push(more[t]);
      }
      themes = themes.slice(0, 6);
    }
    if (themes.length < 2) return [];

    var out = [];
    var gi;
    for (gi = 0; gi < nGroups; gi++) {
      var lines = [];
      if (sec) lines.push("## " + sec + "、" + parentTitle, "");
      else if (parentTitle) lines.push("## " + parentTitle, "");
      var nums = ["一", "二", "三", "四", "五", "六"];
      var j;
      for (j = 0; j < themes.length; j++) {
        lines.push(
          "### （" + nums[j] + "）" + pairTitleFromTheme(themes[j], gi)
        );
        lines.push("");
      }
      out.push({
        id: String.fromCharCode(65 + gi),
        note: "参考" + String.fromCharCode(65 + gi) + " · 二级",
        md: lines.join("\n")
      });
    }
    return out;
  }

  /** 从模型 reply 里捞 ### / （一）标题行，合成一版可落稿 md */
  function extractHeadingSkeletonFromReply(reply) {
    var raw = String(reply || "");
    var lines = raw.split(/\r?\n/);
    var kept = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s+/, "").replace(/\s+$/, "");
      if (/^#{1,4}\s+\S/.test(t)) kept.push(t);
      else if (/^（[一二三四五六七八九十\d]+）\S/.test(t))
        kept.push("### " + t);
      else if (/^[一二三四五六七八九十]+、\S/.test(t) && t.length < 40)
        kept.push("## " + t);
    }
    if (kept.length < 2) return "";
    return kept.join("\n\n");
  }

  /** 多组撰写兜底：跟芯片层级走 */
  function synthWriteVariantsFallback(msg) {
    var levels = selectedWriteLevels();
    var onlyH2 =
      levels.indexOf("h2") >= 0 &&
      levels.indexOf("h1") < 0 &&
      levels.indexOf("h3") < 0;
    if (onlyH2 || (/二级/.test(String(msg || "")) && levels.indexOf("h1") < 0)) {
      var l2 = synthL2VariantsForOneSection(msg);
      if (l2.length >= 2) return { variants: l2, kind: "l2" };
    }
    var l1 = synthVariantsFromUserOutline(msg);
    if (l1.length >= 2) return { variants: l1, kind: "l1" };
    var l2b = synthL2VariantsForOneSection(msg);
    if (l2b.length >= 2) return { variants: l2b, kind: "l2" };
    return { variants: [], kind: "" };
  }

  /** 卡片落稿：写入前必须存版本；md 来自对话卡，无中转面板 */
  function resolveChatMd(src) {
    var parts = String(src || "").split(":");
    var mi = parseInt(parts[0], 10);
    var vi = parseInt(parts[1], 10);
    var msg = state.chat[mi];
    if (!msg || !msg.variants || !msg.variants[vi]) return "";
    return String(msg.variants[vi].md || "");
  }

  function saveVersionOrThrow() {
    if (!window.GwProject || !GwProject.saveActiveToVersion) {
      throw new Error("无法存版本：工程模块未就绪");
    }
    var sv = GwProject.saveActiveToVersion();
    if (!sv || !sv.ok) {
      throw new Error((sv && sv.error) || "存版本失败，已中止写入");
    }
    return sv;
  }

  /** 每个改正文的点击：先存版本，再执行写入 */
  function withVersionThenWrite(md, label, writeFn) {
    if (state.busy) return;
    if (!String(md || "").replace(/\s/g, "")) {
      tip("没有可写入内容");
      return;
    }
    setBusy(true);
    tip("正在存版本…");
    try {
      var sv = saveVersionOrThrow();
      tip("已存版本 · 正在" + label + "…");
      writeFn(md);
      tip(
        label +
          "完成 · 版本：" +
          (sv.path ? String(sv.path).replace(/^.*[\\\/]/, "") : "已保存")
      );
    } catch (e) {
      tip(e.message || String(e));
      alert(e.message || e);
    }
    setBusy(false);
  }

  function applyDraftFull(md) {
    withVersionThenWrite(md, "整篇排版写入", function (text) {
      GwDoc.writeDocumentStyled(text);
    });
  }

  function applyDraftCursor(md) {
    withVersionThenWrite(md, "写入光标处", function (text) {
      GwDoc.insertAtCursor(text);
    });
  }

  function applyDraftSelection(md) {
    /* 撰写已钉住：对准钉住范围；若钉在标题上则扩成「标题整块」再覆盖，避免留下旧要点 */
    if (
      state.tab === "write" &&
      state.work &&
      typeof state.work.start === "number" &&
      typeof state.work.end === "number"
    ) {
      try {
        GwDoc.selectRange(state.work.start, state.work.end);
      } catch (ePin) {}
      try {
        var sec =
          GwDoc.selectHeadingSection && GwDoc.selectHeadingSection();
        if (sec && typeof sec.start === "number") {
          state.work.start = sec.start;
          state.work.end = sec.end;
          state.work.text = sec.text || state.work.text;
          state.work.endsWithPara = true;
        }
      } catch (eSec) {
        /* 非标题选区则保持原钉住范围 */
      }
    }
    var info = null;
    try {
      info = GwDoc.getSelectionInfo();
    } catch (e) {}
    if (!info || !String(info.text || "").replace(/\s/g, "")) {
      tip("请先划选或钉住要覆盖的区域");
      alert("请先在正文划选（或钉住）要覆盖的内容，再点「选定」。");
      return;
    }
    var coverStart = info.start;
    var coverEnd = info.end;
    withVersionThenWrite(md, "覆盖选定区", function (text) {
      try {
        GwDoc.selectRange(coverStart, coverEnd);
      } catch (e2) {}
      GwDoc.replaceSelection(text, {
        endsWithPara: !!info.endsWithPara
      });
      /* 覆盖后旧钉失效，避免下次误盖 */
      if (state.tab === "write") {
        state.work = null;
        renderWorkChip();
      }
    });
  }

  function copyDocDraft(md) {
    if (!String(md || "").replace(/\s/g, "")) {
      tip("没有可复制内容");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(
        function () {
          tip("已复制");
        },
        function () {
          tip("复制失败");
        }
      );
    } else {
      tip("当前环境不支持复制");
    }
  }

  function handleCardApply(mode, src) {
    var md = resolveChatMd(src);
    if (mode === "full") applyDraftFull(md);
    else if (mode === "cursor") applyDraftCursor(md);
    else if (mode === "sel") applyDraftSelection(md);
    else if (mode === "copy") copyDocDraft(md);
  }

  /**
   * 换钉前：若正文上叠着预览，先还原到出方案原文，再清方案。
   * 对标旧版 clearAiSuiteState：新选定 = 旧建议作废。
   */
  function resetSuiteForNewPin() {
    if (
      state.tab === "suite" &&
      state.work &&
      state.suiteBaseline &&
      (state.previewId || state.adoptedId)
    ) {
      try {
        writeWorkText(state.suiteBaseline);
      } catch (e) {
        /* 锚点失效则仍清状态，避免旧方案挂在新钉子上 */
      }
    }
    clearSuiteSuggestions();
    syncRestoreBtn();
  }

  function setWorkFromSnapshot(snap, extras) {
    extras = extras || {};
    /* 钉住即换工作选区：旧精修建议作废 */
    resetSuiteForNewPin();
    state.work = {
      text: snap.text,
      start: snap.start,
      end: snap.end,
      heading: snap.heading || null,
      items: extras.items || null,
      endsWithPara: !!snap.endsWithPara
    };
    state.selPopOpen = false;
    renderWorkChip();
    renderOpts();
    syncTabUi();
    var n = (extras.items && extras.items.length) || 1;
    tip(
      "已钉住 · " +
        charCount(snap.text) +
        " 字" +
        (n > 1 ? " · 同级×" + n : "") +
        (state.tab === "suite" ? " · 可出方案" : "")
    );
    if (state.tab === "write") syncWriteLevelPrompt();
    return state.work;
  }

  /**
   * 「钉住」：永远可覆盖。优先此刻 Selection，否则用 live。
   */
  function commitLiveToWork(opts) {
    opts = opts || {};
    readLiveFromDoc();

    if (expandSibChecked()) {
      try {
        var r = GwDoc.selectSiblingHeadings();
        if (!r || !r.text || !String(r.text).replace(/\s/g, "")) {
          if (opts.alert) tip("未选到同级标题");
          return null;
        }
        state.live = {
          text: r.text,
          start: r.start,
          end: r.end,
          heading: r.heading || null
        };
        return setWorkFromSnapshot(state.live, {
          items: r.items,
          count: r.count
        });
      } catch (e) {
        /* 扩选失败则退回普通划选 */
        if (opts.alert) tip(e.message || "扩选失败，已试普通选区");
      }
    }

    var snap = null;
    try {
      var info = GwDoc.getSelectionInfo();
      var t = info ? String(info.text || "").replace(/[ \t]+$/g, "") : "";
      if (t.replace(/\s/g, "")) {
        snap = {
          text: t,
          start: info.start,
          end: info.end,
          heading: info.heading || null,
          endsWithPara: !!info.endsWithPara || /\n$/.test(t)
        };
        state.live = snap;
      }
    } catch (e2) {}

    if (!snap && state.live && liveText().replace(/\s/g, "")) {
      snap = state.live;
    }

    if (!snap || !String(snap.text || "").replace(/\s/g, "")) {
      if (opts.alert) tip("请先在正文划选");
      return null;
    }
    /* 划到段尾却未带上 \r 时：若 end 已顶到段末标记，仍按段末处理 */
    if (!snap.endsWithPara && typeof snap.end === "number") {
      try {
        var probe = GwDoc.getSelectionInfo();
        if (probe && probe.endsWithPara) snap.endsWithPara = true;
      } catch (e3) {}
    }
    return setWorkFromSnapshot(snap, {});
  }

  function clearWork(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (
      state.work &&
      state.suiteBaseline &&
      (state.previewId || state.adoptedId)
    ) {
      try {
        writeWorkText(state.suiteBaseline);
      } catch (e) {}
    }
    state.work = null;
    clearSuiteSuggestions();
    state.selPopOpen = false;
    syncRestoreBtn();
    renderWorkChip();
    renderOpts();
    if (state.tab === "write") syncWriteLevelPrompt();
    tip("已清除");
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function diffPlain(oldStr, newStr) {
    var a = String(oldStr || "").split("");
    var b = String(newStr || "").split("");
    var n = a.length;
    var m = b.length;
    if (!n && !m) return { html: "", del: 0, ins: 0 };
    if (n * m > 400000) {
      return {
        html:
          (n ? '<span class="diff-del">' + escHtml(oldStr) + "</span>" : "") +
          (m ? '<ins class="diff-ins">' + escHtml(newStr) + "</ins>" : ""),
        del: n,
        ins: m
      };
    }
    var dp = [];
    var i;
    var j;
    for (i = 0; i <= n; i++) {
      dp[i] = new Array(m + 1);
      for (j = 0; j <= m; j++) dp[i][j] = 0;
    }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] =
          a[i] === b[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var raw = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        raw.push({ t: "eq", s: a[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        raw.push({ t: "del", s: a[i] });
        i += 1;
      } else {
        raw.push({ t: "ins", s: b[j] });
        j += 1;
      }
    }
    while (i < n) {
      raw.push({ t: "del", s: a[i] });
      i += 1;
    }
    while (j < m) {
      raw.push({ t: "ins", s: b[j] });
      j += 1;
    }
    var parts = [];
    raw.forEach(function (p) {
      var last = parts[parts.length - 1];
      if (last && last.t === p.t) last.s += p.s;
      else parts.push({ t: p.t, s: p.s });
    });
    var del = 0;
    var ins = 0;
    var html = parts
      .map(function (p) {
        var e = escHtml(p.s);
        if (p.t === "del") {
          del += p.s.length;
          return '<span class="diff-del">' + e + "</span>";
        }
        if (p.t === "ins") {
          ins += p.s.length;
          return '<ins class="diff-ins">' + e + "</ins>";
        }
        return e;
      })
      .join("");
    return { html: html, del: del, ins: ins };
  }

  function suiteBaselineText() {
    return state.suiteBaseline || (state.work && state.work.text) || "";
  }

  function buildOptDiff(opt) {
    var oldText = suiteBaselineText();
    var newText = opt.md || "";
    return diffPlain(oldText, newText);
  }

  function normalizeOptions(list) {
    return (list || []).map(function (o, idx) {
      return {
        id: String((o && o.id) || String.fromCharCode(65 + idx)),
        md: String((o && (o.md || o.text || o.content)) || ""),
        note: (o && o.note) || "",
        recommend: !!(o && o.recommend),
        score: o && o.score,
        items: o && o.items
      };
    });
  }

  function findOpt(id) {
    for (var i = 0; i < state.options.length; i++) {
      if (state.options[i].id === id) return state.options[i];
    }
    return null;
  }

  function syncRestoreBtn() {
    var btn = $("aiRestore");
    if (!btn) return;
    /* 仅精修：出方案后可还原选区。撰写整篇禁止用纯文本覆盖还原。 */
    var show =
      state.tab === "suite" &&
      !!(state.work && state.suiteBaseline && (state.previewId || state.adoptedId));
    btn.hidden = !show;
    if (show) btn.classList.add("show");
    else btn.classList.remove("show");
    btn.disabled = !!state.busy;
    btn.title = "还原为出方案前的原文";
  }

  /** 按钉子范围写回；保留原段末标记，避免与下一段粘连 */
  function writeWorkText(md, opts) {
    opts = opts || {};
    if (state.work && state.work.items && state.work.items.length > 1) {
      tip("同级多条暂不支持一次写回，请取消扩选后单条精修");
      alert("同级多标题暂不支持一次写回，请取消扩选后只精修一条。");
      return false;
    }
    if (!state.work) throw new Error("请先钉住选区");
    if (
      typeof state.work.start !== "number" ||
      typeof state.work.end !== "number"
    ) {
      throw new Error("选区锚点已失效，请重新钉住后再试");
    }
    var r = GwDoc.replaceRange(
      state.work.start,
      state.work.end,
      md || "",
      {
        endsWithPara: !!state.work.endsWithPara,
        allowEmpty: !!opts.allowEmpty
      }
    );
    state.work.text = String(md || "");
    state.work.start = r.start;
    state.work.end = r.end;
    renderWorkChip();
    syncRestoreBtn();
    return true;
  }

  function previewOpt(id) {
    var opt = findOpt(id);
    if (!opt || !state.work) return;
    try {
      /* 切换方案前先回到原文锚点内容，再叠新预览（对标 restoreDocPreview + apply） */
      if (state.previewId && state.previewId !== id && state.suiteBaseline) {
        if (!writeWorkText(state.suiteBaseline)) return;
      }
      if (!writeWorkText(opt.md || "")) return;
      state.previewId = id;
      state.adoptedId = null;
      renderOpts();
      syncTabUi();
      tip("预览方案 " + id + "（已叠到正文）");
    } catch (e) {
      tip(e.message || "预览失败");
      alert(e.message || e);
    }
  }

  function adoptOpt(id) {
    var opt = findOpt(id);
    if (!opt || !state.work) return;
    try {
      if (state.previewId === id) {
        /* 已在预览同一方案：正文已是目标，直接确认 */
        state.adoptedId = id;
        state.previewId = null;
      } else {
        if (state.previewId && state.suiteBaseline) {
          if (!writeWorkText(state.suiteBaseline)) return;
        }
        if (!writeWorkText(opt.md || "")) return;
        state.adoptedId = id;
        state.previewId = null;
      }
      renderOpts();
      syncTabUi();
      tip("已采用方案 " + id + " · 可还原");
    } catch (e) {
      tip(e.message || "采用失败");
      alert(e.message || e);
    }
  }

  function restoreSuiteBaseline() {
    if (state.busy) return;
    if (!state.work || !state.suiteBaseline) {
      tip("没有可还原的原文");
      return;
    }
    try {
      if (!writeWorkText(state.suiteBaseline)) return;
      state.previewId = null;
      state.adoptedId = null;
      renderOpts();
      syncTabUi();
      tip("已还原为出方案前原文");
    } catch (e) {
      tip(e.message || "还原失败");
      alert(e.message || e);
    }
  }

  function syncTabUi() {
    var tab = state.tab;
    ["write", "suite", "proof"].forEach(function (name) {
      var id =
        name === "write"
          ? "aiTabWrite"
          : name === "suite"
            ? "aiTabSuite"
            : "aiTabProof";
      var b = $(id);
      if (b) b.classList.toggle("on", tab === name);
    });
    $("aiProofBar").hidden = tab !== "proof";
    $("aiCompose").hidden = tab === "proof";
    var levels = $("aiWriteLevels");
    if (levels) levels.hidden = tab !== "write";
    $("aiSuitePresets").hidden = tab !== "suite";
    var expandWrap = $("aiExpandSibWrap");
    if (expandWrap) expandWrap.hidden = tab !== "suite";
    /* 撰写/精修都可钉范围；校对隐藏 */
    var selBlock = $("aiSelBlock");
    if (selBlock) selBlock.hidden = tab === "proof";
    var wantWrap = $("aiWantDraftWrap");
    if (wantWrap) wantWrap.hidden = tab !== "write";
    var varWrap = $("aiWantVariantsWrap");
    if (varWrap) varWrap.hidden = tab !== "write";
    $("aiSuiteHint").hidden = tab !== "suite";
    $("aiClearChat").hidden = tab === "proof" || tab === "suite";
    var ha = $("aiHeadActions");
    if (ha) ha.hidden = false;
    var lv = selectedWriteLevels();
    $("aiReq").placeholder =
      tab === "suite"
        ? "写精修要求，或点上方充填 / 润色…"
        : wantVariantsChecked()
          ? "已勾选给多份：可写组数、侧重…"
          : wantDraftChecked()
            ? "已勾选出结论：可写范围补充…"
            : "纯聊天，或点选层级后勾选「出结论/给多份」…";
    $("aiSend").textContent =
      tab === "suite" ? (state.options.length ? "再出" : "出方案") : "发送";
    var status = $("aiEditStatus");
    if (status) {
      status.textContent =
        tab === "suite"
          ? state.previewId
            ? "预览中"
            : state.adoptedId
              ? "已采用"
              : "精修"
          : lv.length
            ? lv
                .map(function (x) {
                  return (
                    { h1: "一级", h2: "二级", h3: "三级", body: "正文" }[x] ||
                    x
                  );
                })
                .join("+")
            : wantVariantsChecked()
              ? "给多份"
              : wantDraftChecked()
                ? "出结论"
                : "纯聊天";
    }
    if (tab === "suite" && state.options.length) {
      tip(
        state.previewId
          ? "预览中 · 可还原或采用"
          : state.adoptedId
            ? "已采用 · 可还原"
            : "精修会改写选定 · 可预览 / 采用"
      );
    } else {
      tip(
        tab === "suite"
          ? "划选后点「钉住」；可反复换钉"
          : tab === "proof"
            ? "选范围后点开始校对"
            : wantVariantsChecked() || wantDraftChecked()
              ? lv.length
                ? "已选层级 · 钉住范围后发送；落点用选定/光标"
                : "请先点选一级/二级/三级/正文"
              : "点选层级并勾选「出结论」或「给多份」再要稿"
      );
    }
    syncRestoreBtn();
    renderWorkChip();
    renderOpts();
  }

  function renderOpts() {
    var box = $("aiOpts");
    if (!box) return;
    box.innerHTML = "";
    if (state.tab === "proof") {
      if (!state.proof.length) {
        box.innerHTML =
          '<div class="ai-empty">点上方「开始校对」；结果点条目可定位。</div>';
        return;
      }
      state.proof.forEach(function (item, idx) {
        var div = document.createElement("div");
        div.className = "ai-err";
        div.innerHTML =
          '<div class="ai-err-type">#' +
          (idx + 1) +
          " " +
          (item.reason || item.type || "问题") +
          "</div>" +
          '<div class="ai-err-body"><del></del><ins></ins></div>' +
          '<div class="ai-err-acts">' +
          '<button type="button" data-act="go">定位</button>' +
          '<button type="button" data-act="fix">采纳</button></div>';
        div.querySelector("del").textContent = item.original || "";
        div.querySelector("ins").textContent = item.suggestion || "";
        div.querySelector('[data-act="go"]').onclick = function (ev) {
          ev.stopPropagation();
          try {
            GwDoc.findAndHighlight(item.original);
          } catch (e) {
            tip(e.message);
          }
        };
        div.querySelector('[data-act="fix"]').onclick = function (ev) {
          ev.stopPropagation();
          try {
            GwDoc.applySuggestion(item.original, item.suggestion);
            div.classList.add("applied");
          } catch (e) {
            tip(e.message);
          }
        };
        div.onclick = function () {
          try {
            GwDoc.findAndHighlight(item.original);
          } catch (e) {
            tip(e.message);
          }
        };
        box.appendChild(div);
      });
      return;
    }

    if (state.tab === "suite") {
      if (!state.options.length) {
        box.innerHTML =
          '<div class="ai-empty"><b>精修会改写选定</b>：划选并钉住 → 充填/润色或写要求 → 出方案 → 预览/采用</div>';
        return;
      }
      var view = state.optView === "new" ? "new" : "diff";
      state.options.forEach(function (opt) {
        var div = document.createElement("div");
        var cls = "ai-opt";
        if (opt.recommend) cls += " recommend";
        if (state.adoptedId === opt.id) cls += " adopted";
        else if (state.previewId === opt.id) cls += " chosen";
        div.className = cls;
        var badge =
          state.adoptedId === opt.id
            ? "已采用"
            : state.previewId === opt.id
              ? "预览中"
              : "点击预览";
        var adoptLabel =
          state.adoptedId === opt.id
            ? "已采用"
            : state.adoptedId
              ? "替换为此方案"
              : "采用";
        var diff = buildOptDiff(opt);
        var bodyHtml =
          view === "new" ? escHtml(opt.md || "") : diff.html || escHtml(opt.md || "");
        var bodyCls = view === "new" ? "ai-body" : "ai-body diff-body";
        div.innerHTML =
          '<div class="ai-opt-head">' +
          '<span class="ai-tag">' +
          escHtml(opt.id) +
          "</span>" +
          (opt.recommend ? '<span class="ai-rec">推荐</span>' : "") +
          (opt.score ? "<span>" + escHtml(opt.score) + "分</span>" : "") +
          "<span>" +
          badge +
          "</span>" +
          '<div class="ai-view-tabs">' +
          '<button type="button" data-ai-view="diff" class="' +
          (view === "diff" ? "on" : "") +
          '">对照</button>' +
          '<button type="button" data-ai-view="new" class="' +
          (view === "new" ? "on" : "") +
          '">新稿</button>' +
          "</div>" +
          '<span class="diff-stat">删' +
          diff.del +
          " · 增" +
          diff.ins +
          "</span></div>" +
          (opt.note
            ? '<div class="ai-note">' + escHtml(opt.note) + "</div>"
            : "") +
          '<div class="' +
          bodyCls +
          '" data-ai-preview="' +
          escHtml(opt.id) +
          '">' +
          bodyHtml +
          "</div>" +
          '<div class="ai-actions">' +
          '<button type="button" data-ai-preview="' +
          escHtml(opt.id) +
          '">预览</button>' +
          '<button type="button" class="primary" data-ai-adopt="' +
          escHtml(opt.id) +
          '"' +
          (state.adoptedId === opt.id ? " disabled" : "") +
          ">" +
          adoptLabel +
          "</button></div>";
        box.appendChild(div);
      });
      box.onclick = function (ev) {
        var t = ev.target;
        if (!t) return;
        var viewBtn = t.closest ? t.closest("[data-ai-view]") : null;
        if (viewBtn) {
          state.optView =
            viewBtn.getAttribute("data-ai-view") === "new" ? "new" : "diff";
          renderOpts();
          return;
        }
        var adoptBtn = t.closest ? t.closest("[data-ai-adopt]") : null;
        if (adoptBtn) {
          adoptOpt(adoptBtn.getAttribute("data-ai-adopt"));
          return;
        }
        var prev = t.closest ? t.closest("[data-ai-preview]") : null;
        if (prev) {
          previewOpt(prev.getAttribute("data-ai-preview"));
        }
      };
      return;
    }

    if (!state.chat.length) {
      box.innerHTML =
        '<div class="ai-empty">撰写：点选「一级/二级/三级/正文」（可多选）→ 需要时钉住范围 → 勾选「出结论/给多份」→ 发送。卡片上用选定或光标写入。</div>';
      return;
    }
    var log = document.createElement("div");
    log.className = "ai-chat-log";
    state.chat.forEach(function (m, mi) {
      var b = document.createElement("div");
      b.className = "ai-bubble " + (m.role === "user" ? "user" : "assistant");
      b.textContent = m.text;
      if (m.role === "assistant" && m.variants && m.variants.length) {
        m.variants.forEach(function (v, vi) {
          var card = document.createElement("div");
          card.className = "ai-variant";
          var head = document.createElement("div");
          head.className = "ai-variant-head";
          head.textContent =
            (v.note && String(v.note)) || "参考 " + (v.id || vi + 1);
          var pre = document.createElement("pre");
          pre.className = "ai-variant-body";
          pre.textContent = v.md || "";
          var acts = document.createElement("div");
          acts.className = "ai-actions";
          var src = String(mi) + ":" + String(vi);
          [
            {
              mode: "full",
              label: "整篇",
              primary: true,
              title: "先存版本，再按层级排版覆盖当前全文"
            },
            {
              mode: "cursor",
              label: "光标",
              title: "先存版本，再插入到光标处"
            },
            {
              mode: "sel",
              label: "选定",
              title: "先存版本，再覆盖当前划选"
            },
            { mode: "copy", label: "复制", title: "复制到剪贴板" }
          ].forEach(function (spec) {
            var btn = document.createElement("button");
            btn.type = "button";
            if (spec.primary) btn.className = "primary";
            btn.textContent = spec.label;
            btn.title = spec.title;
            btn.setAttribute("data-apply", spec.mode);
            btn.setAttribute("data-src", src);
            acts.appendChild(btn);
          });
          card.appendChild(head);
          card.appendChild(pre);
          card.appendChild(acts);
          b.appendChild(card);
        });
      }
      log.appendChild(b);
    });
    box.appendChild(log);
    box.onclick = function (ev) {
      var t = ev.target;
      var applyBtn = t.closest ? t.closest("[data-apply]") : null;
      if (!applyBtn) return;
      handleCardApply(
        applyBtn.getAttribute("data-apply") || "",
        applyBtn.getAttribute("data-src") || ""
      );
    };
    box.scrollTop = box.scrollHeight;
  }

  function setBusy(on) {
    state.busy = !!on;
    $("aiSend").disabled = !!on;
    $("proofRun").disabled = !!on;
  }

  function withLogin(fn) {
    ensureBase();
    if (window.GwAccount && GwAccount.requireLogin) {
      return GwAccount.requireLogin().then(fn);
    }
    return GwRelay.ensureAccess().then(function (ok) {
      if (!ok || !GwRelay.tokens().access) {
        tip("请先登录账号");
        throw Object.assign(new Error("请先登录账号"), { status: 401 });
      }
      return fn();
    });
  }

  /** 自动精读不刷条；用户引用只走 aiCiteBar */
  function hideReadBar() {
    var bar = $("aiReadBar");
    if (!bar) return;
    bar.hidden = true;
    bar.innerHTML = "";
  }

  function docContextMd() {
    var full = "";
    try {
      full = GwDoc.getDocumentText() || "";
    } catch (e) {
      full = "";
    }
    return contextWithCites(full);
  }

  function sendWrite() {
    var levels = selectedWriteLevels();
    var wantDraft = wantDraftChecked();
    var wantVars = wantVariantsChecked();
    var allow = wantDraft || wantVars;
    var msg = ($("aiReq").value || "").trim();
    if (allow && !levels.length) {
      tip("请先点选一级 / 二级 / 三级 / 正文");
      return;
    }
    if (!msg && !allow) {
      tip("请先输入内容，或点选层级并勾选「出结论/给多份」");
      return;
    }
    if (!msg && allow) {
      msg = "请按已点选的产出层级给出结论。";
    }
    var ctx = docContextMd();
    var mats = citedMaterials();
    var pin = pinnedScopeHint();
    var levelRule = levels.length ? writeLevelConstraint(levels) : "";
    var sendMsg = msg;
    if (wantVars) {
      sendMsg =
        msg +
        "\n\n【宿主约束】已勾选「给多份」。" +
        "必须输出 JSON：{reply, options:[{id,md,note},...]}，edit 必须为 null。" +
        "严禁空壳【待补】占位模板。" +
        "每组 options[].md 必须是可落稿 Markdown（含 ##/### 标题行），禁止只在 reply 里用自然语言罗列标题。" +
        levelRule +
        (pin ? pin + "\n" : "") +
        "默认 3 组（用户指定组数从其，最多 5）。每组 note 一句差异；reply 一两句；禁止声称已写入；无依据勿编造。";
    } else if (wantDraft) {
      sendMsg =
        msg +
        "\n\n【宿主约束】已勾选「出结论」。" +
        "输出一版：JSON 为 {reply, edit:{md}}；edit.md 必须是可落稿 Markdown，禁止只在 reply 描述。" +
        "严禁空壳【待补】占位模板。" +
        levelRule +
        (pin ? pin + "\n" : "") +
        "禁止声称已写入；无依据处标待核实。";
    } else {
      sendMsg =
        msg +
        "\n\n【宿主约束】未勾选「出结论/给多份」：纯聊天。" +
        "只用 reply；edit 与 options 必须为 null；禁止输出可落稿正文或空壳占位。" +
        (pin ? pin + "\n" : "") +
        "可商量结构；要落稿时请点选层级并勾选后再出。";
    }
    withLogin(function () {
      state.chat.push({ role: "user", text: msg });
      $("aiReq").value = "";
      renderOpts();
      setBusy(true);
      tip(allow ? "撰写中…" : "聊天中…");
      hideReadBar();
      var runner =
        window.GwChatLoop && GwChatLoop.runChat
          ? GwChatLoop.runChat({
              message: sendMsg,
              contextMd: ctx,
              capability: capability(),
              allowEdit: allow,
              materials: mats,
              onStatus: function (s) {
                var t = String(s || "");
                if (/索引|同步/.test(t)) tip("正在准备材料…");
                else if (/执行|read_file|list_files|search/.test(t))
                  tip("正在查阅材料…");
                else tip(allow ? "撰写中…" : "聊天中…");
              }
            })
          : GwRelay.chat(sendMsg, ctx, capability(), allow, mats).then(
              function (data) {
                return {
                  reply: (data && data.reply) || "(空回复)",
                  edit: data && data.edit,
                  options: data && data.options
                };
              }
            );
      return runner
        .then(function (data) {
          var reply = (data && data.reply) || "(空回复)";
          var editMd = allow ? normalizeEditMd(data && data.edit) : "";
          if (allow && !editMd && window.GwMaterialTools) {
            var parsed = GwMaterialTools.parseAgentPayload(reply, data);
            if (parsed && parsed.edit) {
              editMd = normalizeEditMd(parsed.edit);
              if (parsed.reply) reply = parsed.reply;
            }
          }
          if (!allow) editMd = "";
          if (
            allow &&
            editMd &&
            isBlankSummaryScaffold(editMd) &&
            !userAskedForScaffold(msg)
          ) {
            editMd = "";
            reply =
              "（已拦截中转误回的空壳占位稿。）\n\n请确认已点选产出层级，并勾选「出结论」或「给多份」后重发。";
          }
          var variants = [];
          if (wantVars) {
            variants = extractWriteVariants(data, reply, editMd);
            if (
              variants.length < 2 &&
              (isBlankSummaryScaffold(editMd) ||
                /已搭.*骨架/.test(reply || ""))
            ) {
              editMd = "";
            }
            if (variants.length < 2) {
              var sk = extractHeadingSkeletonFromReply(reply);
              if (sk) {
                variants = [{ id: "A", note: "从回复提取", md: sk }];
              }
            }
            if (variants.length < 2) {
              var fb = synthWriteVariantsFallback(msg);
              if (fb.variants.length >= 2) {
                variants = fb.variants;
                reply =
                  fb.kind === "l2"
                    ? "（中转未给出可用多份稿，已按钉住范围生成本地二级标题参考。请用「选定」覆盖写入。）"
                    : "（中转未给出可用多份稿，已按你描述的结构生成本地提纲参考。）";
              }
            }
            editMd = "";
          } else if (wantDraft && editMd) {
            variants = [
              { id: "1", note: "结论稿", md: editMd }
            ];
            editMd = "";
          } else if (wantDraft && !editMd) {
            var sk1 = extractHeadingSkeletonFromReply(reply);
            if (sk1) {
              variants = [{ id: "1", note: "从回复提取", md: sk1 }];
              reply =
                "（已从回复提取可落稿标题骨架。请用「选定」或「光标」写入。）";
            } else {
              var oneFb = synthWriteVariantsFallback(msg);
              if (oneFb.variants.length) {
                var oneShot = oneFb.variants[0];
                variants = [
                  {
                    id: "1",
                    note: oneShot.note || "结论稿",
                    md: oneShot.md
                  }
                ];
                reply =
                  oneFb.kind === "l2"
                    ? "（中转未返回结构化稿，已按钉住范围生成本地二级标题。请用「选定」写入。）"
                    : "（中转未返回正文，已生成本地提纲。请用卡片按钮写入。）";
              }
            }
          }
          var bubble = {
            role: "assistant",
            text: reply,
            editMd: "",
            variants: variants
          };
          if (wantVars && variants.length >= 2) {
            bubble.text =
              reply +
              (/\n/.test(reply) ? "\n\n" : "\n") +
              "（以下 " +
              variants.length +
              " 组参考，用卡片「选定 / 光标 / 整篇」写入；已有正文时优先选定或光标）";
            tip("已出 " + variants.length + " 组参考 · 卡片上直接落稿");
          } else if (wantVars && variants.length === 1) {
            tip("仅得 1 组 · 卡片上直接落稿");
          } else if (wantVars && !variants.length) {
            bubble.text =
              reply +
              "\n\n（未解析到可落稿参考。二级需能从钉住范围或话里的「包含/分管/要点」拆出并列子主题；可在输入框补一句子主题列表后重发。）";
            tip("未解析到多组参考");
          } else if (wantDraft && variants.length) {
            bubble.text =
              reply +
              (/\n/.test(reply) ? "\n\n" : "\n") +
              "（用卡片按钮写入；每次先存版本）";
            tip("结论已出 · 卡片上点小按钮写入");
          } else {
            tip("完成");
          }
          state.chat.push(bubble);
          renderOpts();
          syncTabUi();
        })
        .catch(function (e) {
          var err =
            (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
            e.message ||
            "失败";
          /* 中转挂了：有第一点/第二点结构时本地兜底出多份，不白失败 */
          var localFb =
            allow && (wantVars || wantDraft)
              ? synthWriteVariantsFallback(msg)
              : { variants: [], kind: "" };
          if (localFb.variants.length >= 2) {
            var bubbleFail = {
              role: "assistant",
              text:
                "（中转暂时连不上：" +
                err +
                "）\n\n" +
                (localFb.kind === "l2"
                  ? "已按你指定的标题范围生成本地下一级标题多组参考。请划选对应块后用「选定」或「光标」写入。"
                  : "已按你描述的结构生成本地提纲参考。请用卡片按钮写入。"),
              editMd: "",
              variants: wantVars ? localFb.variants : [localFb.variants[0]]
            };
            tip(
              wantVars
                ? "中转不可用 · 已生成本地 " + localFb.variants.length + " 组参考"
                : "中转不可用 · 已生成本地正文稿"
            );
            state.chat.push(bubbleFail);
            renderOpts();
            syncTabUi();
          } else {
            tip(err);
            state.chat.push({
              role: "assistant",
              text: "失败：" + err
            });
            renderOpts();
          }
        })
        .then(function () {
          setBusy(false);
        });
    }).catch(function () {});
  }

  function sendSuite() {
    if (!workText().replace(/\s/g, "")) {
      commitLiveToWork({ alert: true });
    }
    if (!workText().replace(/\s/g, "")) {
      tip("精修须先钉住");
      alert("请先在正文划选，再点「钉住」");
      return;
    }
    var req = ($("aiReq").value || "").trim() || "优化表述，更准确凝练";
    var mats = citedMaterials();
    withLogin(function () {
      setBusy(true);
      tip("同步素材并出方案…");
      var prep =
        window.GwChatLoop && GwChatLoop.prepareSuggestMaterials
          ? GwChatLoop.prepareSuggestMaterials(req, mats)
          : Promise.resolve(mats);
      return prep
        .then(function (readyMats) {
          hideReadBar();
          var ws =
            window.GwMaterialIndex && GwMaterialIndex.workspaceForAi
              ? GwMaterialIndex.workspaceForAi()
              : null;
          tip("出方案中…");
          return GwRelay.suggest(workText(), req, capability(), readyMats, {
            workspace: ws,
            read_set: (readyMats || []).map(function (m) {
              return m.path;
            })
          });
        })
        .then(function (data) {
          state.suiteBaseline = workText();
          state.previewId = null;
          state.adoptedId = null;
          if (state.work) {
            try {
              GwDoc.selectRange(state.work.start, state.work.end);
              var pinInfo = GwDoc.getSelectionInfo();
              if (pinInfo) {
                state.work.endsWithPara =
                  !!pinInfo.endsWithPara || /\n$/.test(pinInfo.text || "");
              }
            } catch (ePin) {}
          }
          state.options = normalizeOptions((data && data.options) || []);
          syncTabUi();
          tip("已出 " + state.options.length + " 案 · 可预览 / 采用");
        })
        .catch(function (e) {
          var em =
            (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
            e.message ||
            "失败";
          tip(em);
          alert(em);
        })
        .then(function () {
          setBusy(false);
        });
    }).catch(function () {});
  }

  function runProof() {
    var scope =
      (document.querySelector('input[name="proofScope"]:checked') || {})
        .value || "full";
    var text = "";
    try {
      if (scope === "selection") {
        if (!workText().replace(/\s/g, "")) {
          commitLiveToWork({ alert: true });
        }
        text = workText() || liveText() || GwDoc.getSelectionText();
      } else {
        text = GwDoc.getDocumentText();
      }
    } catch (e) {
      alert(e.message);
      return;
    }
    if (!String(text).replace(/\s/g, "")) {
      alert(scope === "selection" ? "请先划选并钉住" : "文档为空");
      return;
    }
    withLogin(function () {
      setBusy(true);
      tip("校对中…");
      $("proofClear").disabled = false;
      return GwRelay.proofread(text)
        .then(function (data) {
          state.proof =
            (data && (data.results || (data.data && data.data.results))) || [];
          renderOpts();
          tip("发现 " + state.proof.length + " 处");
        })
        .catch(function (e) {
          var msg =
            (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
            e.message ||
            "失败";
          tip(msg);
          alert(msg);
        })
        .then(function () {
          setBusy(false);
        });
    }).catch(function () {});
  }

  function switchTab(tab) {
    state.tab = tab;
    if (tab === "proof") {
      state.proof = [];
    }
    syncTabUi();
  }

  window.onload = function () {
    ensureBase();
    if (window.GwAccount) GwAccount.init();
    syncTabUi();
    startLiveWatch();

    $("aiTabWrite").onclick = function () {
      switchTab("write");
    };
    $("aiTabSuite").onclick = function () {
      switchTab("suite");
    };
    $("aiTabProof").onclick = function () {
      switchTab("proof");
    };

    $("aiSelCommit").onclick = function () {
      commitLiveToWork({ alert: true });
    };
    $("aiSelClear").onclick = function (ev) {
      clearWork(ev);
    };
    /* 点文字条：有钉住内容则展开/收起全文 */
    $("aiSel").onclick = function () {
      if (workText().replace(/\s/g, "")) toggleSelPop();
    };

    $("aiSelPopClose").onclick = function (ev) {
      ev.stopPropagation();
      setSelPop(false);
    };
    $("aiSelPopCopy").onclick = function (ev) {
      ev.stopPropagation();
      var t = workText();
      if (!t) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(
          function () {
            tip("已复制工作选区");
          },
          function () {
            tip("复制失败");
          }
        );
      } else {
        tip("当前环境不支持复制");
      }
    };
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.selPopOpen) setSelPop(false);
    });
    window.addEventListener("unload", stopLiveWatch);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) readLiveFromDoc();
    });

    var expandEl = $("aiExpandSib");
    if (expandEl) {
      expandEl.onchange = function () {
        if (!expandEl.checked) return;
        /* 勾选立即尝试扩选；失败只提示，不锁死换选 */
        try {
          var r = GwDoc.selectSiblingHeadings();
          state.live = {
            text: r.text,
            start: r.start,
            end: r.end,
            heading: r.heading || null
          };
          setWorkFromSnapshot(state.live, {
            items: r.items,
            count: r.count
          });
        } catch (e) {
          tip(e.message || "请先把光标放在标题上，再勾选或点钉住");
        }
      };
    }

    Array.prototype.forEach.call(
      document.querySelectorAll("#aiWriteLevels [data-write-level]"),
      function (btn) {
        btn.onclick = function () {
          btn.classList.toggle("on");
          syncWriteLevelPrompt();
          syncTabUi();
        };
      }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-suite-preset]"),
      function (btn) {
        btn.onclick = function () {
          Array.prototype.forEach.call(
            document.querySelectorAll("#aiSuitePresets button"),
            function (b) {
              b.classList.remove("on");
            }
          );
          btn.classList.add("on");
          $("aiReq").value = btn.getAttribute("data-suite-preset") || "";
        };
      }
    );

    $("aiSend").onclick = function () {
      if (state.tab === "suite") sendSuite();
      else sendWrite();
    };
    var wantDraft = $("aiWantDraft");
    if (wantDraft) {
      wantDraft.onchange = function () {
        syncWantDraftPair();
        syncTabUi();
      };
    }
    var wantVars = $("aiWantVariants");
    if (wantVars) {
      wantVars.onchange = function () {
        /* 允许单独取消给多份；若仍勾出结论则保持出结论 */
        syncTabUi();
      };
    }
    syncWantDraftPair();
    var restoreBtn = $("aiRestore");
    if (restoreBtn) {
      restoreBtn.onclick = function () {
        restoreSuiteBaseline();
      };
    }
    $("aiClearChat").onclick = function () {
      /* 铁律：清空对话绝不碰 ActiveDocument */
      state.chat = [];
      state.options = [];
      state.previewId = null;
      state.adoptedId = null;
      state.suiteBaseline = "";
      syncRestoreBtn();
      renderOpts();
      syncTabUi();
      tip("已清空对话 · 正文未改动");
    };
    $("proofRun").onclick = runProof;
    $("proofClear").onclick = function () {
      state.proof = [];
      $("proofClear").disabled = true;
      renderOpts();
    };
    var citeBar = $("aiCiteBar");
    if (citeBar) {
      citeBar.addEventListener("click", function (e) {
        var x = e.target.closest("[data-cite-x]");
        if (!x || !window.GwProject) return;
        e.preventDefault();
        GwProject.removeCite(x.getAttribute("data-cite-x"));
        renderCiteBar();
      });
    }
    renderCiteBar();
    setInterval(renderCiteBar, 600);
  };
})();
