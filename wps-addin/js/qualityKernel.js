/**
 * Quality Kernel · 商用写作品质内核（与 Context Kernel 联合）
 * 规格：specs/2026-08-12-08-WPS写作聪明程度方案.md
 * 能力：风格指纹 · 写前对齐 · 出稿质检（宿主侧，默认无第二模型税）
 */
(function (global) {
  function intentLabel(intent) {
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

  /** 从本机参照稿抽风格指纹（学口气/结构，禁止当全文粘贴） */
  function extractStyleFingerprint(text, meta) {
    meta = meta || {};
    var raw = String(text || "").slice(0, 14000);
    var lines = raw.split(/\r?\n/);
    var headings = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      var hm = lines[i].match(/^\s*(#{1,4}\s+.+)$/);
      if (hm) {
        headings.push(hm[1].trim().slice(0, 100));
        if (headings.length >= 14) break;
      }
    }
    if (!headings.length) {
      for (i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (
          /^[一二三四五六七八九十]+[、．.]/.test(t) ||
          /^（[一二三四五六七八九十]+）/.test(t) ||
          /^\([一二三四五六七八九十]+\)/.test(t)
        ) {
          headings.push(t.slice(0, 100));
          if (headings.length >= 14) break;
        }
      }
    }
    var paras = raw.split(/\n\s*\n/).filter(function (p) {
      return p.replace(/\s/g, "").length > 36;
    });
    var lens = paras.slice(0, 24).map(function (p) {
      return p.replace(/\s/g, "").length;
    });
    var avg = 0;
    if (lens.length) {
      avg = Math.round(
        lens.reduce(function (a, b) {
          return a + b;
        }, 0) / lens.length
      );
    }
    function breath(p) {
      return String(p || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
    }
    return {
      path: meta.path || "",
      title: meta.title || "",
      headings: headings,
      avgParaChars: avg,
      parallelHint: /既要|又要|一方面|另一方面|不仅|而且|既.|又./.test(raw),
      sampleOpen: breath(paras[0]),
      sampleClose: breath(paras[paras.length - 1]),
      charCount: raw.replace(/\s/g, "").length
    };
  }

  function renderStyleBlock(fp) {
    if (!fp || (!fp.headings.length && !fp.sampleOpen && !fp.charCount)) {
      return "";
    }
    var title = fp.title || fp.path || "参照稿";
    var block =
      "\n【风格参照·仅学口气与结构，禁止整段照抄】\n" +
      "- 来源：" +
      title +
      "\n";
    if (fp.headings && fp.headings.length) {
      block +=
        "- 标题/条目习惯：\n  " + fp.headings.slice(0, 10).join("\n  ") + "\n";
    }
    if (fp.avgParaChars) {
      block += "- 段落体量约 " + fp.avgParaChars + " 字/段（大致对齐，勿机械凑字）\n";
    }
    if (fp.parallelHint) {
      block += "- 参照常见对仗/递进，须有区分度\n";
    }
    if (fp.sampleOpen) {
      block += "- 开篇气息（勿照抄）：" + fp.sampleOpen + "\n";
    }
    if (fp.sampleClose) {
      block += "- 收束气息（勿照抄）：" + fp.sampleClose + "\n";
    }
    return block;
  }

  function plagiarismHint(draft, refText) {
    var d = String(draft || "").replace(/\s/g, "");
    var ref = String(refText || "").replace(/\s/g, "");
    if (d.length < 80 || ref.length < 80) return "";
    var hits = 0;
    var i;
    for (i = 0; i + 28 < ref.length && i < 2400; i += 48) {
      var chunk = ref.slice(i, i + 28);
      if (chunk.length >= 28 && d.indexOf(chunk) >= 0) hits++;
    }
    return hits >= 3 ? "与参照稿重合偏高，疑似照抄" : "";
  }

  /**
   * 商用写前对齐卡
   * @returns {{ short, tipLine, promptBlock, evidence, style, risks, trace }}
   */
  function buildAlignCard(opts) {
    opts = opts || {};
    var intent = opts.intent || "chat";
    var layers = opts.layers || [];
    var readN = (opts.readSet && opts.readSet.length) || 0;
    var matN = (opts.materials && opts.materials.length) || 0;
    var allow = !!opts.allowEdit;
    var msg = String(opts.message || "");
    var fp = opts.styleFingerprint || null;
    var risks = [];

    var evidence =
      readN > 0 ? "已读" + readN : matN > 0 ? "引用" + matN : "依据0";
    var styleName = fp && (fp.title || fp.path) ? String(fp.title || fp.path) : "";
    var style = styleName
      ? "参照《" + styleName.replace(/^.*[/\\]/, "").slice(0, 18) + "》"
      : "未选参照";

    if (
      allow &&
      readN === 0 &&
      matN === 0 &&
      /(?:\d+\s*%|\d+\s*万|\d+\s*亿|同比|完成率|具体数|增长)/.test(msg)
    ) {
      risks.push("缺材料易编数");
    }
    if (
      allow &&
      !opts.hasTaskCard &&
      (intent === "lead" || intent === "outline" || intent === "revise_outline")
    ) {
      risks.push("任务框架薄");
    }
    if (intent === "lead" && opts.hasBaseDraft) {
      risks.push("冒段勿锁死标题底稿");
    }

    var short = intentLabel(intent);
    var tipParts = ["对齐：" + short, evidence, style];
    if (risks[0]) tipParts.push(risks[0]);
    var tipLine = tipParts.join(" · ").slice(0, 110);

    var promptBlock =
      "\n【写前对齐】（商用质量门·须遵守）\n" +
      "- 意图：" +
      intent +
      "（须与【本轮焦点说明】一致；焦点跟本轮意图走）\n" +
      "- 证据：" +
      evidence +
      (readN || matN
        ? "；有材料须据实，关键数字/事实能指回材料，无出处标【待核实】"
        : "；无精读/引用时禁止编造数字、单位与具体政绩结论，宁可少写") +
      "\n" +
      "- 风格：" +
      style +
      (fp
        ? "；贴近参照口气与结构习惯，禁止整段照抄"
        : "；未选参照则写得体公文，勿冒充某单位专属口气或硬编专名") +
      "\n" +
      (risks.length ? "- 风险：" + risks.join("；") + "\n" : "") +
      "- 纪律：内部对齐后再出稿；禁止输出长思考过程；质量优先于套话空壳；" +
      "对仗要有区分度；禁止【待补】占位；立意取舍服务于本轮用户任务。\n";

    promptBlock += renderStyleBlock(fp);

    return {
      intent: intent,
      short: short,
      tipLine: tipLine,
      evidence: evidence,
      style: style,
      risks: risks,
      promptBlock: promptBlock,
      trace: {
        intent: intent,
        evidence: evidence,
        style: style,
        stylePath: (fp && fp.path) || "",
        risks: risks.slice(),
        layers: layers.slice ? layers.slice() : layers
      }
    };
  }

  /** 出稿质检（兼容旧名） */
  function lightDraftCheck(md, opts) {
    return draftCriticHost(md, opts);
  }

  /** 交稿检查单（人可读；未过不拦编辑） */
  function acceptanceChecklist(opts) {
    opts = opts || {};
    var intent = opts.intent || "";
    var levels = opts.levels || [];
    var items = [
      {
        id: "focus",
        label: "焦点与本轮意图一致",
        ok: !!intent && intent !== "ambiguous"
      },
      {
        id: "evidence",
        label: "关键数字有依据或已标待核实",
        ok: true
      },
      {
        id: "style",
        label: opts.hasStyleRef ? "已跟参照口气（未整段照抄）" : "未选参照·得体公文即可",
        ok: true
      },
      {
        id: "scaffold",
        label: "无【待补】空壳",
        ok: true
      },
      {
        id: "level",
        label: levels.length ? "井号层级与点选一致" : "层级未点选（聊天可过）",
        ok: true
      }
    ];
    return items;
  }

  /** 稿中数字是否出现在证据文本里（粗绑） */
  function bindEvidenceHints(md, evidenceText) {
    var text = String(md || "");
    var ev = String(evidenceText || "").replace(/\s/g, "");
    var unbound = [];
    var re = /(\d+\s*%|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\s*万|\d+\s*亿|\d{4,})/g;
    var m;
    var seen = {};
    while ((m = re.exec(text))) {
      var raw = m[1].replace(/\s/g, "");
      if (seen[raw]) continue;
      seen[raw] = true;
      if (/待核实/.test(text.slice(Math.max(0, m.index - 12), m.index + raw.length + 12)))
        continue;
      if (!ev || ev.indexOf(raw.replace(/,/g, "")) < 0) {
        unbound.push(raw);
      }
    }
    return unbound.slice(0, 6);
  }

  /**
   * 宿主交稿闸 DraftCritic（不改稿）
   * @returns {{ issues, tip, bubbleNote, checklist, pass, dims }}
   */
  function draftCriticHost(md, opts) {
    opts = opts || {};
    var text = String(md || "");
    var issues = [];
    var dims = [];
    var hasEv = !!(opts.readN || opts.matN);
    var checklist = acceptanceChecklist(opts);

    function add(dim, msg) {
      issues.push(msg);
      dims.push({ dim: dim, msg: msg });
    }

    if (!text) {
      return {
        issues: ["无成稿可检"],
        tip: "质检：无成稿",
        bubbleNote: "〔交稿闸〕无成稿可检",
        checklist: checklist,
        pass: false,
        dims: dims
      };
    }

    if (
      /(?:\d+\s*%|\d{2,}\s*万|\d+\s*亿|\d{4,})/.test(text) &&
      !hasEv &&
      !/待核实/.test(text)
    ) {
      add("据实", "含数字但本轮无精读/引用");
      checklist[1].ok = false;
    }

    var unbound = bindEvidenceHints(text, opts.evidenceText || "");
    if (hasEv && unbound.length && !/待核实/.test(text)) {
      add("据实", "数字未在材料中找到：" + unbound.slice(0, 3).join("、"));
      checklist[1].ok = false;
    }

    if (/【待补】|（待补充）|\bxxx\b/i.test(text)) {
      add("结构", "含空壳占位");
      checklist[3].ok = false;
    }

    if (/一方面[^。]{0,10}另一方面[^。]{0,10}再一方面/.test(text)) {
      add("口气", "套话堆砌嫌疑");
    }

    var plag = plagiarismHint(text, opts.refText || "");
    if (plag) {
      add("口气", plag);
      checklist[2].ok = false;
    }

    var levels = opts.levels || [];
    if (levels.indexOf("h1") >= 0 && !/^#\s+\S+/m.test(text) && !/^##\s+/m.test(text)) {
      add("结构", "点选了一级但未见标题行");
      checklist[4].ok = false;
    }
    if (levels.indexOf("h2") >= 0 && !/^###\s+/m.test(text) && !/^##\s+[一二三四五六七八九十]/m.test(text)) {
      /* 宽松：有 ## 一、 也算 */
      if (!/^##\s+/m.test(text)) {
        add("结构", "点选了二级但未见二级标题");
        checklist[4].ok = false;
      }
    }
    if (opts.intent === "lead" && opts.hasTaskCard === false) {
      add("立意", "任务框架薄，冒段易空泛");
    }
    if (opts.intent === "lead" && text.replace(/\s/g, "").length < 60) {
      add("立意", "冒段过短，统领感不足");
    }

    var failed = checklist.filter(function (c) {
      return !c.ok;
    });
    var pass = issues.length === 0;
    var tip = pass
      ? "交稿闸：通过"
      : "交稿闸：" + issues[0] + (issues.length > 1 ? " 等" + issues.length + "项" : "");
    var bubbleNote = pass
      ? "〔交稿闸〕通过"
      : "〔交稿闸〕" + issues.join("；");

    return {
      issues: issues,
      tip: tip,
      bubbleNote: bubbleNote,
      checklist: checklist,
      pass: pass,
      dims: dims,
      failedN: failed.length
    };
  }

  function buildModelCriticPrompt(md, opts) {
    opts = opts || {};
    var list = acceptanceChecklist(opts)
      .map(function (c) {
        return "- " + c.label;
      })
      .join("\n");
    return (
      "【交稿挑刺·增强档】禁止调用任何工具。禁止重写全文。禁止输出长思考。\n" +
      "只输出一个 JSON 对象：{\"pass\":true|false,\"issues\":[{\"dim\":\"立意|结构|口气|据实|口径\",\"msg\":\"不超过40字\"}]}\n" +
      "硬规则：稿中出现具体百分比/万元/亿元等数字，若上下文未给出材料依据，必须至少一条 dim=据实；" +
      "有【待补】必须报；整段照抄参照必须报。issues 最多 5 条；真正无问题才 pass=true。\n" +
      "本轮意图：" +
      (opts.intent || "") +
      "\n检查单：\n" +
      list +
      "\n\n【待检稿】\n" +
      String(md || "").slice(0, 6000)
    );
  }

  function parseModelCritic(raw) {
    var text = String(raw || "").trim();
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      var obj = JSON.parse(m[0]);
      if (!obj || typeof obj !== "object") return null;
      var issues = Array.isArray(obj.issues) ? obj.issues : [];
      var msgs = [];
      var dims = [];
      issues.slice(0, 5).forEach(function (it) {
        if (!it) return;
        var msg = String(it.msg || it.message || it).slice(0, 80);
        if (!msg) return;
        msgs.push(msg);
        dims.push({ dim: String(it.dim || "综合"), msg: msg });
      });
      return {
        pass: msgs.length === 0,
        issues: msgs,
        dims: dims,
        tip: msgs.length ? "深检：" + msgs[0] : "深检：通过",
        bubbleNote: msgs.length ? "〔深检〕" + msgs.join("；") : "〔深检〕通过"
      };
    } catch (e) {
      return null;
    }
  }

  function mergeCritic(host, model) {
    host = host || {
      issues: [],
      dims: [],
      pass: true,
      tip: "",
      bubbleNote: "",
      checklist: []
    };
    if (!model || !model.issues || !model.issues.length) {
      return host;
    }
    var issues = host.issues.slice();
    var dims = (host.dims || []).slice();
    model.issues.forEach(function (msg, i) {
      if (issues.indexOf(msg) < 0) issues.push(msg);
      if (model.dims && model.dims[i]) dims.push(model.dims[i]);
    });
    return {
      issues: issues,
      dims: dims,
      checklist: host.checklist,
      pass: issues.length === 0,
      tip: issues.length ? "交稿闸：" + issues[0] : host.tip,
      bubbleNote: issues.length
        ? "〔交稿闸〕" + issues.join("；")
        : host.bubbleNote || "〔交稿闸〕通过",
      failedN: issues.length,
      model: true
    };
  }

  global.GwQualityKernel = {
    intentLabel: intentLabel,
    extractStyleFingerprint: extractStyleFingerprint,
    renderStyleBlock: renderStyleBlock,
    buildAlignCard: buildAlignCard,
    lightDraftCheck: lightDraftCheck,
    draftCriticHost: draftCriticHost,
    acceptanceChecklist: acceptanceChecklist,
    bindEvidenceHints: bindEvidenceHints,
    buildModelCriticPrompt: buildModelCriticPrompt,
    parseModelCritic: parseModelCritic,
    mergeCritic: mergeCritic,
    plagiarismHint: plagiarismHint
  };
})(typeof window !== "undefined" ? window : this);
