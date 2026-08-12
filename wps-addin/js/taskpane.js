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
    suiteBaseline: "",
    /** 撰写正文稿：{ md, summary, staged }；落稿由用户点按钮 */
    chatPending: null
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
      if (state.tab === "write") syncDraftPanel();
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

  /** 撰写正文稿：独立面板展示；写入前必须存版本 */
  function resetChatPending() {
    state.chatPending = null;
    syncDraftPanel();
  }

  function draftMd() {
    return (state.chatPending && state.chatPending.md) || "";
  }

  function syncDraftPanel() {
    var panel = $("aiDraftPanel");
    var body = $("aiDraftBody");
    if (!panel || !body) return;
    var md = draftMd();
    var show = state.tab === "write" && !!String(md).replace(/\s/g, "");
    panel.hidden = !show;
    body.textContent = show ? md : "";
    var selBtn = $("aiDraftSel");
    if (selBtn) {
      var hasSel = false;
      try {
        var info = GwDoc.getSelectionInfo();
        hasSel = !!(info && String(info.text || "").replace(/\s/g, ""));
      } catch (e) {}
      selBtn.disabled = !hasSel;
      selBtn.title = hasSel
        ? "先存版本，再覆盖当前划选"
        : "请先在正文划选要覆盖的区域";
    }
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
  function withVersionThenWrite(label, writeFn) {
    if (state.busy) return;
    var md = draftMd();
    if (!String(md).replace(/\s/g, "")) {
      tip("没有正文稿可写入");
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
    syncDraftPanel();
  }

  function applyDraftFull() {
    if (
      !confirm(
        "将先自动存一个版本，再按层级排版覆盖【当前全文】。\n\n确定继续？"
      )
    ) {
      return;
    }
    withVersionThenWrite("整篇排版写入", function (md) {
      GwDoc.writeDocumentStyled(md);
    });
  }

  function applyDraftCursor() {
    withVersionThenWrite("写入光标处", function (md) {
      GwDoc.insertAtCursor(md);
    });
  }

  function applyDraftSelection() {
    var info = null;
    try {
      info = GwDoc.getSelectionInfo();
    } catch (e) {}
    if (!info || !String(info.text || "").replace(/\s/g, "")) {
      tip("请先在正文划选要覆盖的区域");
      alert("请先在正文用鼠标划选要覆盖的内容，再点「覆盖选定区」。");
      return;
    }
    withVersionThenWrite("覆盖选定区", function (md) {
      GwDoc.replaceSelection(md, {
        endsWithPara: !!info.endsWithPara
      });
    });
  }

  function copyDocDraft() {
    var md = draftMd();
    if (!String(md).replace(/\s/g, "")) {
      tip("没有可复制的正文稿");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(
        function () {
          tip("已复制正文稿");
        },
        function () {
          tip("复制失败");
        }
      );
    } else {
      tip("当前环境不支持复制");
    }
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

  function stageDocDraft(md, summary) {
    state.chatPending = {
      md: String(md || ""),
      summary: String(summary || "").slice(0, 80),
      staged: true,
      scope: "doc-draft"
    };
    syncDraftPanel();
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
    $("aiWriteTips").hidden = tab !== "write";
    $("aiSuitePresets").hidden = tab !== "suite";
    var expandWrap = $("aiExpandSibWrap");
    if (expandWrap) expandWrap.hidden = tab !== "suite";
    /* 撰写不钉选区；精修/校对才显示选区条 */
    var selBlock = $("aiSelBlock");
    if (selBlock) selBlock.hidden = tab === "write";
    $("aiSuiteHint").hidden = tab !== "suite";
    $("aiClearChat").hidden = tab === "proof" || tab === "suite";
    var ha = $("aiHeadActions");
    if (ha) ha.hidden = false;
    $("aiReq").placeholder =
      tab === "suite"
        ? "写精修要求，或点上方充填 / 润色…"
        : "多聊聊构思，或点上方立意 / 搭架…";
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
          : state.chatPending && state.chatPending.staged
            ? "有正文稿"
            : "撰写";
    }
    if (tab === "suite" && state.options.length) {
      tip(
        state.previewId
          ? "预览中 · 可还原或采用"
          : state.adoptedId
            ? "已采用 · 可还原"
            : "精修会改写选定 · 可预览 / 采用"
      );
    } else if (tab === "write" && state.chatPending && state.chatPending.staged) {
      tip("下方「正文稿」点按钮写入；每次写入前自动存版本");
    } else {
      tip(
        tab === "suite"
          ? "划选后点「钉住」；可反复换钉"
          : tab === "proof"
            ? "选范围后点开始校对"
            : "多聊构思；有正文稿时点下方按钮写入（每次先存版本）"
      );
    }
    syncRestoreBtn();
    renderWorkChip();
    renderOpts();
    syncDraftPanel();
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
        '<div class="ai-empty">撰写：对话聊构思；正文稿单独显示。点「整篇排版写入 / 写入光标处 / 覆盖选定区」才落稿，每次写入前自动存版本。清空对话不改正文。</div>';
      return;
    }
    var log = document.createElement("div");
    log.className = "ai-chat-log";
    state.chat.forEach(function (m) {
      var b = document.createElement("div");
      b.className = "ai-bubble " + (m.role === "user" ? "user" : "assistant");
      b.textContent = m.text;
      log.appendChild(b);
    });
    box.appendChild(log);
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
    var msg = ($("aiReq").value || "").trim();
    if (!msg) {
      tip("请先输入内容");
      return;
    }
    /* 始终允许返回正文稿；是否写入由用户点按钮决定 */
    var allow = true;
    var ctx = docContextMd();
    var mats = citedMaterials();
    var sendMsg =
      msg +
      "\n\n【宿主约束】你在「撰写」模式。" +
      "纯讨论时：reply 说明即可，edit 为 null。" +
      "若用户要框架/初稿/可落稿正文：最终须为 JSON，edit.md=正文稿（换行分段；用「一、」「（一）」标层级），reply 一两句说明。" +
      "宿主把 edit.md 放进「正文稿」区，由用户点按钮写入；禁止声称已写入文档。";
    withLogin(function () {
      state.chat.push({ role: "user", text: msg });
      $("aiReq").value = "";
      renderOpts();
      setBusy(true);
      tip("撰写中…");
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
                else if (/作答|思考/.test(t)) tip("撰写中…");
                else if (t) tip("撰写中…");
              }
            })
          : GwRelay.chat(sendMsg, ctx, capability(), allow, mats).then(
              function (data) {
                return {
                  reply: (data && data.reply) || "(空回复)",
                  edit: data && data.edit
                };
              }
            );
      return runner
        .then(function (data) {
          var reply = (data && data.reply) || "(空回复)";
          var editMd = normalizeEditMd(data && data.edit);
          if (!editMd && window.GwMaterialTools) {
            var parsed = GwMaterialTools.parseAgentPayload(reply, data);
            if (parsed && parsed.edit) {
              editMd = normalizeEditMd(parsed.edit);
              if (parsed.reply) reply = parsed.reply;
            }
          }
          var bubble = {
            role: "assistant",
            text: reply,
            editMd: ""
          };
          if (editMd) {
            stageDocDraft(editMd, reply);
            bubble.editMd = editMd;
            bubble.text =
              reply +
              (/\n/.test(reply) ? "\n\n" : "\n") +
              "（正文稿已就绪：点下方按钮写入；每次写入前自动存版本）";
            tip("正文稿已就绪 · 点下方按钮写入");
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
          tip(err);
          state.chat.push({
            role: "assistant",
            text: "失败：" + err
          });
          renderOpts();
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
      document.querySelectorAll("[data-write-tip]"),
      function (btn) {
        btn.onclick = function () {
          var tipText = btn.getAttribute("data-write-tip") || "";
          var req = $("aiReq");
          if (!req) return;
          /* 切换引导：先清空原提示，再写入当前项（不拼接） */
          req.value = "";
          req.value = tipText;
          Array.prototype.forEach.call(
            document.querySelectorAll("#aiWriteTips [data-write-tip]"),
            function (b) {
              b.classList.toggle("on", b === btn);
            }
          );
          try {
            req.focus();
          } catch (eFocus) {}
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
    var draftFull = $("aiDraftFull");
    if (draftFull) draftFull.onclick = applyDraftFull;
    var draftCursor = $("aiDraftCursor");
    if (draftCursor) draftCursor.onclick = applyDraftCursor;
    var draftSel = $("aiDraftSel");
    if (draftSel) draftSel.onclick = applyDraftSelection;
    var draftCopy = $("aiDraftCopy");
    if (draftCopy) draftCopy.onclick = copyDocDraft;
    var restoreBtn = $("aiRestore");
    if (restoreBtn) {
      restoreBtn.onclick = function () {
        restoreSuiteBaseline();
      };
    }
    $("aiClearChat").onclick = function () {
      /* 铁律：清空对话绝不碰 ActiveDocument */
      resetChatPending();
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
