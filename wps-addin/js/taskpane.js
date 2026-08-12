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
    /** 本会话已精读路径（跨次发送保留，对齐规格 read_set） */
    readSet: [],
    /** 风格参照指纹缓存 */
    styleFp: null,
    styleRefText: "",
    /** 撰写续改底稿：对话卡 mi:vi；空则回落最近一张结论卡 */
    baseDraft: null,
    /** Context Kernel · Task Card */
    taskCard: null,
    /** 待澄清：{ options, asks } */
    pendingClarify: null,
    /** 本轮理解 · 状态条展示 */
    lastUnderstand: null
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

  function statusIntentLabel(intent) {
    return (
      {
        lead: "冒段",
        outline: "标题",
        revise_outline: "改架构",
        body: "正文",
        chat: "聊天",
        ambiguous: "待确认",
        suite: "精修"
      }[intent] || "撰写"
    );
  }

  /** 本轮对齐/写前对齐 → 下方状态条（联合聪明程度，不刷长思考） */
  function paintUnderstandBar(classified, assembled, align) {
    classified = classified || {};
    assembled = assembled || {};
    var intent = classified.intent || "";
    var short;
    var line;
    if (align && align.tipLine) {
      short = align.short || statusIntentLabel(intent);
      line = align.tipLine;
      state.lastUnderstand = {
        short: short,
        line: line,
        intent: intent,
        align: align.trace || null
      };
    } else {
      var layers = (assembled.trace && assembled.trace.layers) || [];
      var layerHint = "本轮话";
      if (
        layers.indexOf("L1") >= 0 &&
        (layers.indexOf("L3") >= 0 || layers.indexOf("L3toc") >= 0)
      )
        layerHint = "任务+底稿";
      else if (layers.indexOf("L1") >= 0) layerHint = "任务框架";
      else if (layers.indexOf("L3toc") >= 0) layerHint = "目录对照";
      else if (layers.indexOf("L3") >= 0) layerHint = "当前底稿";
      else if (layers.indexOf("pin") >= 0) layerHint = "钉住范围";
      short = statusIntentLabel(intent);
      var detail = "";
      if (classified.focusLine) {
        detail = String(classified.focusLine)
          .replace(/【本轮焦点说明】\s*/g, "")
          .replace(/intent=\w+：?/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 56);
      }
      line = detail
        ? "理解：" + short + " · " + detail
        : "理解：" + short + " · 用" + layerHint;
      state.lastUnderstand = { short: short, line: line, intent: intent };
    }
    var st = $("aiEditStatus");
    if (st) st.textContent = short;
    tip(line);
    logInfo("ctx.understand", state.lastUnderstand);
    if (align && align.trace) logInfo("quality.align", align.trace);
  }

  function tipProgress(progress) {
    var base =
      (state.lastUnderstand && state.lastUnderstand.line) ||
      (state.busy ? "发送中" : "");
    tip(base ? base + " · " + progress : progress);
  }

  function escTip(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildAlignCardForSend(classified, assembled, mats, allow, displayMsg) {
    if (!window.GwQualityKernel) return null;
    var fp = state.styleFp && !state.styleFp.error ? state.styleFp : null;
    return GwQualityKernel.buildAlignCard({
      intent: (classified && classified.intent) || "",
      layers: (assembled && assembled.trace && assembled.trace.layers) || [],
      readSet: state.readSet || [],
      materials: mats || [],
      allowEdit: !!allow,
      hasTaskCard: window.GwContextKernel
        ? GwContextKernel.cardHasContent(state.taskCard)
        : false,
      hasBaseDraft: !!String(resolveBaseDraftMd() || "").replace(/\s/g, ""),
      hasStyleRef: !!fp,
      styleFingerprint: fp,
      message: displayMsg || ""
    });
  }

  function evidenceTextBundle() {
    var parts = [];
    try {
      (citedMaterials() || []).forEach(function (m) {
        if (m && (m.text || m.content)) parts.push(String(m.text || m.content));
      });
    } catch (e1) {}
    try {
      if (window.GwProject && GwProject.readTextRel) {
        (state.readSet || []).forEach(function (p) {
          var rd = GwProject.readTextRel(p);
          if (rd && rd.ok && rd.text) parts.push(String(rd.text));
        });
      }
    } catch (e2) {}
    return parts.join("\n").slice(0, 24000);
  }

  function runDraftGate(md, classified) {
    if (!window.GwQualityKernel) return null;
    var chk = GwQualityKernel.draftCriticHost(md, {
      readN: (state.readSet && state.readSet.length) || 0,
      matN: (citedMaterials() || []).length,
      refText: state.styleRefText || "",
      evidenceText: evidenceTextBundle(),
      intent: (classified && classified.intent) || "",
      levels: selectedWriteLevels(),
      hasStyleRef: !!(state.styleFp && !state.styleFp.error),
      hasTaskCard: window.GwContextKernel
        ? GwContextKernel.cardHasContent(state.taskCard)
        : false
    });
    if (chk.tip) tip(chk.tip);
    logInfo("quality.gate", {
      pass: chk.pass,
      n: (chk.issues && chk.issues.length) || 0,
      issues: chk.issues
    });
    renderQualityBar(chk);
    return chk;
  }

  function renderQualityBar(chk) {
    var bar = $("aiQualityBar");
    if (!bar) return;
    if (!chk) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    var items = (chk.checklist || [])
      .map(function (c) {
        return (
          '<span class="ai-q-item' +
          (c.ok ? " ok" : " bad") +
          '" title="' +
          escTip(c.label || "") +
          '">' +
          (c.ok ? "✓" : "!") +
          " " +
          escTip(String(c.label || "").slice(0, 18)) +
          "</span>"
        );
      })
      .join("");
    bar.hidden = false;
    bar.innerHTML =
      '<div class="ai-q-head">' +
      (chk.pass ? "交稿闸 · 通过" : "交稿闸 · 待处理") +
      "</div>" +
      '<div class="ai-q-list">' +
      items +
      "</div>" +
      (chk.issues && chk.issues.length
        ? '<div class="ai-q-msg">' +
          escTip(chk.issues.slice(0, 3).join("；")) +
          "</div>"
        : "");
  }

  function runModelCritic(md, classified) {
    if (!window.GwQualityKernel || !window.GwRelay) {
      return Promise.resolve(null);
    }
    var prompt = GwQualityKernel.buildModelCriticPrompt(md, {
      intent: (classified && classified.intent) || "",
      levels: selectedWriteLevels(),
      hasStyleRef: !!(state.styleFp && !state.styleFp.error)
    });
    return GwRelay.chat(prompt, "", "strong", false, null, {
      force_final: true,
      session_summary: "交稿挑刺·勿写稿"
    }).then(function (data) {
      var raw =
        (data && data.reply) ||
        (data && data.edit && data.edit.md) ||
        "";
      if (data && data.type === "tool_calls") {
        return GwRelay.chat(
          prompt + "\n\n（禁止工具，请直接输出挑刺 JSON）",
          "",
          "strong",
          false,
          null,
          { force_final: true, session_summary: "交稿挑刺·勿写稿" }
        ).then(function (d2) {
          return GwQualityKernel.parseModelCritic((d2 && d2.reply) || "");
        });
      }
      return GwQualityKernel.parseModelCritic(raw);
    });
  }

  function refreshStyleFingerprint() {
    state.styleFp = null;
    state.styleRefText = "";
    if (!window.GwProject || !GwProject.getStyleRefRel) return null;
    var rel = GwProject.getStyleRefRel();
    if (!rel) return null;
    if (!window.GwQualityKernel) {
      state.styleFp = {
        path: rel,
        title: GwProject.titleOf(GwProject.baseName(rel))
      };
      return state.styleFp;
    }
    var rd = GwProject.readTextRel(rel);
    var title = GwProject.titleOf(GwProject.baseName(rel));
    if (!rd || !rd.ok) {
      state.styleFp = { path: rel, title: title, error: (rd && rd.error) || "读失败" };
      tip("参照稿无法读取：" + ((rd && rd.error) || rel));
      return state.styleFp;
    }
    state.styleRefText = String(rd.text || "").slice(0, 14000);
    state.styleFp = GwQualityKernel.extractStyleFingerprint(state.styleRefText, {
      path: rel,
      title: title
    });
    logInfo("quality.style_ref", {
      path: rel,
      chars: state.styleFp.charCount,
      headings: (state.styleFp.headings && state.styleFp.headings.length) || 0
    });
    return state.styleFp;
  }

  function renderStyleBar() {
    var bar = $("aiStyleBar");
    if (!bar || !window.GwProject || !GwProject.getStyleRefRel) return;
    var rel = GwProject.getStyleRefRel();
    if (!rel) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    var name = citeShortName(rel);
    bar.hidden = false;
    bar.innerHTML =
      '<span class="ai-style-chip" title="学口气与结构，不整篇抄袭">' +
      '<span class="ai-style-tag">参照</span><span>' +
      name +
      '</span><button type="button" class="ai-style-x" data-style-x="1" title="取消参照">×</button></span>';
  }

  function logInfo(tag, d) {
    try {
      if (window.GwLog) GwLog.info(tag, d);
    } catch (e) {}
  }
  function logWarn(tag, d) {
    try {
      if (window.GwLog) GwLog.warn(tag, d);
    } catch (e) {}
  }

  var CHAT_STORE_KEY = "chat_snapshot_v1";

  function slimChatForStore(list) {
    return (list || []).slice(-50).map(function (m) {
      var o = {
        role: m.role,
        text: String(m.text || "").slice(0, 12000)
      };
      if (m.editMd) o.editMd = String(m.editMd).slice(0, 8000);
      if (m.variants && m.variants.length) {
        o.variants = m.variants.slice(0, 5).map(function (v) {
          return {
            id: v.id,
            note: v.note,
            md: String(v.md || "").slice(0, 12000)
          };
        });
      }
      return o;
    });
  }

  function persistChat(reason) {
    if (!window.GwUserPrefs) return;
    try {
      var payload = {
        v: 1,
        savedAt: Date.now(),
        reason: reason || "",
        tab: state.tab,
        chat: slimChatForStore(state.chat),
        baseDraft: state.baseDraft || null,
        taskCard: state.taskCard || null,
        _clarifyAskedOnce: !!state._clarifyAskedOnce
      };
      GwUserPrefs.set(CHAT_STORE_KEY, JSON.stringify(payload));
      logInfo("chat.persist", {
        reason: reason || "",
        n: state.chat.length,
        bytes: String(GwUserPrefs.get(CHAT_STORE_KEY) || "").length
      });
    } catch (e) {
      logWarn("chat.persist.fail", String(e && e.message ? e.message : e));
    }
  }

  function restoreChat() {
    if (!window.GwUserPrefs) return false;
    try {
      var raw = GwUserPrefs.get(CHAT_STORE_KEY);
      if (!raw) {
        logInfo("chat.restore.skip", "empty");
        return false;
      }
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.chat) || !data.chat.length) {
        logInfo("chat.restore.skip", "no_messages");
        return false;
      }
      state.chat = data.chat;
      if (
        data.baseDraft &&
        isFinite(data.baseDraft.mi) &&
        isFinite(data.baseDraft.vi)
      ) {
        state.baseDraft = {
          mi: data.baseDraft.mi | 0,
          vi: data.baseDraft.vi | 0
        };
      }
      if (window.GwContextKernel) {
        state.taskCard = GwContextKernel.ensureCard(data.taskCard || null);
      } else {
        state.taskCard = data.taskCard || null;
      }
      /* 不恢复 pendingClarify，避免刷新后发送被静默拦住 */
      state.pendingClarify = null;
      state._clarifyAskedOnce = !!data._clarifyAskedOnce;
      logInfo("chat.restore.ok", {
        n: state.chat.length,
        savedAt: data.savedAt,
        reason: data.reason || "",
        base: state.baseDraft,
        hasCard: !!(state.taskCard && state.taskCard.rawPins)
      });
      return true;
    } catch (e) {
      logWarn("chat.restore.fail", String(e && e.message ? e.message : e));
      return false;
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

  /** 当前稿全文（有上限）；与钉住分工，不再把全文+引用糊进同一 context */
  function currentDocMd() {
    try {
      return String(GwDoc.getDocumentText() || "").slice(0, 12000);
    } catch (e) {
      return "";
    }
  }

  /** 本轮焦点：钉住优先，否则空（全文走 doc_md） */
  function focusContextMd() {
    var pin = workText();
    if (pin.replace(/\s/g, "")) return pin.slice(0, 6000);
    return "";
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
    parts.push(
      "Markdown 井号必须与点选层级严格一致：落稿按 # 个数套字体，井号多写/少写都会错。"
    );
    parts.push("只输出点选的层级，未点选的层级禁止出现。");
    if (hasH1) {
      parts.push(
        "文题：options[].md / edit.md 开头必须有一行「# …」材料/本稿大标题（一个井号，宋体居中题名）。" +
          "大标题优先取自钉住范围、当前文首、通知或引用素材中的正式题名；没有则据任务拟一个像公文的题名，禁止用「提纲」「参考」这类空题。"
      );
      parts.push(
        "一级：必须写成「## 一、…」「## 二、…」（两个井号）。" +
          "禁止把一级写成单个 # 或 ###；措辞优先对仗（前半、后半都要有区分度）。" +
          "有文题 # 后再写 ##，不要只有 ## 没有大标题。"
      );
    }
    if (hasH2) {
      parts.push(
        "二级：必须写成「### （一）…」「### （二）…」（三个井号）。" +
          "禁止写成单个 # 或 ##；" +
          "子主题必须服从【会话既定要求】与钉住一级的题意：" +
          "用户已说的「第N点/大致思路」里的主干意图优先；其后「包含/比如…」只作举例，不得压过主干、另起炉灶；" +
          "禁止抛开用户已定结构，仅凭素材目录另编无关条目（除非用户或钉住范围明确要求）；" +
          "条数紧贴该一级下应有的子题，宜 2～5 条，勿凑满无关条目；" +
          "多组参考子主题集合一致，仅变换对仗措辞。"
      );
      if (!hasH1) {
        parts.push(
          "本轮未点选一级：options[].md / edit.md 禁止出现任何「## 一、…」一级行，" +
            "也禁止重复钉住范围内已有的一级标题原文；只输出 ### 二级行。" +
            "钉住一级只表示研究范围，不是要你再输出那一行一级标题。"
        );
      }
    }
    if (hasH3) {
      parts.push(
        "三级：必须写成「#### …」（四个井号）。禁止用 # / ## / ### 冒充三级。"
      );
      if (!hasH1 && !hasH2) {
        parts.push(
          "本轮未点选一/二级：禁止输出 ## 或 ### 行；钉住上级只表示范围。"
        );
      }
    }
    if (hasBody) parts.push("正文：标题下的事实与表述段落；无依据标【待核实】。");
    if (!hasBody && (hasH1 || hasH2 || hasH3)) {
      parts.push("本次只要标题骨架，少写长段正文。");
    }
    if (!hasH1 && !hasH2 && !hasH3 && hasBody) {
      parts.push("本次只要正文段落，不要新增标题行。");
    }
    parts.push(
      "用户说「喜欢 xxxxxxxx,xxxxxxxx 句式」只约束措辞，不改变点选层级，未点选层仍禁止输出。"
    );
    if (!hasH1) {
      parts.push(
        "本轮未点选一级：章节标题不要用单个 #（单个 # 仅全文大标题，且仅在点选一级时输出）。"
      );
    } else {
      parts.push(
        "单个 # 仅用于文首大标题一行；一级章节一律用 ##，禁止再用单个 # 冒充「一、二、三」。"
      );
    }
    return parts.join("");
  }

  function pinnedScopeHint() {
    var t = workText();
    if (!t.replace(/\s/g, "")) return "";
    var levels = selectedWriteLevels();
    var childOnly =
      levels.length &&
      levels.indexOf("h1") < 0 &&
      (levels.indexOf("h2") >= 0 || levels.indexOf("h3") >= 0);
    var head =
      "用户已钉住研究范围，产出须紧贴该范围（可含其下应出现的子级），勿改动范围外其它同级块。";
    if (childOnly) {
      head +=
        "钉住内容是上级标题/范围，请在其下展开点选层级；不要把钉住的上级标题再写入 md。";
    }
    return head + "\n【钉住范围】\n" + t.slice(0, 6000);
  }

  /** 上次若把形态话术灌进输入框，点选变更时清掉，改由发送时静默携带 */
  var lastAutoLevelPrompt = "";

  /** 形态话术不进对话框，发送时静默附上，避免模型不知要啥样 */
  function levelShapeCarry(levels) {
    if (!levels || !levels.length) return "";
    var shape = composeWriteLevelPrompt(levels);
    if (!shape) return "";
    return "\n【产出形态】" + shape + "\n";
  }

  function syncWriteLevelPrompt() {
    var req = $("aiReq");
    if (!req) return;
    var levels = selectedWriteLevels();
    var cur = String(req.value || "");
    /* 清掉旧版自动灌入的形态话术，输入框留给用户在对话里直接说 */
    if (
      cur &&
      (cur === lastAutoLevelPrompt ||
        cur === composeWriteLevelPrompt(levels))
    ) {
      req.value = "";
      lastAutoLevelPrompt = "";
    } else if (lastAutoLevelPrompt && cur === lastAutoLevelPrompt) {
      req.value = "";
      lastAutoLevelPrompt = "";
    }
  }

  /**
   * 按多选层级拼一条不冲突的默认话术（单一任务说明，不互相否定）。
   * 不进输入框；发送时由 levelShapeCarry 静默附上。
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
        "请只给出二级标题，每行必须是「### （一）…」「### （二）…」（三个井号）。" +
        (pinned
          ? "已钉住一级范围：不要再输出「## 一、…」或重复钉住的一级标题；只在其下写 ###。"
          : scope) +
        "必须紧扣会话里用户已定的结构要点与该一级题意；" +
        "「包含/比如…」是举例，不得压过主干；" +
        "子主题从钉住范围与用户要点并列项拆出，一条对应一个具体对象；" +
        "不要抛开用户要求去堆素材里的其它条目；" +
        (withBody
          ? "可在各二级下附简短正文要点；"
          : "只要二级标题骨架，少写长段；") +
        "禁止单个 #，禁止 ##。对仗句式优先。"
      );
    }
    if (titles.length === 1 && titles[0] === "三级标题" && !has("h2") && !has("h1")) {
      return (
        "请只给出三级标题，每行必须是「#### …」（四个井号）。" +
        (pinned
          ? "已钉住上级范围：不要输出上级 ## / ### 行，只写 ####。"
          : scope) +
        (withBody ? "可附简短正文要点；" : "只要三级标题骨架，少写长段；") +
        "禁止用 # / ## / ### 冒充三级。"
      );
    }
    if (titles.length === 1 && titles[0] === "一级标题") {
      return (
        "请给出可落稿骨架：先写一行材料大标题「# …」（一个井号），再写一级「## 一、…」「## 二、…」（两个井号），措辞优先对仗。" +
        "大标题取自通知/素材/本稿题名，务求像正式公文文题。" +
        scope +
        (withBody
          ? "可在一级下附简短正文要点；"
          : "只要文题+一级标题骨架，不要二级/三级，少写长段；") +
        "禁止缺大标题；禁止用单个 # 写「一、二、三」；禁止 ### / ####。" +
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

  function ensureBase() {
    /* 现阶段固定本机中转，避免每次改完还要部署云机 */
    GwRelay.setBase("http://127.0.0.1:3000");
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

  function isHeadingLine(t) {
    var s = String(t || "").replace(/^\s+/, "").replace(/\s+$/, "");
    if (/^#{1,4}\s+\S/.test(s)) return true;
    if (/^（[一二三四五六七八九十\d]+）\S/.test(s)) return true;
    if (/^[一二三四五六七八九十]+、\S/.test(s) && s.length < 40) return true;
    return false;
  }

  function normalizeHeadingLine(t) {
    var s = String(t || "").replace(/^\s+/, "").replace(/\s+$/, "");
    if (/^#{1,4}\s+\S/.test(s)) return s;
    if (/^（[一二三四五六七八九十\d]+）\S/.test(s)) return "### " + s;
    if (/^[一二三四五六七八九十]+、\S/.test(s) && s.length < 40)
      return "## " + s;
    return s;
  }

  /**
   * 模型把多组标题写在 reply 散文里时：按标题块拆成多组（仍是模型原文，不本地编造）。
   * 块之间用短说明行或空行+新标题簇分隔。
   */
  function extractHeadingGroupsFromReply(reply) {
    var raw = stripHostChatMeta(reply || "");
    var labeled = splitVariantsFromMd(raw);
    if (labeled.length >= 2) return labeled;
    var lines = raw.split(/\r?\n/);
    var groups = [];
    var cur = [];
    function flush() {
      if (cur.length >= 2) {
        groups.push({
          id: String.fromCharCode(65 + groups.length),
          md: cur.join("\n\n"),
          note: "从回复提取"
        });
      }
      cur = [];
    }
    var i;
    for (i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s+/, "").replace(/\s+$/, "");
      if (!t) continue;
      if (isHeadingLine(t)) {
        cur.push(normalizeHeadingLine(t));
        continue;
      }
      if (cur.length) {
        /* 短说明行视为组间注，结束本组 */
        if (t.length <= 40 || /对仗|侧重|强调|突出|方案|参考/.test(t)) {
          flush();
        } else if (cur.length >= 2) {
          flush();
        }
      }
    }
    flush();
    if (groups.length >= 2) return groups;
    return [];
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
    if (!list.length) list = extractHeadingGroupsFromReply(reply || "");
    return (list || []).filter(function (o) {
      return o && String(o.md || "").replace(/\s/g, "").length >= 20;
    });
  }

  /** 从模型 reply 里捞标题行，合成可落稿 md（仍来自模型原文，非本地编造） */
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

  /** 卡片落稿：写入前必须存版本；md 来自对话卡（须为模型产出），无中转面板 */
  function resolveChatMd(src) {
    var parts = String(src || "").split(":");
    var mi = parseInt(parts[0], 10);
    var vi = parseInt(parts[1], 10);
    var msg = state.chat[mi];
    if (!msg || !msg.variants || !msg.variants[vi]) return "";
    return String(msg.variants[vi].md || "");
  }

  function parseCardSrc(src) {
    var parts = String(src || "").split(":");
    var mi = parseInt(parts[0], 10);
    var vi = parseInt(parts[1], 10);
    if (!isFinite(mi) || !isFinite(vi) || mi < 0 || vi < 0) return null;
    return { mi: mi, vi: vi };
  }

  function markBaseDraft(mi, vi, reason) {
    if (
      !state.chat[mi] ||
      !state.chat[mi].variants ||
      !state.chat[mi].variants[vi]
    ) {
      return;
    }
    state.baseDraft = { mi: mi, vi: vi };
    logInfo("draft.base", { mi: mi, vi: vi, reason: reason || "" });
  }

  /** 当前续改底稿 md：优先用户点过的卡，否则最近助手结论卡第一张 */
  function resolveBaseDraftMd() {
    var b = state.baseDraft;
    if (
      b &&
      state.chat[b.mi] &&
      state.chat[b.mi].variants &&
      state.chat[b.mi].variants[b.vi]
    ) {
      return String(state.chat[b.mi].variants[b.vi].md || "");
    }
    var i;
    for (i = state.chat.length - 1; i >= 0; i--) {
      var m = state.chat[i];
      if (m && m.role === "assistant" && m.variants && m.variants.length) {
        return String(m.variants[0].md || "");
      }
    }
    return "";
  }

  function isBaseDraftCard(mi, vi) {
    var b = state.baseDraft;
    if (b && b.mi === mi && b.vi === vi) return true;
    if (b) return false;
    var j;
    for (j = state.chat.length - 1; j >= 0; j--) {
      var m = state.chat[j];
      if (m && m.role === "assistant" && m.variants && m.variants.length) {
        return j === mi && vi === 0;
      }
    }
    return false;
  }

  /** @deprecated 由 Kernel.assembleWriteLayers 替代；保留兜底 */
  function baseDraftConstraint() {
    var md = resolveBaseDraftMd();
    if (!String(md || "").replace(/\s/g, "")) return "";
    return "\n【焦点·L3·当前结论底稿】\n" + String(md).slice(0, 10000) + "\n";
  }

  function handleCardApply(mode, src) {
    var loc = parseCardSrc(src);
    if (loc) markBaseDraft(loc.mi, loc.vi, "card_" + mode);
    var md = resolveChatMd(src);
    if (mode === "full") applyDraftFull(md);
    else if (mode === "cursor") applyDraftCursor(md);
    else if (mode === "sel") applyDraftSelection(md);
    else if (mode === "copy") copyDocDraft(md);
    else return;
    renderOpts();
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

  function writeChildLevelsOnly() {
    var levels = selectedWriteLevels();
    if (!levels.length) return false;
    if (levels.indexOf("h1") >= 0) return false;
    return levels.indexOf("h2") >= 0 || levels.indexOf("h3") >= 0;
  }

  function applyDraftSelection(md) {
    var childOnly = writeChildLevelsOnly();
    /* 撰写已钉住：对准钉住范围；稿面原样写入，不改模型井号 */
    if (
      state.tab === "write" &&
      state.work &&
      typeof state.work.start === "number" &&
      typeof state.work.end === "number"
    ) {
      try {
        GwDoc.selectRange(state.work.start, state.work.end);
      } catch (ePin) {}
      if (childOnly && GwDoc.writeUnderCurrentHeading) {
        /* 钉上级写下级：落在标题之下，避免盖掉已有上级行 */
        withVersionThenWrite(md, "写入标题下属", function (text) {
          try {
            GwDoc.writeUnderCurrentHeading(text);
          } catch (eW) {
            throw new Error(
              (eW && eW.message) || "请钉在上级标题上再写下级"
            );
          }
          if (state.tab === "write") {
            state.work = null;
            renderWorkChip();
          }
        });
        return;
      }
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
    if (typeof syncWriteLevelPrompt === "function") syncWriteLevelPrompt();
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
        : wantVariantsChecked() || wantDraftChecked()
          ? "在此说明要什么结构/侧重…（点选层级后发送）"
            : "纯聊天，或点选层级后勾选「出结论/多份」…";
    $("aiSend").textContent =
      state.busy
        ? state.tab === "suite"
          ? "出方案中"
          : "发送中"
        : tab === "suite"
          ? state.options.length
            ? "再出"
            : "出方案"
          : "发送";
    if ($("aiSend")) $("aiSend").disabled = false;
    var status = $("aiEditStatus");
    if (status) {
      if (state.busy && state.lastUnderstand && state.lastUnderstand.short) {
        status.textContent = state.lastUnderstand.short;
      } else {
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
                ? "多份"
                : wantDraftChecked()
                  ? "出结论"
                  : "纯聊天";
      }
    }
    if (state.busy && state.lastUnderstand && state.lastUnderstand.line) {
      tip(state.lastUnderstand.line + " · 撰写中…");
    } else if (tab === "suite" && state.options.length) {
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
              : "点选层级并勾选「出结论」或「多份」再要稿"
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
        '<div class="ai-empty">撰写：点选「一级/二级/三级/正文」→ 在下方直接说要求 → 发送。形态说明会静默带给模型；卡片上用选定或光标写入。</div>';
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
          card.className =
            "ai-variant" + (isBaseDraftCard(mi, vi) ? " is-base" : "");
          var head = document.createElement("div");
          head.className = "ai-variant-head";
          var title =
            (v.note && String(v.note)) || "参考 " + (v.id || vi + 1);
          if (isBaseDraftCard(mi, vi)) {
            head.innerHTML =
              "<span>" +
              escHtml(title) +
              '</span><span class="ai-base-mark">底稿</span>';
          } else {
            head.textContent = title;
          }
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
    state.busyAt = on ? Date.now() : 0;
    /* 不禁用发送按钮：禁用后像「点了没反应」；靠 busy 防重入即可 */
    var sendBtn = $("aiSend");
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = on
        ? state.tab === "suite"
          ? "出方案中"
          : "发送中"
        : state.tab === "suite"
          ? state.options && state.options.length
            ? "再出"
            : "出方案"
          : "发送";
    }
    var proofBtn = $("proofRun");
    if (proofBtn) proofBtn.disabled = !!on;
  }

  function releaseBusyIfStuck() {
    if (!state.busy) return false;
    var wait = state.busyAt ? Date.now() - state.busyAt : 0;
    if (wait > 45000) {
      setBusy(false);
      tip("上次请求超时，已解锁，请再发一次");
      logWarn("send.busy_timeout", { wait: wait });
      return true;
    }
    return false;
  }

  function doSend() {
    try {
      releaseBusyIfStuck();
      if (state.busy) {
        var wait = state.busyAt ? Date.now() - state.busyAt : 0;
        if (wait > 2500) {
          setBusy(false);
          tip("已强制解锁，正在重发…");
        } else {
          tip("仍在发送中，请稍候…");
          return;
        }
      }
      if (state._sendLockAt && Date.now() - state._sendLockAt < 600) {
        return;
      }
      state._sendLockAt = Date.now();
      if (state.tab === "proof") return;
      if (state.tab === "suite") sendSuite();
      else sendWrite();
    } catch (e) {
      setBusy(false);
      var msg = (e && e.message) || String(e);
      tip("发送异常：" + msg);
      logWarn("send.crash", msg);
    }
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

  /** 去掉宿主追加提示，避免历史里被模型学舌、误判已出稿 */
  function stripHostChatMeta(text) {
    return String(text || "")
      .replace(/\n*（以下\s*\d+\s*组参考[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（模型未给出[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（中转回了空壳[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（已拦截中转[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（用卡片按钮写入[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（已从回复提取[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（提示：本轮未成功精读[\s\S]*?）\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** 发给中转的近期对话（软修剪） */
  function chatHistoryForRelay() {
    if (window.GwContextKernel && GwContextKernel.pruneHistory) {
      return GwContextKernel.pruneHistory(state.chat || [], 10);
    }
    return (state.chat || [])
      .slice(-16)
      .map(function (m) {
        return {
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.text || "").slice(0, 2500)
        };
      })
      .filter(function (m) {
        return String(m.content || "").replace(/\s/g, "").length > 0;
      });
  }

  /** 兼容：无 Kernel 时仍捞关键词句 */
  function sessionFrameworkHint() {
    if (window.GwContextKernel && state.taskCard) {
      return GwContextKernel.renderTaskCard(state.taskCard);
    }
    var bits = [];
    var i;
    for (i = (state.chat || []).length - 1; i >= 0 && bits.length < 4; i--) {
      var m = state.chat[i];
      if (!m || m.role !== "user") continue;
      var t = String(m.text || "");
      if (
        /第[一二三四五六七八九十\d]+点|大致思路|框架|提纲|分管|负责|包含|比如|对仗|句式|字数|通知/.test(
          t
        )
      ) {
        bits.unshift(t.slice(0, 1800));
      }
    }
    if (!bits.length) return "";
    return (
      "\n【会话既定要求】以下是用户此前定下的结构/要点，本轮产出必须服从，不得抛开另编：\n" +
      bits.join("\n---\n") +
      "\n"
    );
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
    var displayMsg = msg;
    if (!displayMsg && allow) {
      displayMsg = "请按已点选的产出层级给出结论。";
    }

    if (!state.taskCard && window.GwContextKernel) {
      state.taskCard = GwContextKernel.emptyCard();
    }
    if (window.GwContextKernel) {
      state.taskCard = GwContextKernel.ingestUserMessage(
        state.taskCard,
        displayMsg
      );
    }

    var forcedIntent = null;
    if (state.pendingClarify && window.GwContextKernel) {
      var chosen = GwContextKernel.parseClarifyChoice(
        displayMsg,
        state.pendingClarify.options
      );
      if (chosen) {
        forcedIntent = chosen.intent;
        logInfo("ctx.clarify.ok", { intent: forcedIntent });
      } else {
        logInfo("ctx.clarify.cancel", { reason: "user_continue" });
      }
      state.pendingClarify = null;
    }

    var classified = {
      intent: "outline",
      confidence: 0.7,
      focusLine: "",
      soft: false
    };
    if (window.GwContextKernel) {
      classified = GwContextKernel.classify({
        message: displayMsg,
        levels: levels,
        allowEdit: allow,
        hasTaskCard: GwContextKernel.cardHasContent(state.taskCard),
        hasBaseDraft: !!String(resolveBaseDraftMd() || "").replace(/\s/g, ""),
        forcedIntent: forcedIntent
      });
    }

    if (
      classified.intent === "ambiguous" &&
      allow &&
      window.GwContextKernel &&
      !state._clarifyAskedOnce
    ) {
      var ask = GwContextKernel.clarifyPrompt(classified.clarifyOptions);
      state.pendingClarify = {
        options: classified.clarifyOptions,
        asks: 1
      };
      state._clarifyAskedOnce = true;
      state.chat.push({ role: "user", text: displayMsg });
      state.chat.push({ role: "assistant", text: ask });
      persistChat("clarify");
      logInfo("ctx.clarify", { options: classified.clarifyOptions });
      $("aiReq").value = "";
      renderOpts();
      state.lastUnderstand = {
        short: "待确认",
        line: "理解：待确认 · 请回复 A 或 B",
        intent: "ambiguous"
      };
      var stAsk = $("aiEditStatus");
      if (stAsk) stAsk.textContent = "待确认";
      tip(state.lastUnderstand.line);
      return;
    }
    if (classified.intent === "ambiguous" && allow && window.GwContextKernel) {
      var fb =
        levels.indexOf("body") >= 0
          ? "body"
          : levels.length
            ? "outline"
            : "body";
      classified = GwContextKernel.classify({
        message: displayMsg,
        levels: levels,
        allowEdit: allow,
        hasTaskCard: true,
        hasBaseDraft: false,
        forcedIntent: fb
      });
      state.pendingClarify = null;
      logInfo("ctx.clarify.soft_fallback", { intent: classified.intent });
    }

    var assembled = { block: "", trace: {} };
    var alignCard = null;
    if (window.GwContextKernel) {
      assembled = GwContextKernel.assembleWriteLayers({
        intent: classified.intent,
        confidence: classified.confidence,
        soft: classified.soft,
        focusLine: classified.focusLine,
        taskCard: state.taskCard,
        baseMd: allow ? resolveBaseDraftMd() : "",
        pinHint: pinnedScopeHint(),
        allowEdit: allow,
        displayMsg: displayMsg
      });
      logInfo("ctx.trace", assembled.trace);
    } else {
      assembled.block =
        sessionFrameworkHint() +
        (allow ? baseDraftConstraint() : "") +
        (pinnedScopeHint() ? pinnedScopeHint() + "\n" : "");
    }
    var matsEarly = citedMaterials();
    refreshStyleFingerprint();
    alignCard = buildAlignCardForSend(
      classified,
      assembled,
      matsEarly,
      allow,
      displayMsg
    );
    if (alignCard && alignCard.promptBlock) assembled.block += alignCard.promptBlock;
    paintUnderstandBar(classified, assembled, alignCard);

    var ctx = focusContextMd();
    var docMd = currentDocMd();
    var mats = matsEarly;
    var levelRule = levels.length ? writeLevelConstraint(levels) : "";
    var shapeCarry = allow ? levelShapeCarry(levels) : "";
    var hist = chatHistoryForRelay();
    var ctxBlock = assembled.block;
    var sessionSum = window.GwContextKernel
      ? String(
          (classified.focusLine || "") +
            GwContextKernel.renderTaskCard(state.taskCard)
        ).slice(0, 2000)
      : sessionFrameworkHint().slice(0, 2000);
    var sendMsg = displayMsg;
    if (wantVars) {
      var markerHint = "含点选层级对应的标题行，井号个数必须正确";
      if (levels.indexOf("h1") >= 0 && levels.indexOf("h2") < 0)
        markerHint =
          "先 # 大标题一行，再 ## 一、…（两井号）；禁止用 # 写章节；禁止 ###";
      else if (levels.indexOf("h2") >= 0 && levels.indexOf("h1") < 0)
        markerHint =
          "每行二级必须是 ### （一）…（三井号）；禁止再写 ## 一级；禁止单个 #";
      else if (levels.indexOf("h1") >= 0 && levels.indexOf("h2") >= 0)
        markerHint =
          "先 # 大标题，再一级 ##、二级 ###；禁止用单个 # 当「一、二、三」";
      sendMsg =
        displayMsg +
        shapeCarry +
        ctxBlock +
        "\n\n【宿主约束】已勾选「给多份」。" +
        "必须输出 JSON：{reply, options:[{id,md,note},...]}，edit 必须为 null。" +
        "严禁空壳【待补】占位模板。" +
        "每组 options[].md 必须是可落稿 Markdown（" +
        markerHint +
        "）。井号错了整行字体都会错，请自检后再输出。" +
        "禁止只在 reply 里用自然语言罗列标题。" +
        "须遵守【本轮焦点说明】与分层标签；改架构必须交 options，禁止空口「已给出」。" +
        levelRule +
        "默认 3 组（用户指定组数从其，最多 5）。每组 note 一句差异；reply 一两句；禁止声称已写入；无依据勿编造。";
    } else if (wantDraft) {
      sendMsg =
        displayMsg +
        shapeCarry +
        ctxBlock +
        "\n\n【宿主约束】已勾选「出结论」。" +
        "输出一版：JSON 为 {reply, edit:{md}}；edit.md 必须是可落稿 Markdown，禁止只在 reply 描述。" +
        "严禁空壳【待补】占位模板。井号必须与点选层级一致（##=一级，###=二级，####=三级）；禁止用单个 # 当章节标题。" +
        "须遵守【本轮焦点说明】与分层标签。" +
        levelRule +
        "禁止声称已写入；无依据处标待核实。";
    } else {
      sendMsg =
        displayMsg +
        ctxBlock +
        "\n\n【宿主约束】未勾选「出结论/给多份」：纯聊天。" +
        "只用 reply；edit 与 options 必须为 null；禁止输出可落稿正文或空壳占位。" +
        "可商量结构；要落稿时请点选层级并勾选后再出。";
    }
    withLogin(function () {
      setBusy(true);
      tipProgress(allow ? "撰写中…" : "聊天中…");
      try {
        state.chat.push({ role: "user", text: displayMsg });
        persistChat("user_send");
        logInfo("chat.user", {
          n: state.chat.length,
          len: String(displayMsg || "").length,
          levels: selectedWriteLevels(),
          wantDraft: wantDraftChecked(),
          wantVars: wantVariantsChecked(),
          histN: hist.length,
          intent: classified.intent,
          confidence: classified.confidence
        });
        $("aiReq").value = "";
        renderOpts();
        hideReadBar();
        var runner =
          window.GwChatLoop && GwChatLoop.runChat
            ? GwChatLoop.runChat({
                message: sendMsg,
                contextMd: ctx,
                doc_md: docMd,
                capability: capability(),
                allowEdit: allow,
                materials: mats,
                history: hist,
                session_summary: sessionSum,
                read_set: (state.readSet || []).slice(),
                onStatus: function (s) {
                  var t = String(s || "");
                  if (/索引|同步/.test(t)) tipProgress("正在准备材料…");
                  else if (/执行|read_file|list_files|search/.test(t))
                    tipProgress("正在查阅材料…");
                  else tipProgress(allow ? "撰写中…" : "聊天中…");
                }
              })
            : GwRelay.chat(sendMsg, ctx, capability(), allow, mats, {
                history: hist,
                session_summary: sessionSum,
                doc_md: docMd,
                read_set: (state.readSet || []).slice()
              }).then(
                function (data) {
                  return {
                    reply: (data && data.reply) || "(空回复)",
                    edit: data && data.edit,
                    options: data && data.options,
                    read_set: data && data.read_set
                  };
                }
              );
        return runner
          .then(function (data) {
            if (data && Array.isArray(data.read_set) && data.read_set.length) {
              data.read_set.forEach(function (p) {
                if (p && state.readSet.indexOf(p) < 0) state.readSet.push(p);
              });
              logInfo("chat.read_set", { n: state.readSet.length });
              if (alignCard) {
                alignCard = buildAlignCardForSend(
                  classified,
                  assembled,
                  mats,
                  allow,
                  displayMsg
                );
                if (alignCard) {
                  state.lastUnderstand = {
                    short: alignCard.short,
                    line: alignCard.tipLine,
                    intent: classified.intent,
                    align: alignCard.trace
                  };
                }
              }
            }
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
              editMd = "";
            } else if (wantDraft && editMd) {
              variants = [{ id: "1", note: "结论稿", md: editMd }];
              editMd = "";
            } else if (wantDraft && !editMd) {
              var sk1 = extractHeadingSkeletonFromReply(reply);
              if (sk1) {
                variants = [{ id: "1", note: "从回复提取", md: sk1 }];
                reply =
                  "（已从回复提取可落稿标题骨架。请用「选定」或「光标」写入。）";
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
              var scaffoldHit = /已搭.*骨架|【待补/.test(reply || "");
              bubble.text =
                reply +
                "\n\n（" +
                (scaffoldHit
                  ? "中转回了空壳骨架或未带 options。请确认线上中转已更新后重发；本机不会用模板顶替。"
                  : "模型未给出可用多份稿。请勾选「给多份」后重发；本机不会用模板顶替。") +
                "）";
              tip(scaffoldHit ? "中转空壳骨架已拒收" : "模型未给出多份稿");
            } else if (wantDraft && !variants.length) {
              bubble.text =
                reply +
                "\n\n（模型未给出可落稿结论，请勾选「出结论」后重发；本机不会用模板顶替。）";
              tip("模型未给出结论稿");
            } else if (wantDraft && variants.length) {
              bubble.text =
                reply +
                (/\n/.test(reply) ? "\n\n" : "\n") +
                "（用卡片按钮写入；每次先存版本）";
              tip("结论已出 · 卡片上点小按钮写入");
            } else {
              tip("完成");
            }
            var checkMd = "";
            if (variants && variants.length) {
              checkMd = variants
                .map(function (v) {
                  return v.md || "";
                })
                .join("\n");
            } else if (editMd) checkMd = editMd;
            else checkMd = reply;
            state.chat.push(bubble);
            if (allow && bubble.variants && bubble.variants.length) {
              markBaseDraft(state.chat.length - 1, 0, "new_variants");
            }
            persistChat("assistant_ok");
            logInfo("chat.assistant", {
              n: state.chat.length,
              variants: (bubble.variants && bubble.variants.length) || 0,
              replyLen: String(bubble.text || "").length,
              base: state.baseDraft
            });
            renderOpts();
            syncTabUi();
            var qchk = runDraftGate(checkMd, classified);
            if (qchk && qchk.bubbleNote) {
              bubble.text =
                String(bubble.text || "") +
                (/\n/.test(bubble.text) ? "\n\n" : "\n") +
                qchk.bubbleNote;
              state.chat[state.chat.length - 1] = bubble;
              persistChat("assistant_quality");
              renderOpts();
            }
            if (capability() !== "strong" || !allow || !checkMd) return null;
            tip(
              ((state.lastUnderstand && state.lastUnderstand.line) ||
                "对齐") + " · 交稿深检…"
            );
            return runModelCritic(checkMd, classified)
              .then(function (modelChk) {
                if (!modelChk) return;
                var merged = GwQualityKernel.mergeCritic(qchk, modelChk);
                renderQualityBar(merged);
                tip(merged.tip);
                if (modelChk.bubbleNote && modelChk.issues && modelChk.issues.length) {
                  bubble.text =
                    String(bubble.text || "") +
                    (/\n/.test(bubble.text) ? "\n" : "\n") +
                    modelChk.bubbleNote;
                  state.chat[state.chat.length - 1] = bubble;
                  persistChat("assistant_critic");
                  renderOpts();
                }
                logInfo("quality.critic", {
                  pass: modelChk.pass,
                  n: (modelChk.issues && modelChk.issues.length) || 0
                });
              })
              .catch(function (eC) {
                logWarn(
                  "quality.critic.fail",
                  String((eC && eC.message) || eC)
                );
              });
          })
          .catch(function (e) {
            var err =
              (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
              e.message ||
              "失败";
            tip(err);
            logWarn("chat.fail", err);
            state.chat.push({
              role: "assistant",
              text:
                "失败：" +
                err +
                "\n\n（中转不可用时不再本地拼装提纲，请恢复中转后重发，由模型生成。）"
            });
            persistChat("assistant_fail");
            renderOpts();
          })
          .then(function () {
            setBusy(false);
          });
      } catch (errInner) {
        setBusy(false);
        tip("发送异常：" + ((errInner && errInner.message) || errInner));
        logWarn("send.inner", String(errInner && errInner.message));
        return Promise.resolve();
      }
    }).catch(function (e) {
      setBusy(false);
      var m = (e && e.message) || "请先登录后再发送";
      tip(m);
      logWarn("send.login", m);
    });
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
    var prev = state.tab;
    state.tab = tab;
    if (tab === "proof") {
      state.proof = [];
    }
    logInfo("ui.tab", { from: prev, to: tab, chatN: state.chat.length });
    syncTabUi();
  }

  window.onload = function () {
    logInfo("ui.onload", {
      href: String(location.href || ""),
      base: (window.GwRelay && GwRelay.baseUrl && GwRelay.baseUrl()) || ""
    });
    ensureBase();
    setBusy(false);
    state.pendingClarify = null;
    if (window.GwAccount) GwAccount.init();
    try {
      if (restoreChat()) {
        tip("已恢复上次对话 " + state.chat.length + " 条");
      }
    } catch (eRestore) {
      logWarn("chat.restore.crash", String(eRestore && eRestore.message));
    }
    syncTabUi();
    startLiveWatch();

    window.addEventListener("beforeunload", function () {
      persistChat("beforeunload");
    });
    window.addEventListener("pagehide", function () {
      persistChat("pagehide");
    });
    /* 定时落盘，防最小化关窗来不及写 beforeunload */
    setInterval(function () {
      if (state.chat && state.chat.length) persistChat("interval");
    }, 8000);

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

    var sendBtn = $("aiSend");
    if (sendBtn) {
      sendBtn.onclick = function () {
        doSend();
      };
    }
    var reqEl = $("aiReq");
    if (reqEl) {
      reqEl.addEventListener("keydown", function (ev) {
        var key = ev.key || "";
        var code = ev.keyCode || ev.which;
        var isEnter = key === "Enter" || code === 13;
        if (!isEnter || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey)
          return;
        if (ev.isComposing || code === 229) return;
        ev.preventDefault();
        doSend();
      });
    }
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
      logWarn("chat.clear", {
        n: state.chat.length,
        stack: "user_click_aiClearChat"
      });
      /* 铁律：清空对话绝不碰 ActiveDocument */
      state.chat = [];
      state.options = [];
      state.previewId = null;
      state.adoptedId = null;
      state.suiteBaseline = "";
      state.readSet = [];
      state.baseDraft = null;
      state.taskCard = window.GwContextKernel
        ? GwContextKernel.emptyCard()
        : null;
      state.pendingClarify = null;
      state._clarifyAskedOnce = false;
      state.lastUnderstand = null;
      persistChat("user_clear");
      syncRestoreBtn();
      renderOpts();
      syncTabUi();
      var qBar = $("aiQualityBar");
      if (qBar) {
        qBar.hidden = true;
        qBar.innerHTML = "";
      }
      tip("已清空对话 · 正文未改动");
    };
    var tipEl = $("aiTip");
    if (tipEl) {
      tipEl.title = "双击复制调试日志（GwLog）";
      tipEl.addEventListener("dblclick", function () {
        if (!window.GwLog) return;
        GwLog.copy().then(function (ok) {
          tip(ok ? "调试日志已复制 · 共 " + GwLog.size() + " 条" : "复制日志失败");
        });
      });
    }
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
    var styleBar = $("aiStyleBar");
    if (styleBar) {
      styleBar.addEventListener("click", function (e) {
        var x = e.target.closest("[data-style-x]");
        if (!x || !window.GwProject || !GwProject.clearStyleRef) return;
        e.preventDefault();
        GwProject.clearStyleRef();
        state.styleFp = null;
        state.styleRefText = "";
        renderStyleBar();
        tip("已取消风格参照");
      });
    }
    window.addEventListener("gw-style-ref", function () {
      refreshStyleFingerprint();
      renderStyleBar();
      if (state.styleFp && !state.styleFp.error) {
        tip(
          "参照已就绪 · " +
            (state.styleFp.title || state.styleFp.path) +
            " · 学口气不照抄"
        );
      } else if (!GwProject.getStyleRefRel || !GwProject.getStyleRefRel()) {
        renderStyleBar();
      }
    });
    renderCiteBar();
    renderStyleBar();
    refreshStyleFingerprint();
    setInterval(function () {
      renderCiteBar();
      renderStyleBar();
    }, 600);
  };
})();
