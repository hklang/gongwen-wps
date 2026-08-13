/**
 * Context Kernel M1 — 焦点跟本轮意图走
 * 规格：specs/2026-08-12-07-WPS对话上下文方案.md
 */
(function (global) {
  var TASK_PIN_RE =
    /第[一二三四五六七八九十\d]+点|大致思路|框架|提纲|分管|负责|包含|比如|对仗|句式|字数|通知|下班前|字以内/;

  function emptyCard() {
    return {
      v: 1,
      updatedAt: 0,
      occasion: "",
      deadline: "",
      lengthLimit: "",
      scope: "",
      framework: [],
      style: { parallel: false, notes: "" },
      corrections: [],
      rawPins: []
    };
  }

  function ensureCard(card) {
    if (!card || typeof card !== "object") return emptyCard();
    if (!Array.isArray(card.rawPins)) card.rawPins = [];
    if (!Array.isArray(card.framework)) card.framework = [];
    if (!Array.isArray(card.corrections)) card.corrections = [];
    if (!card.style) card.style = { parallel: false, notes: "" };
    return card;
  }

  function pushUniquePin(card, text) {
    var t = String(text || "").trim();
    if (!t || t.length < 8) return;
    var slice = t.slice(0, 1800);
    var i;
    for (i = 0; i < card.rawPins.length; i++) {
      if (card.rawPins[i] === slice) return;
    }
    card.rawPins.push(slice);
    while (card.rawPins.length > 3) card.rawPins.shift();
    card.updatedAt = Date.now();
  }

  /** 用户消息写入任务卡（M1：rawPins + 粗提） */
  function ingestUserMessage(card, text) {
    card = ensureCard(card);
    var t = String(text || "").trim();
    if (!t) return card;
    if (TASK_PIN_RE.test(t)) pushUniquePin(card, t);
    if (/对仗|，{2,}|句式/.test(t)) {
      card.style.parallel = true;
      if (/对仗|句式/.test(t)) card.style.notes = t.slice(0, 200);
    }
    if (/不要|别用|改成|换成/.test(t) && t.length < 400) {
      card.corrections.push({ at: Date.now(), text: t.slice(0, 400) });
      while (card.corrections.length > 5) card.corrections.shift();
      card.updatedAt = Date.now();
    }
    var m = t.match(/分管[^。\n]{2,80}/);
    if (m) card.scope = m[0].slice(0, 120);
    var n = t.match(/(\d{3,4})\s*字/);
    if (n) card.lengthLimit = n[1] + "字以内";
    return card;
  }

  function cardHasContent(card) {
    card = ensureCard(card);
    return !!(
      card.rawPins.length ||
      card.scope ||
      card.lengthLimit ||
      (card.framework && card.framework.length) ||
      (card.corrections && card.corrections.length)
    );
  }

  function renderTaskCard(card) {
    card = ensureCard(card);
    if (!cardHasContent(card)) return "";
    var lines = ["【任务意图·L1】"];
    if (card.scope) lines.push("- 范围：" + card.scope);
    if (card.lengthLimit) lines.push("- 体量：" + card.lengthLimit);
    if (card.deadline) lines.push("- 时限：" + card.deadline);
    if (card.style && card.style.parallel)
      lines.push("- 偏好：对仗句式" + (card.style.notes ? "（" + card.style.notes + "）" : ""));
    if (card.corrections && card.corrections.length) {
      lines.push(
        "- 近期纠正：" +
          card.corrections
            .slice(-2)
            .map(function (c) {
              return c.text;
            })
            .join("；")
      );
    }
    if (card.rawPins.length) {
      lines.push("- 既定要点（用户原话摘要）：");
      card.rawPins.forEach(function (p) {
        lines.push(p);
        lines.push("---");
      });
    }
    return "\n" + lines.join("\n") + "\n";
  }

  function inferDraftKind(md) {
    var s = String(md || "");
    if (!s.replace(/\s/g, "")) return "empty";
    var heads = (s.match(/^#{1,4}\s+\S/gm) || []).length;
    var paras = s.split(/\n\n+/).filter(function (x) {
      return x.replace(/\s/g, "").length > 40 && !/^#{1,4}\s/.test(x.trim());
    }).length;
    if (heads >= 2 && paras <= 1) return "outline";
    if (paras >= 1 && heads <= 1) return "body";
    return "mixed";
  }

  function tocFromMd(md, maxLines) {
    var lines = String(md || "").split(/\r?\n/);
    var out = [];
    var i;
    for (i = 0; i < lines.length && out.length < (maxLines || 24); i++) {
      var t = lines[i].replace(/^\s+/, "").replace(/\s+$/, "");
      if (/^#{1,4}\s+\S/.test(t)) out.push(t);
    }
    return out;
  }

  /**
   * @returns {{intent,confidence,focusLine,clarifyOptions,soft}}
   */
  function classify(opts) {
    opts = opts || {};
    var msg = String(opts.message || "");
    var levels = opts.levels || [];
    var allow = !!opts.allowEdit;
    var hasCard = !!opts.hasTaskCard;
    var hasBase = !!opts.hasBaseDraft;
    var forced = opts.forcedIntent || "";
    if (forced) {
      return packIntent(forced, 0.95, false);
    }
    if (!allow) return packIntent("chat", 0.9, false);

    var scores = {
      lead: 0,
      outline: 0,
      revise_outline: 0,
      body: 0,
      ambiguous: 0
    };
    if (/冒段|开篇|开头|文章开头|总起|导语/.test(msg)) scores.lead += 3;
    if (/改成|不要.+要|换成|换架构|：\s*\S+.+：\s*\S+/.test(msg))
      scores.revise_outline += 3;
    if (/这组标题|再对仗|打磨标题|只改标题|二级再|三级再/.test(msg))
      scores.outline += 2.5;
    if (/充填|本节正文|写这段|段落|完成这段|先完成|继续写|写正文|扩写|充实/.test(msg))
      scores.body += 3;
    if (/（[一二三四五六七八九十\d]+）/.test(msg) && msg.length > 20)
      scores.body += 2;
    if (levels.indexOf("body") >= 0) scores.body += 2;
    if (levels.indexOf("body") >= 0 && levels.length === 1) scores.body += 1;
    if (
      (levels.indexOf("h1") >= 0 ||
        levels.indexOf("h2") >= 0 ||
        levels.indexOf("h3") >= 0) &&
      scores.lead < 2 &&
      scores.body < 2
    ) {
      scores.outline += 1.5;
    }
    if (!msg.replace(/\s/g, "") && allow) scores.outline += 1;
    /* 极短且无明确写作信号时才抬歧义；「先完成这段」等不算歧义 */
    var compact = msg.replace(/\s/g, "");
    var clearWrite =
      scores.body >= 2 ||
      scores.lead >= 2 ||
      scores.revise_outline >= 2 ||
      /完成|这段|继续|充填|正文|冒段|标题|对仗/.test(msg);
    if (compact.length > 0 && compact.length < 12 && !clearWrite) {
      if (hasCard && hasBase) scores.ambiguous += 2.5;
    }
    if (scores.lead >= 2 && scores.outline >= 2 && scores.body < 2)
      scores.ambiguous += 2;

    var best = "outline";
    var bestScore = -1;
    var k;
    for (k in scores) {
      if (k === "ambiguous") continue;
      if (scores[k] > bestScore) {
        bestScore = scores[k];
        best = k;
      }
    }
    /* 已有明确写作分时，不因 ambiguous 分压过 */
    if (
      scores.ambiguous >= 2.5 &&
      bestScore < 2 &&
      hasCard &&
      hasBase &&
      !clearWrite
    ) {
      return {
        intent: "ambiguous",
        confidence: 0.35,
        soft: true,
        focusLine: "",
        clarifyOptions: [
          { id: "A", intent: "lead", label: "统领全文写冒段/开头" },
          { id: "B", intent: "outline", label: "只打磨当前这组标题" }
        ]
      };
    }
    if (bestScore < 0.5 && hasCard && hasBase && !clearWrite && compact.length < 16) {
      return {
        intent: "ambiguous",
        confidence: 0.35,
        soft: true,
        focusLine: "",
        clarifyOptions: [
          { id: "A", intent: "lead", label: "统领全文写冒段/开头" },
          { id: "B", intent: "outline", label: "只打磨当前这组标题" }
        ]
      };
    }
    var conf = Math.min(0.95, 0.45 + bestScore * 0.12);
    return packIntent(best, conf, conf < 0.72);
  }

  function packIntent(intent, confidence, soft) {
    var choose =
      "分层仅供参考；本轮采用哪些、忽略哪些由你根据用户意图判断，无关历史结论勿迁入。";
    var focusLine = "";
    if (intent === "lead") {
      focusLine =
        "【本轮焦点说明】intent=lead：须统领【任务意图】全文框架写开头/冒段；" +
        "当前标题底稿仅作目录对照，禁止只围着底稿那一节展开。" +
        choose;
    } else if (intent === "outline") {
      focusLine =
        "【本轮焦点说明】intent=outline：推荐焦点=当前标题/底稿/钉住；" +
        "任务卡在场防跑出全文范围，但不要强行重开未点选的其它大块。" +
        choose;
    } else if (intent === "revise_outline") {
      focusLine =
        "【本轮焦点说明】intent=revise_outline：本轮用户改法优先；旧底稿只对照，勿锁死旧架构。" +
        choose;
    } else if (intent === "body") {
      focusLine =
        "【本轮焦点说明】intent=body：写正文/段落；推荐钉住优先于结论底稿；少新增标题。" +
        choose;
    } else if (intent === "chat") {
      focusLine = "【本轮焦点说明】intent=chat：纯商量，不落稿。" + choose;
    }
    return {
      intent: intent,
      confidence: confidence,
      soft: !!soft,
      focusLine: focusLine,
      clarifyOptions: null
    };
  }

  function stripHostMeta(text) {
    return String(text || "")
      .replace(/\n*（以下\s*\d+\s*组参考[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（模型未给出[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（中转回了空壳[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（已拦截中转[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（用卡片按钮写入[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（已从回复提取[\s\S]*?）\s*/g, "\n")
      .replace(/\n*（提示：本轮未成功精读[\s\S]*?）\s*/g, "\n")
      .replace(/\n*请回复 A 或 B[\s\S]*$/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** 软修剪：失败轮丢弃；助手多份稿只留短摘要（省 token，不替模型判焦点） */
  function pruneHistory(chat, limit) {
    limit = limit || 10;
    var raw = (chat || []).slice();
    var out = [];
    var i;
    for (i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (!m) continue;
      var text = stripHostMeta(m.text || "");
      if (m.role === "assistant") {
        if (/失败：|模型未给出|空壳|中转不可用/.test(text)) continue;
        if (m.variants && m.variants.length) {
          text =
            text.split("\n")[0].slice(0, 180) +
            "\n（已出 " +
            m.variants.length +
            " 组参考，正文略）";
        } else {
          text = text.slice(0, 1200);
        }
      } else {
        text = text.slice(0, 2500);
      }
      if (!String(text || "").replace(/\s/g, "")) continue;
      out.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: text
      });
    }
    if (out.length > limit) out = out.slice(-limit);
    return out;
  }

  function buildBaseLayer(intent, baseMd, hasPin) {
    var md = String(baseMd || "");
    if (!md.replace(/\s/g, "")) return "";
    var kind = inferDraftKind(md);
    if (intent === "lead") {
      var toc = tocFromMd(md, 20);
      if (!toc.length) return "";
      return (
        "\n【焦点·L3-draft·标题目录摘要】（冒段勿只写其中一节）\n" +
        toc.join("\n") +
        "\n"
      );
    }
    if (intent === "revise_outline") {
      return (
        "\n【焦点·L3-draft·旧底稿对照】勿锁死下列旧架构，按本轮改法出新稿：\n" +
        md.slice(0, 6000) +
        "\n"
      );
    }
    if (intent === "outline" || intent === "body") {
      var pri =
        intent === "body" && hasPin
          ? "（次优先：有钉住时由你判断是否沿用；无关勿迁入）"
          : "（由你判断是否采用）";
      return (
        "\n【焦点·L3-draft·结论底稿】kind=" +
        kind +
        " " +
        pri +
        "\n" +
        md.slice(0, 10000) +
        "\n"
      );
    }
    return "";
  }

  function buildAlignHint(intent) {
    return (
      "\n【同轮自对齐】先在 reply 首句用十多字确认本轮焦点（与 intent=" +
      intent +
      " 一致）；需要上下文请先 fetch_context / 读素材，再输出 JSON。\n"
    );
  }

  /**
   * 要啥给啥：首包 = 清单 +（用户已钉住则必附 pin 原文）。
   * 钉住是显式工作面，不是宿主猜语义；底稿/全文/历史仍点名取。
   * opts: pinText, pinChars, draftChars, taskCard, historyN, docChars, focusLine, intent, soft, confidence, displayMsg, allowEdit
   */
  function buildContextInventory(opts) {
    opts = opts || {};
    var pinRaw = String(opts.pinText || "").trim();
    var pinN =
      Number(opts.pinChars) ||
      (pinRaw ? pinRaw.replace(/\s/g, "").length : 0);
    var draftN = Number(opts.draftChars) || 0;
    var docN = Number(opts.docChars) || 0;
    var histN = Number(opts.historyN) || 0;
    var card = opts.taskCard;
    var hasCard = cardHasContent(card);
    var pinAttached = pinN > 0 && !!pinRaw;
    var lines = [
      "【可用上下文清单】底稿/全文/任务卡/历史请 fetch_context；" +
        "素材用 list_files / search_materials / read_file。" +
        "用户已钉住时 pin 原文已附在下方（工作面），勿空编跑题。",
      "- pin（钉住范围）：" +
        (pinAttached
          ? "有，约" + pinN + "字（首包已附）"
          : pinN > 0
            ? "有，约" + pinN + "字；请 fetch_context"
            : "无"),
      "- base_draft（用户已采用的结论底稿）：" +
        (draftN > 0 ? "有，约" + draftN + "字；要则 fetch_context" : "无"),
      "- task_card（任务卡）：" +
        (hasCard ? "有；要则 fetch_context" : "无"),
      "- history（近轮对话）：" + histN + " 条",
      "- doc_full（当前完整正文）：" +
        (docN > 0 ? "有，约" + docN + "字；要则 fetch_context 取全文" : "无")
    ];
    var focusLine = opts.focusLine ? String(opts.focusLine) : "";
    var align = opts.allowEdit ? buildAlignHint(opts.intent || "outline") : "";
    var pinBlock = "";
    if (pinAttached) {
      pinBlock =
        "\n【钉住范围·本轮工作面】产出须紧贴此范围；" +
        "若仅为标题/范围且其下尚无正文，请在其下充填可落稿表述（勿另起无关专名主题）；" +
        "缺事实/数字先读素材再写，禁止无依据空编。\n" +
        pinRaw.slice(0, 6000) +
        "\n";
    }
    var block =
      (focusLine ? "\n" + focusLine + "\n" : "") +
      pinBlock +
      "\n" +
      lines.join("\n") +
      "\n" +
      align;
    return {
      block: block,
      trace: {
        intent: opts.intent || "outline",
        confidence: opts.confidence != null ? opts.confidence : null,
        soft: !!opts.soft,
        mode: "inventory",
        layers: pinAttached ? ["inventory", "pin"] : ["inventory"],
        pinChars: pinN,
        pinAttached: pinAttached,
        draftChars: draftN,
        docChars: docN,
        historyN: histN,
        hasCard: hasCard,
        msgChars: String(opts.displayMsg || "").length
      }
    };
  }

  /** @deprecated 预灌全文已弃用；撰写主路径改用 buildContextInventory */
  function assembleWriteLayers(opts) {
    opts = opts || {};
    var pinRaw = opts.pinHint ? String(opts.pinHint) : "";
    /* pinHint 可能已带【钉住范围】包装；优先用 pinText */
    var pinText = String(opts.pinText || "").trim();
    if (!pinText && pinRaw) {
      pinText = pinRaw
        .replace(/^[\s\S]*?【钉住范围】\s*/m, "")
        .trim();
      if (!pinText) pinText = pinRaw;
    }
    var baseMd = String(opts.baseMd || "");
    return buildContextInventory({
      intent: opts.intent,
      confidence: opts.confidence,
      soft: opts.soft,
      focusLine: opts.focusLine,
      displayMsg: opts.displayMsg,
      allowEdit: opts.allowEdit,
      taskCard: opts.taskCard,
      pinText: pinText,
      pinChars: pinText.replace(/\s/g, "").length,
      draftChars: baseMd.replace(/\s/g, "").length,
      docChars: Number(opts.docChars) || 0,
      historyN: Number(opts.historyN) || 0
    });
  }

  function looksLikeWriteContinue(text) {
    var t = String(text || "").trim();
    if (!t) return false;
    if (t.length >= 24) return true;
    return /完成|这段|继续|充填|正文|扩写|（[一二三四五六七八九十\d]+）|#{1,4}\s/.test(
      t
    );
  }

  function parseClarifyChoice(text, options) {
    var t = String(text || "").trim();
    var opts = options || [];
    var i;
    if (/^[Aa]/.test(t) || /^选\s*A/.test(t) || /冒段|开头|统领全文/.test(t)) {
      for (i = 0; i < opts.length; i++) {
        if (opts[i].id === "A") return opts[i];
      }
    }
    if (/^[Bb]/.test(t) || /^选\s*B/.test(t) || /标题|打磨|对仗这组/.test(t)) {
      for (i = 0; i < opts.length; i++) {
        if (opts[i].id === "B") return opts[i];
      }
    }
    return null;
  }

  function clarifyPrompt(options) {
    var lines = [
      "本轮意图不够明确，请先选一个焦点（回复 A 或 B）：",
      ""
    ];
    (options || []).forEach(function (o) {
      lines.push(o.id + ". " + o.label);
    });
    lines.push("");
    lines.push("选好后直接发送，再出稿。");
    return lines.join("\n");
  }

  global.GwContextKernel = {
    emptyCard: emptyCard,
    ensureCard: ensureCard,
    ingestUserMessage: ingestUserMessage,
    cardHasContent: cardHasContent,
    renderTaskCard: renderTaskCard,
    inferDraftKind: inferDraftKind,
    classify: classify,
    pruneHistory: pruneHistory,
    stripHostMeta: stripHostMeta,
    assembleWriteLayers: assembleWriteLayers,
    buildContextInventory: buildContextInventory,
    parseClarifyChoice: parseClarifyChoice,
    looksLikeWriteContinue: looksLikeWriteContinue,
    clarifyPrompt: clarifyPrompt,
    TASK_PIN_RE: TASK_PIN_RE
  };
})(window);
