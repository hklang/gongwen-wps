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

  /** 不再用正则抽任务卡；历史原话走 fetch_context(history) */
  function ingestUserMessage(card, text) {
    return ensureCard(card);
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

  /** 宿主不再猜 intent；写什么由本轮用户原文决定 */
  function classify(opts) {
    opts = opts || {};
    return {
      intent: "",
      confidence: 1,
      soft: false,
      focusLine: "",
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

  /** 软修剪：失败轮丢弃。本钉住下每轮出卡都收成「情况」，不附稿、不当命令。 */
  function historyPin(pin) {
    if (!pin || typeof pin.start !== "number" || typeof pin.end !== "number")
      return null;
    return { start: pin.start, end: pin.end };
  }

  function samePin(cur, msg) {
    if (!cur) return true;
    if (!msg || !msg.pinBound) return true;
    if (typeof msg.pinStart !== "number" || typeof msg.pinEnd !== "number")
      return false;
    return cur.start === msg.pinStart && cur.end === msg.pinEnd;
  }

  function lastUserIndexBefore(raw, idx) {
    var i;
    for (i = idx - 1; i >= 0; i--) {
      if (raw[i] && raw[i].role === "user") return i;
    }
    return -1;
  }

  function formatRoundLine(userMsg, variants, adoptedId) {
    var said = stripHostMeta((userMsg && userMsg.text) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (said.length > 80) said = said.slice(0, 80) + "…";
    said = said.replace(/[。．.！？!?]+$/, "");
    var sizes = [];
    var notes = [];
    var i;
    for (i = 0; i < (variants || []).length && i < 6; i++) {
      var v = variants[i] || {};
      var n = String(v.md || "").replace(/\s/g, "").length;
      sizes.push(n + "字");
      var note = String(v.note || "").replace(/\s+/g, " ").trim();
      if (note.length > 24) note = note.slice(0, 24) + "…";
      notes.push((v.id || String.fromCharCode(65 + i)) + (note ? "「" + note + "」" : ""));
    }
    var bits = [];
    if (said) bits.push("你说「" + said + "」。");
    if (sizes.length) {
      bits.push("出了 " + sizes.length + " 案（约 " + sizes.join(" / ") + "）。");
    }
    if (notes.length) bits.push("差异：" + notes.join("、") + "。");
    if (adoptedId) {
      bits.push("已采用" + adoptedId + "，本轮钉住即该稿。");
    }
    return bits.join("");
  }

  /** 本钉住下各轮收成一块【历史】，不附稿。无历史则空串。 */
  function formatPinHistory(chat, pin, limit, extras) {
    limit = limit || 10;
    extras = extras || {};
    var raw = chat || [];
    var cur = historyPin(pin);
    var rounds = [];
    var i;
    var u;
    for (i = 0; i < raw.length; i++) {
      var a = raw[i];
      if (!a || a.role !== "assistant" || !a.variants || !a.variants.length)
        continue;
      if (!samePin(cur, a)) continue;
      u = lastUserIndexBefore(raw, i);
      rounds.push({
        user: u >= 0 ? raw[u] : null,
        variants: a.variants,
        adoptedId: a.adoptedId || ""
      });
    }
    if (rounds.length > limit) rounds = rounds.slice(-limit);
    if (!rounds.length) return "";
    if (extras.lastAdoptedId && !rounds[rounds.length - 1].adoptedId) {
      rounds[rounds.length - 1].adoptedId = extras.lastAdoptedId;
    }
    var total = rounds.length;
    var nums = [];
    for (i = 1; i <= total; i++) nums.push(String(i));
    var head =
      "【历史" +
      nums.join("、") +
      "】1=最远；" +
      total +
      "=上一轮。数字越大距离本轮对话越近。";
    return (
      head +
      "\n" +
      rounds
        .map(function (r, n) {
          var ago = total - 1 - n;
          var tag =
            total === 1 || ago === 0
              ? "上一轮"
              : n === 0
                ? "最远"
                : "距今" + ago + "轮";
          return (
            n +
            1 +
            ". " +
            tag +
            "：" +
            formatRoundLine(r.user, r.variants, r.adoptedId)
          );
        })
        .join("\n")
    );
  }

  /** 近轮已进本轮【历史】，messages 不再另带旧轮，避免当成命令。 */
  function pruneHistory() {
    return [];
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

  function buildAlignHint() {
    return "";
  }

  /**
   * 要啥给啥：首包只报有什么；钉住原文由发送包另附，不进清单。
   */
  function buildContextInventory(opts) {
    opts = opts || {};
    var pinRaw = String(opts.pinText || "").trim();
    var pinN =
      Number(opts.pinChars) ||
      (pinRaw ? pinRaw.replace(/\s/g, "").length : 0);
    var docN = Number(opts.docChars) || 0;
    var matN = Number(opts.matCount) || 0;
    var lines = ["【还有什么】（未附正文；要则点名）"];
    if (docN > 0) {
      lines.push(
        "- 全文 doc_full：有，约 " + docN + " 字 → fetch_context([\"doc_full\"])"
      );
    }
    if (matN > 0) {
      lines.push(
        "- 素材：有，约 " +
          matN +
          " 个文件 → list_files / search_materials / read_file"
      );
    }
    var block = lines.length > 1 ? "\n" + lines.join("\n") + "\n" : "";
    return {
      block: block,
      trace: {
        mode: "inventory",
        layers: ["inventory"],
        pinChars: pinN,
        pinAttached: pinN > 0,
        docChars: docN,
        matCount: matN,
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
    formatPinHistory: formatPinHistory,
    stripHostMeta: stripHostMeta,
    assembleWriteLayers: assembleWriteLayers,
    buildContextInventory: buildContextInventory,
    parseClarifyChoice: parseClarifyChoice,
    looksLikeWriteContinue: looksLikeWriteContinue,
    clarifyPrompt: clarifyPrompt,
    TASK_PIN_RE: TASK_PIN_RE
  };
})(window);
