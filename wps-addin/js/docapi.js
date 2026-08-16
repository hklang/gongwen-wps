(function (global) {
  function app() {
    if (typeof global.Application !== "undefined") return global.Application;
    throw new Error("无 Application");
  }

  function doc() {
    return app().ActiveDocument;
  }

  function selection() {
    return doc().ActiveWindow.Selection;
  }

  function cleanText(t) {
    return String(t == null ? "" : t).replace(/\r/g, "\n");
  }

  function getSelectionText() {
    return cleanText(selection().Text);
  }

  function getSelectionInfo() {
    var s = selection();
    var raw = String(s.Text == null ? "" : s.Text);
    var t = cleanText(raw);
    var start = 0;
    var end = 0;
    try {
      start = s.Start;
      end = s.End;
    } catch (e) {}
    var paraIdx = indexOfParagraph(s.Paragraphs.Item(1));
    var endsWithPara = /\r$/.test(raw) || /\n$/.test(t);
    if (!endsWithPara) {
      try {
        var last = s.Paragraphs.Item(s.Paragraphs.Count);
        if (last && end >= last.Range.End) endsWithPara = true;
      } catch (e2) {}
    }
    return {
      text: t,
      start: start,
      end: end,
      empty: !t.replace(/\s/g, ""),
      paraIndex: paraIdx,
      heading: headingInfo(s.Paragraphs.Item(1)),
      endsWithPara: endsWithPara
    };
  }

  /** 把正文规范成 WPS 可写回的段文本 */
  function toWordText(text, endsWithPara) {
    var out = String(text == null ? "" : text);
    out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    out = out.replace(/[ \t]+$/g, "");
    out = out.replace(/\n+$/g, "");
    out = out.replace(/\n/g, "\r");
    if (endsWithPara) out += "\r";
    return out;
  }

  /**
   * 划选 / 清空 / 写回的共用边界：只含正文，不含首尾段标。
   * 段标一进范围，邻段就会粘连、排版被带走——与按钮、是否钉住无关。
   */
  function shrinkToContentRange(start, end) {
    var d = doc();
    var raw = "";
    try {
      raw = String(d.Range(start, end).Text == null ? "" : d.Range(start, end).Text);
    } catch (e0) {
      return { start: start, end: end, raw: "" };
    }
    while (end > start && raw.charAt(0) === "\r") {
      start += 1;
      try {
        raw = String(d.Range(start, end).Text == null ? "" : d.Range(start, end).Text);
      } catch (e1) {
        break;
      }
    }
    while (end > start && raw.charAt(raw.length - 1) === "\r") {
      end -= 1;
      try {
        raw = String(d.Range(start, end).Text == null ? "" : d.Range(start, end).Text);
      } catch (e2) {
        break;
      }
    }
    return { start: start, end: end, raw: raw };
  }

  /**
   * 写回选区：先清空选定正文（保留段末回车），再写入新内容。
   * 含 Markdown / 多段时按公文行排版写入。
   */
  function replaceSelection(text, opts) {
    opts = opts || {};
    var s = selection();
    var start = 0;
    var end = 0;
    try {
      start = s.Start;
      end = s.End;
    } catch (ePos) {}
    var shrunk = shrinkToContentRange(start, end);
    start = shrunk.start;
    end = shrunk.end;
    var raw = shrunk.raw;
    var cur = cleanText(raw);
    if (end <= start || !cur.replace(/\s/g, "")) {
      throw new Error("请先划选要改的正文");
    }
    var src = String(text == null ? "" : text);

    try {
      selectRange(start, end);
    } catch (eSel) {}

    /* 只清正文，不动段标；用 Range.Text=''，避免 Delete 后残留 */
    try {
      doc().Range(start, end).Text = "";
    } catch (eWipe) {
      try {
        s.SetRange(start, end);
        s.Text = "";
      } catch (eWipe2) {
        try {
          s.Delete();
        } catch (eDel) {}
      }
    }
    try {
      s.SetRange(start, start);
    } catch (eHome) {}

    ensureGongwenDocChrome();
    typeLinesStyled(splitWriteLines(src));
    return true;
  }

  /**
   * 选中「当前标题整块」= 标题行 + 其下直到同级/更高级标题之前的全部内容。
   * 用于撰写「选定」覆盖：钉住一级后出二级时，连同旧要点一并替换掉。
   */
  function selectHeadingSection() {
    var s = selection();
    var p0 = s.Paragraphs.Item(1);
    var h0 = headingInfo(p0);
    if (!h0.via) {
      throw new Error("光标不在标题上");
    }
    var startIdx = indexOfParagraph(p0);
    if (!startIdx) throw new Error("找不到当前段落");
    var paras = doc().Paragraphs;
    var n = paras.Count;
    var endIdx = startIdx;
    var j;
    for (j = startIdx + 1; j <= n; j++) {
      var hj = headingInfo(paras.Item(j));
      if (hj.via && hj.lvl <= h0.lvl) break;
      endIdx = j;
    }
    var c = shrinkToContentRange(
      paras.Item(startIdx).Range.Start,
      paras.Item(endIdx).Range.End
    );
    selectRange(c.start, c.end);
    return {
      heading: h0,
      from: startIdx,
      to: endIdx,
      text: getSelectionText(),
      start: c.start,
      end: c.end,
      endsWithPara: true,
      info: getSelectionInfo()
    };
  }

  /**
   * 按文档绝对范围写回（精修钉子），返回新 start/end。
   * 比 Selection 更稳：不依赖当前光标是否还在选区上。
   */
  function replaceRange(start, end, text, opts) {
    opts = opts || {};
    if (typeof start !== "number" || typeof end !== "number" || end <= start) {
      throw new Error("选区锚点已失效，请重新钉住后再试");
    }
    var shrunk = shrinkToContentRange(start, end);
    start = shrunk.start;
    end = shrunk.end;
    var raw = shrunk.raw;
    var cur = cleanText(raw);
    if (end <= start || (!cur.replace(/\s/g, "") && !opts.allowEmpty)) {
      throw new Error("选区锚点已失效，请重新钉住后再试");
    }
    var d = doc();
    /* 段标留在范围外，写回不再补末尾回车（补了会多空段，不补也不粘连） */
    var out = toWordText(text, false);
    var rng = d.Range(start, end);
    rng.Text = out;
    var ns = rng.Start;
    var ne = rng.End;
    try {
      selectRange(ns, ne);
    } catch (eSel) {}
    return { start: ns, end: ne, text: cleanText(out), endsWithPara: false };
  }

  function getDocumentText() {
    return cleanText(doc().Content.Text);
  }

  function contentStart() {
    return doc().Content.Start;
  }

  /**
   * 整篇写入 —— 危险：会剥掉样式/节/域。
   * 仅允许在「已存版本 + 用户确认整篇排版写入」后调用；商品路径优先 writeDocumentStyled。
   */
  function setDocumentText(text) {
    var out = toWordText(text, true);
    doc().Content.Text = out;
    return cleanText(out);
  }

  /**
   * 公文落稿排版（对标 Word/tools/政府公文排版规范.md + md2docx.py）
   * 不用 Word「标题1/2」，直接设字体/字号/加黑/对齐/首行缩进/行距。
   */
  var WD_ALIGN_CENTER = 1;
  var WD_ALIGN_RIGHT = 2;
  var WD_ALIGN_JUSTIFY = 3;
  var WD_LINE_EXACTLY = 3;
  var FONT_FALLBACKS = {
    宋体: ["宋体", "SimSun"],
    黑体: ["黑体", "SimHei"],
    楷体: ["楷体", "楷体_GB2312", "KaiTi", "STKaiti"],
    仿宋: ["仿宋", "仿宋_GB2312", "FangSong", "STFangsong"]
  };

  function paraContentRange(para) {
    var r = para.Range;
    var a = r.Start;
    var b = r.End;
    var t = "";
    try {
      t = String(doc().Range(a, b).Text == null ? "" : doc().Range(a, b).Text);
    } catch (e0) {}
    /* 段标不能进 Font 范围，否则下一段排版被带走 */
    while (b > a && (t.charAt(t.length - 1) === "\r" || t.charAt(t.length - 1) === "\n")) {
      b -= 1;
      try {
        t = String(doc().Range(a, b).Text == null ? "" : doc().Range(a, b).Text);
      } catch (e1) {
        break;
      }
    }
    return doc().Range(a, b);
  }

  function setRunFont(font, family, sizePt, bold) {
    var list = FONT_FALLBACKS[family] || [family];
    var i;
    for (i = 0; i < list.length; i++) {
      try {
        font.Name = list[i];
        break;
      } catch (e1) {}
    }
    for (i = 0; i < list.length; i++) {
      try {
        font.NameFarEast = list[i];
        break;
      } catch (e2) {}
    }
    try {
      font.Size = sizePt;
    } catch (e3) {}
    try {
      font.Bold = bold ? 1 : 0;
    } catch (e4) {}
  }

  function applyGongwenPara(para, spec) {
    var pf = para.Format || para.ParagraphFormat;
    try {
      pf.LineSpacingRule = WD_LINE_EXACTLY;
      pf.LineSpacing = 30;
      pf.SpaceBefore = 0;
      pf.SpaceAfter = 0;
    } catch (eLs) {}
    try {
      pf.CharacterUnitFirstLineIndent =
        spec.indentChars != null ? spec.indentChars : 0;
    } catch (eInd) {
      try {
        pf.FirstLineIndent =
          (spec.indentChars || 0) > 0
            ? app().CentimetersToPoints(0.74)
            : 0;
      } catch (eInd2) {}
    }
    try {
      pf.Alignment = spec.align;
    } catch (eAl) {}
    try {
      var cr = paraContentRange(para);
      if (cr.Start >= cr.End) return;
      setRunFont(cr.Font, spec.font, spec.size, !!spec.bold);
    } catch (eF) {}
  }

  function applyPrefixBold(para, prefixLen) {
    if (!prefixLen || prefixLen < 1) return;
    try {
      var cr = paraContentRange(para);
      var a = cr.Start;
      var b = cr.End;
      if (b <= a) return;
      var mid = a + prefixLen;
      if (mid > b) mid = b;
      doc().Range(a, mid).Font.Bold = 1;
      if (b > mid) doc().Range(mid, b).Font.Bold = 0;
    } catch (e) {}
  }

  /**
   * 分类一行 md（与 md2docx 对齐）。skip=空行/--- 不落段。
   * 字体层级以 # 个数为准，不按「一、」「（一）」改判；井号错了是模型问题。
   */
  function classifyMdLine(line) {
    var t = String(line == null ? "" : line)
      .replace(/^\s+/, "")
      .replace(/\s+$/, "");
    if (!t || t === "---") return { kind: "skip" };

    var m;
    m = t.match(/^#\s+(.+)$/);
    if (m)
      return {
        kind: "h1",
        text: m[1],
        font: "宋体",
        size: 22,
        bold: true,
        align: WD_ALIGN_CENTER,
        indentChars: 0,
        blankAfter: true
      };
    m = t.match(/^##\s+(.+)$/);
    if (m)
      return {
        kind: "h2",
        text: m[1],
        font: "黑体",
        size: 16,
        bold: false,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };
    m = t.match(/^###\s+(.+)$/);
    if (m)
      return {
        kind: "h3",
        text: m[1],
        font: "楷体",
        size: 16,
        bold: true,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };
    m = t.match(/^####\s+(.+)$/);
    if (m)
      return {
        kind: "h4",
        text: m[1],
        font: "仿宋",
        size: 16,
        bold: true,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 0
      };
    m = t.match(/^\*（(.+)）\*$/);
    if (m)
      return {
        kind: "note",
        text: "（" + m[1] + "）",
        font: "仿宋",
        size: 16,
        bold: false,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 0
      };
    m = t.match(/^<div\s+align=["']right["']\s*>(.+)<\/div>$/i);
    if (m)
      return {
        kind: "right",
        text: m[1],
        font: "仿宋",
        size: 16,
        bold: false,
        align: WD_ALIGN_RIGHT,
        indentChars: 0
      };
    m = t.match(/^\*\*(.+?[。：])\*\*\s*(.+)$/);
    if (m)
      return {
        kind: "mix",
        text: m[1] + m[2],
        prefix: m[1],
        rest: m[2],
        font: "仿宋",
        size: 16,
        bold: false,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };
    m = t.match(/^\*\*(.+)\*\*$/);
    if (m)
      return {
        kind: "boldBody",
        text: m[1],
        font: "仿宋",
        size: 16,
        bold: true,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };

    /* 无井号时才按公文序号兜底：一、→一级；（一）→二级 */
    var gw = gongwenLevel(t);
    if (gw === 1)
      return {
        kind: "h2",
        text: t,
        font: "黑体",
        size: 16,
        bold: false,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };
    if (gw === 2)
      return {
        kind: "h3",
        text: t,
        font: "楷体",
        size: 16,
        bold: true,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 2
      };
    if (gw === 3)
      return {
        kind: "h4",
        text: t,
        font: "仿宋",
        size: 16,
        bold: true,
        align: WD_ALIGN_JUSTIFY,
        indentChars: 0
      };

    return {
      kind: "body",
      text: t,
      font: "仿宋",
      size: 16,
      bold: false,
      align: WD_ALIGN_JUSTIFY,
      indentChars: 2
    };
  }

  function splitWriteLines(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
  }

  /** 从当前选区起按 md 行写入并套公文格式（空行跳过，不落空段） */
  function typeLinesStyled(lines) {
    var s = selection();
    var wrote = 0;
    var i;
    for (i = 0; i < lines.length; i++) {
      var spec = classifyMdLine(lines[i]);
      if (spec.kind === "skip") continue;
      if (wrote > 0) {
        try {
          s.TypeParagraph();
        } catch (eP) {
          try {
            s.Text = String(s.Text || "") + "\r";
          } catch (eP2) {}
        }
      }
      if (spec.text) {
        try {
          s.TypeText(spec.text);
        } catch (eT) {
          try {
            s.Text = String(s.Text || "") + spec.text;
          } catch (eT2) {}
        }
      }
      try {
        var para = s.Paragraphs.Item(1);
        applyGongwenPara(para, spec);
        if (spec.kind === "mix") applyPrefixBold(para, (spec.prefix || "").length);
      } catch (eS) {}
      wrote++;
      if (spec.blankAfter) {
        try {
          s.TypeParagraph();
          applyGongwenPara(s.Paragraphs.Item(1), {
            font: "仿宋",
            size: 16,
            bold: false,
            align: WD_ALIGN_JUSTIFY,
            indentChars: 0
          });
        } catch (eBlank) {}
      }
    }
    return wrote;
  }

  function approxEqCm(points, cmTarget) {
    try {
      var one = app().CentimetersToPoints(1);
      if (!one) return false;
      return Math.abs(points / one - cmTarget) < 0.25;
    } catch (e) {
      return false;
    }
  }

  function marginsLookGongwen(ps) {
    try {
      return (
        approxEqCm(ps.TopMargin, 2.54) &&
        approxEqCm(ps.BottomMargin, 2.54) &&
        approxEqCm(ps.LeftMargin, 3.17) &&
        approxEqCm(ps.RightMargin, 3.17)
      );
    } catch (e) {
      return false;
    }
  }

  function footerHasPageNumber(footer) {
    try {
      if (footer.PageNumbers && footer.PageNumbers.Count > 0) return true;
    } catch (e1) {}
    try {
      var fields = footer.Range.Fields;
      var i;
      for (i = 1; i <= fields.Count; i++) {
        /* wdFieldPage = 33 */
        if (Number(fields.Item(i).Type) === 33) return true;
      }
    } catch (e2) {}
    return false;
  }

  /**
   * 文档级版式无感补齐：页边距 / 页码只在「还没有」时静默补一次，
   * 已符合规范则跳过，不打扰、不重复插入。
   */
  function ensureGongwenDocChrome() {
    var d = doc();
    var s = selection();
    var savedStart = null;
    var savedEnd = null;
    try {
      savedStart = s.Start;
      savedEnd = s.End;
    } catch (eSave) {}

    try {
      var ps = d.PageSetup;
      var cm = function (n) {
        return app().CentimetersToPoints(n);
      };
      if (!marginsLookGongwen(ps)) {
        try {
          ps.PageWidth = cm(21);
          ps.PageHeight = cm(29.7);
        } catch (eSz) {}
        try {
          ps.TopMargin = cm(2.54);
          ps.BottomMargin = cm(2.54);
          ps.LeftMargin = cm(3.17);
          ps.RightMargin = cm(3.17);
        } catch (eM) {}
      }
    } catch (ePs) {}

    try {
      var footer = d.Sections.Item(1).Footers.Item(1);
      if (!footerHasPageNumber(footer)) {
        try {
          footer.LinkToPrevious = false;
        } catch (eL) {}
        /* wdAlignPageNumberCenter = 1；FirstPage=true 首页也显示 */
        var pn = null;
        try {
          pn = footer.PageNumbers.Add(1, true);
        } catch (eAdd) {
          try {
            pn = footer.PageNumbers.Add(1);
          } catch (eAdd2) {}
        }
        try {
          if (pn && pn.Select) pn.Select();
          setRunFont(selection().Font, "宋体", 10.5, false);
        } catch (eFont) {
          try {
            setRunFont(footer.Range.Font, "宋体", 10.5, false);
            footer.Range.ParagraphFormat.Alignment = WD_ALIGN_CENTER;
          } catch (eFont2) {}
        }
      }
    } catch (ePn) {}

    try {
      if (savedStart != null && savedEnd != null) {
        selectRange(savedStart, savedEnd);
      }
    } catch (eRest) {}
  }

  /**
   * 光标处按公文规范插入（剥 Markdown，套字体/缩进/行距）。
   * 文档级页边距/页码：缺则无感补一次。
   */
  function insertAtCursor(text) {
    var s = selection();
    try {
      var ip = s.Start;
      s.SetRange(ip, ip);
    } catch (eCol) {}
    ensureGongwenDocChrome();
    typeLinesStyled(splitWriteLines(text));
    return true;
  }

  /**
   * 整篇按公文规范写入。调用前须已存版本且用户确认。
   * 文档级页边距/页码：缺则无感补一次；段落格式每次只套写入段。
   */
  function writeDocumentStyled(text) {
    var lines = splitWriteLines(text);
    var d = doc();
    var s = selection();
    try {
      s.WholeStory();
      s.Delete();
    } catch (eDel) {
      d.Content.Text = "";
    }
    try {
      s.HomeKey(6);
    } catch (eHome) {}
    ensureGongwenDocChrome();
    var n = typeLinesStyled(lines);
    return { ok: true, lines: n };
  }

  /** 纯文本落点：去掉 Markdown 标记，保留可见正文 */
  function mdToPlainLines(text) {
    return splitWriteLines(text)
      .map(function (ln) {
        var c = classifyMdLine(ln);
        return c.kind === "skip" ? null : c.text || "";
      })
      .filter(function (t) {
        return t != null && String(t).length > 0;
      })
      .join("\n");
  }

  function styleNameOf(p) {
    try {
      if (p.Style && p.Style.NameLocal) return String(p.Style.NameLocal);
    } catch (e) {}
    try {
      return String(p.Style || "");
    } catch (e2) {
      return "";
    }
  }

  /** 公文序号层级：一、=1；（一）=2；1.=2；等 */
  function gongwenLevel(text) {
    var t = String(text || "").replace(/^\s+/, "");
    if (/^[一二三四五六七八九十百千]+[、．.]/.test(t)) return 1;
    if (/^（[一二三四五六七八九十百千]+）/.test(t)) return 2;
    if (/^\([一二三四五六七八九十百千]+\)/.test(t)) return 2;
    if (/^\d+[、．.]/.test(t)) return 2;
    if (/^[（(]\d+[）)]/.test(t)) return 3;
    return 0;
  }

  function headingInfo(p) {
    if (!p) return { via: null, lvl: 0, text: "", outline: 10, style: "" };
    var tx = cleanText(p.Range.Text).replace(/\n/g, "");
    var outline = 10;
    try {
      outline = Number(p.OutlineLevel);
    } catch (e) {}
    var sn = styleNameOf(p);
    var via = null;
    var outLvl = 0;
    if (outline >= 1 && outline <= 9) {
      via = "outline";
      outLvl = outline;
    } else if (/标题\s*[1-9]|Heading\s*[1-9]/i.test(sn)) {
      via = "style";
      var m = sn.match(/([1-9])/);
      outLvl = m ? Number(m[1]) : 1;
    } else {
      var g = gongwenLevel(tx);
      if (g) {
        via = "gongwen";
        outLvl = g;
      }
    }
    return { via: via, lvl: outLvl, text: tx, outline: outline, style: sn };
  }

  function indexOfParagraph(p0) {
    if (!p0) return null;
    var paras = doc().Paragraphs;
    var n = paras.Count;
    var start0 = p0.Range.Start;
    for (var i = 1; i <= n; i++) {
      try {
        if (paras.Item(i).Range.Start === start0) return i;
      } catch (e) {}
    }
    return null;
  }

  /** 选中正文。WPS 侧栏点击后靠 Selection.Range.Select 重绘；Activate 放后面会冲掉选区。 */
  function selectRange(start, end) {
    var a = Number(start);
    var b = Number(end);
    if (!(b >= a)) b = a;
    var d = doc();
    try {
      d.Range(a, b).Select();
    } catch (e1) {}
    try {
      app().Selection.SetRange(a, b);
    } catch (e2) {}
    try {
      var rgSel = app().Selection.Range;
      if (rgSel && rgSel.Select) rgSel.Select();
    } catch (e3) {}
    try {
      var w = d.ActiveWindow;
      if (w && w.ScrollIntoView) w.ScrollIntoView(d.Range(a, b), true);
    } catch (e4) {}
  }

  function nthIndex(hay, needle, nth) {
    if (!needle) return -1;
    var from = 0;
    var want = Number(nth) || 0;
    var i = 0;
    while (true) {
      var p = String(hay).indexOf(needle, from);
      if (p < 0) return -1;
      if (i === want) return p;
      from = p + 1;
      i += 1;
    }
  }

  function needleWordRange(needle, nth, baseStart) {
    var n = String(needle || "").replace(/\n/g, "\r");
    if (!n.replace(/\s/g, "")) return null;
    var d = doc();
    var origin = baseStart != null ? Number(baseStart) : d.Content.Start;
    var hay = "";
    try {
      hay = String(d.Range(origin, d.Content.End).Text || "");
    } catch (e0) {
      hay = String(d.Content.Text || "");
      origin = d.Content.Start;
    }
    var hit = nthIndex(hay, n, nth);
    if (hit < 0) {
      hit = nthIndex(hay.replace(/\r/g, "\n"), n.replace(/\r/g, "\n"), nth);
    }
    if (hit < 0) return null;
    return { start: origin + hit, end: origin + hit + n.length };
  }

  var WD_NO_HIGHLIGHT = 0;
  var WD_YELLOW = 7;
  var SHADE_YELLOW = 13434879;
  var WD_COLOR_AUTO = -16777216;
  var WD_UNDEFINED = 9999999;
  var proofMarks = [];

  function shadeIsDirt(v) {
    v = Number(v);
    return v === 0 || v === SHADE_YELLOW;
  }

  function scrubRangeDirt(rg) {
    try {
      var h = Number(rg.HighlightColorIndex);
      if (h === WD_YELLOW) rg.HighlightColorIndex = WD_NO_HIGHLIGHT;
    } catch (eH) {}
    try {
      if (shadeIsDirt(rg.Shading.BackgroundPatternColor)) {
        rg.Shading.BackgroundPatternColor = WD_COLOR_AUTO;
      }
    } catch (eS) {}
    try {
      if (shadeIsDirt(rg.Font.Shading.BackgroundPatternColor)) {
        rg.Font.Shading.BackgroundPatternColor = WD_COLOR_AUTO;
      }
    } catch (eF) {}
  }

  function restoreMark(m) {
    if (!m) return;
    try {
      var rg = doc().Range(m.start, m.end);
      try {
        rg.HighlightColorIndex =
          m.prevHl == null ? WD_NO_HIGHLIGHT : m.prevHl;
      } catch (eH) {}
      scrubRangeDirt(rg);
    } catch (e) {}
  }

  /** 清校对误写的黄高亮 / 黑底纹。关窗经常跑不到，打开时也要扫一遍。 */
  function scrubProofDirt() {
    var d = doc();
    var paras = d.Paragraphs;
    var n = Number(paras.Count) || 0;
    var i;
    for (i = 1; i <= n; i++) {
      var p;
      try {
        p = paras.Item(i).Range;
      } catch (eP) {
        continue;
      }
      var mixed = false;
      try {
        var h = Number(p.HighlightColorIndex);
        if (h === WD_YELLOW) p.HighlightColorIndex = WD_NO_HIGHLIGHT;
        else if (h === WD_UNDEFINED || h < 0) mixed = true;
      } catch (eH) {
        mixed = true;
      }
      try {
        var s = Number(p.Font.Shading.BackgroundPatternColor);
        if (shadeIsDirt(s)) p.Font.Shading.BackgroundPatternColor = WD_COLOR_AUTO;
        else if (s === WD_UNDEFINED) mixed = true;
      } catch (eS) {
        mixed = true;
      }
      scrubRangeDirt(p);
      if (!mixed) continue;
      var words;
      try {
        words = p.Words;
      } catch (eW) {
        continue;
      }
      var wc = Number(words.Count) || 0;
      var k;
      for (k = 1; k <= wc; k++) {
        try {
          scrubRangeDirt(words.Item(k));
        } catch (eK) {}
      }
    }
  }

  function clearProofPaint() {
    var i;
    for (i = 0; i < proofMarks.length; i++) restoreMark(proofMarks[i]);
    proofMarks = [];
    try {
      scrubProofDirt();
    } catch (eScrub) {}
  }

  function rangeTextOf(start, end) {
    try {
      return String(doc().Range(start, end).Text || "");
    } catch (e) {
      return "";
    }
  }

  function clampToNeedle(start, needle) {
    var want = String(needle || "").replace(/\s/g, "");
    if (!want) return null;
    var d = doc();
    var a = Number(start);
    var b = a;
    var cap = a + Math.min(Math.max(want.length + 24, 16), 240);
    try {
      if (cap > d.Content.End) cap = d.Content.End;
    } catch (eC) {}
    while (b < cap) {
      b += 1;
      var got = rangeTextOf(a, b).replace(/\s/g, "");
      if (!got) continue;
      if (got === want || (got.length >= 2 && want.indexOf(got) === 0 && got.length >= want.length)) {
        return { start: a, end: b };
      }
      if (got.length > want.length + 2) {
        a += 1;
        if (a >= b) break;
      }
    }
    return null;
  }

  function tightRange(est, needle) {
    var n = String(needle || "");
    var a = Number(est && est.start);
    var b = Number(est && est.end);
    var want = n.replace(/\s/g, "");
    var cap = Math.min(Math.max(want.length + 16, 24), 240);
    var got = rangeTextOf(a, b).replace(/\s/g, "");
    if (b > a && got && got.length <= want.length + 4 && (got === want || want.indexOf(got) >= 0 || got.indexOf(want) >= 0)) {
      if (b - a <= cap) return { start: a, end: b };
    }
    return clampToNeedle(a, n) || clampToNeedle(a - 2, n);
  }

  /** 只滚动到 Find 命中处，不改高亮/底纹（改格式关窗清不掉）。 */
  function revealFindHit() {
    try {
      doc().ActiveWindow.ScrollIntoView(selection().Range, true);
    } catch (e3) {}
  }

  /** 文档 Range 坐标 → 与 getDocumentText 同一套字符串长度（校对跟选区用） */
  function rangeTextLen(start, end) {
    start = Number(start);
    end = Number(end);
    if (!(end > start)) return 0;
    try {
      return cleanText(doc().Range(start, end).Text).length;
    } catch (e) {
      return 0;
    }
  }

  /** 选中 Range，不改高亮/格式 */
  function highlightRange(start, end) {
    var c = shrinkToContentRange(start, end);
    selectRange(c.start, c.end);
  }

  function proofFollowPos(base) {
    base = Number(base) || 0;
    var s = selection();
    var caret = Number(s.Start);
    var end = Number(s.End);
    if (end > caret) caret = Math.round((caret + end) / 2);
    var p = doc().Range(caret, caret).Paragraphs.Item(1).Range;
    var ps = Number(p.Start);
    var pe = Number(p.End);
    return {
      rel: caret > base ? rangeTextLen(base, caret) : 0,
      paraStart: ps > base ? rangeTextLen(base, ps) : 0,
      paraEnd: pe > base ? rangeTextLen(base, pe) : 0
    };
  }

  function clearPaint() {
    /* 不再涂黄/清黄，避免改用户文稿格式 */
  }

  function paraSelectBounds(p) {
    return shrinkToContentRange(p.Range.Start, p.Range.End);
  }

  /**
   * 父级下全部同级标题下标（对标 editor findHeadingGroup）
   * 点「一、」→ 全部一级；点某「一、」下的「（一）」→ 该一级下全部「（一）（二）…」
   */
  function findSiblingHeadingIndices(anchorIdx) {
    var paras = doc().Paragraphs;
    var n = paras.Count;
    if (!anchorIdx || anchorIdx < 1 || anchorIdx > n) return [];
    var h0 = headingInfo(paras.Item(anchorIdx));
    if (!h0.via) return [];
    var level = h0.lvl;
    var parentIdx = 0;
    var parentLevel = 0;
    for (var i = anchorIdx - 1; i >= 1; i--) {
      var hi = headingInfo(paras.Item(i));
      if (hi.via && hi.lvl < level) {
        parentIdx = i;
        parentLevel = hi.lvl;
        break;
      }
    }
    var start = parentIdx ? parentIdx + 1 : 1;
    var indices = [];
    for (var j = start; j <= n; j++) {
      var hj = headingInfo(paras.Item(j));
      if (parentLevel && hj.via && hj.lvl <= parentLevel) break;
      if (!parentLevel && hj.via && hj.lvl < level) break;
      if (hj.via && hj.lvl === level) indices.push(j);
    }
    return indices.length ? indices : [anchorIdx];
  }

  /** 扩展为当前光标/选区所在段落整段 */
  function selectCurrentParagraph() {
    var s = selection();
    var p = s.Paragraphs.Item(1);
    var bounds = paraSelectBounds(p);
    selectRange(bounds.start, bounds.end);
    return getSelectionInfo();
  }

  /** 列出全文标题（调试用） */
  function listHeadings(maxScan) {
    var paras = doc().Paragraphs;
    var n = paras.Count;
    var limit = Math.min(n, maxScan || 400);
    var heads = [];
    for (var i = 1; i <= limit; i++) {
      var h = headingInfo(paras.Item(i));
      if (h.via) {
        heads.push({
          index: i,
          lvl: h.lvl,
          via: h.via,
          text: h.text.slice(0, 80),
          start: paras.Item(i).Range.Start,
          end: paras.Item(i).Range.End
        });
      }
    }
    return heads;
  }

  /** 列出光标所在标题的同级（不含下级） */
  function listSiblingHeadings() {
    var s = selection();
    var p0 = s.Paragraphs.Item(1);
    var h0 = headingInfo(p0);
    if (!h0.via) {
      throw new Error("光标不在标题上（可用「一、」「（一）」或标题样式）");
    }
    var startIdx = indexOfParagraph(p0);
    if (!startIdx) throw new Error("找不到当前段落");
    var indices = findSiblingHeadingIndices(startIdx);
    var paras = doc().Paragraphs;
    return indices.map(function (i) {
      var h = headingInfo(paras.Item(i));
      return {
        index: i,
        lvl: h.lvl,
        via: h.via,
        text: h.text.slice(0, 80),
        start: paras.Item(i).Range.Start,
        end: paras.Item(i).Range.End
      };
    });
  }

  /**
   * 选中「当前标题下正文」（不含标题行，直到同级或更高级标题前）
   * 光标须在标题段，或选区落在标题段。
   */
  function selectHeadingBody() {
    var s = selection();
    var p0 = s.Paragraphs.Item(1);
    var h0 = headingInfo(p0);
    if (!h0.via) {
      throw new Error(
        "光标不在标题上（可用「一、」「（一）」或标题样式）。OutlineLevel=" +
          h0.outline
      );
    }
    var startIdx = indexOfParagraph(p0);
    if (!startIdx) throw new Error("找不到当前段落");
    var paras = doc().Paragraphs;
    var n = paras.Count;
    var endIdx = startIdx;
    for (var j = startIdx + 1; j <= n; j++) {
      var hj = headingInfo(paras.Item(j));
      if (hj.via && hj.lvl <= h0.lvl) break;
      endIdx = j;
    }
    if (endIdx === startIdx) throw new Error("该标题下没有正文段");
    var c = shrinkToContentRange(
      paras.Item(startIdx + 1).Range.Start,
      paras.Item(endIdx).Range.End
    );
    selectRange(c.start, c.end);
    return {
      heading: h0,
      from: startIdx + 1,
      to: endIdx,
      text: getSelectionText(),
      start: c.start,
      end: c.end,
      endsWithPara: true,
      info: getSelectionInfo()
    };
  }

  /**
   * 钉在标题上写下级：有下属内容则覆盖下属（不动标题行）；无下属则在标题后插入。
   * 避免「选定」把一级黑体一并盖成楷体/宋体。
   */
  function writeUnderCurrentHeading(text) {
    ensureGongwenDocChrome();
    var s = selection();
    var p0 = s.Paragraphs.Item(1);
    var h0 = headingInfo(p0);
    if (!h0.via) throw new Error("光标不在标题上");
    var startIdx = indexOfParagraph(p0);
    if (!startIdx) throw new Error("找不到当前段落");
    var paras = doc().Paragraphs;
    var n = paras.Count;
    var endIdx = startIdx;
    var j;
    for (j = startIdx + 1; j <= n; j++) {
      var hj = headingInfo(paras.Item(j));
      if (hj.via && hj.lvl <= h0.lvl) break;
      endIdx = j;
    }
    if (endIdx > startIdx) {
      var c = shrinkToContentRange(
        paras.Item(startIdx + 1).Range.Start,
        paras.Item(endIdx).Range.End
      );
      selectRange(c.start, c.end);
      return replaceSelection(text);
    }
    var ins = paras.Item(startIdx).Range.End;
    selectRange(ins, ins);
    try {
      s.TypeParagraph();
    } catch (eP) {}
    typeLinesStyled(splitWriteLines(text));
    return true;
  }

  /**
   * 选中「同级标题」= 父级下全部同级标题行（不含下级标题、不含中间正文）
   * 对标 editor；选中态只记入侧栏 work，不改正文格式。
   */
  function selectSiblingHeadings() {
    var s = selection();
    var p0 = s.Paragraphs.Item(1);
    var h0 = headingInfo(p0);
    if (!h0.via) throw new Error("光标不在标题上");
    var startIdx = indexOfParagraph(p0);
    if (!startIdx) throw new Error("找不到当前段落");
    return selectSiblingHeadingsByIndex(startIdx);
  }

  function selectSiblingHeadingsByIndex(paraIndex) {
    var paras = doc().Paragraphs;
    var indices = findSiblingHeadingIndices(paraIndex);
    if (!indices.length) throw new Error("未找到同级标题");
    var h0 = headingInfo(paras.Item(paraIndex));
    var texts = [];
    var first = null;
    var last = null;
    for (var k = 0; k < indices.length; k++) {
      var p = paras.Item(indices[k]);
      var h = headingInfo(p);
      var bounds = paraSelectBounds(p);
      texts.push(h.text.replace(/\s+$/, ""));
      if (!first) first = bounds;
      last = bounds;
    }
    selectRange(first.start, first.end);
    return {
      heading: h0,
      items: indices.map(function (i) {
        var hh = headingInfo(paras.Item(i));
        var bb = paraSelectBounds(paras.Item(i));
        return {
          index: i,
          lvl: hh.lvl,
          via: hh.via,
          text: hh.text.replace(/\s+$/, ""),
          start: bb.start,
          end: bb.end
        };
      }),
      text: texts.join("\n\n"),
      start: first.start,
      end: last.end,
      from: indices[0],
      to: indices[indices.length - 1],
      count: indices.length
    };
  }

  /** 按段落序号取当前标题行全文（精修写回前刷新） */
  function headingTextsByIndices(indices) {
    var paras = doc().Paragraphs;
    var n = paras.Count;
    return (indices || []).map(function (idx) {
      if (!idx || idx < 1 || idx > n) throw new Error("标题锚点已失效，请重新扩选钉住");
      var h = headingInfo(paras.Item(idx));
      if (!h.via) throw new Error("段落已不是标题，请重新扩选钉住");
      return h.text.replace(/\s+$/, "");
    });
  }

  /**
   * 同级多标题逐条写回：自后向前替换，避免段落序号漂移。
   * indices / texts 一一对应；返回包围首末条的 start/end。
   */
  function replaceSiblingHeadings(indices, texts) {
    var list = indices || [];
    var rows = texts || [];
    if (!list.length || list.length !== rows.length) {
      throw new Error("同级标题条数与方案不一致，请重新出方案");
    }
    var pairs = list.map(function (idx, i) {
      return { idx: idx, text: String(rows[i] == null ? "" : rows[i]) };
    });
    pairs.sort(function (a, b) {
      return b.idx - a.idx;
    });
    var paras = doc().Paragraphs;
    var n = paras.Count;
    for (var k = 0; k < pairs.length; k++) {
      var idx = pairs[k].idx;
      if (!idx || idx < 1 || idx > n) {
        throw new Error("标题锚点已失效，请重新扩选钉住");
      }
      var bounds = paraSelectBounds(paras.Item(idx));
      replaceRange(bounds.start, bounds.end, pairs[k].text);
    }
    var first = paraSelectBounds(paras.Item(list[0]));
    var last = paraSelectBounds(paras.Item(list[list.length - 1]));
    try {
      selectRange(first.start, last.end);
    } catch (eSel) {}
    return {
      start: first.start,
      end: last.end,
      text: rows.join("\n\n"),
      count: list.length
    };
  }

  /** 只选中某一个标题行（列表点选） */
  function selectHeadingLineByIndex(paraIndex) {
    var paras = doc().Paragraphs;
    var p = paras.Item(paraIndex);
    var h = headingInfo(p);
    if (!h.via) throw new Error("该段不是标题");
    var bounds = paraSelectBounds(p);
    selectRange(bounds.start, bounds.end);
    return {
      heading: h,
      items: [{ index: paraIndex, lvl: h.lvl, via: h.via, text: h.text.slice(0, 120) }],
      text: h.text.replace(/\s+$/, ""),
      start: bounds.start,
      end: bounds.end,
      from: paraIndex,
      to: paraIndex,
      count: 1
    };
  }

  /** @deprecated 旧「本节整块」；保留给调试，UI 不再用 */
  function selectHeadingBlock() {
    return selectSiblingHeadings();
  }

  function selectHeadingBlockByIndex(paraIndex) {
    return selectHeadingLineByIndex(paraIndex);
  }

  function findNeedle(s) {
    return String(s || "")
      .replace(/\r/g, "\n")
      .split("\n")[0]
      .trim()
      .slice(0, 80);
  }

  function findAndHighlight(needle) {
    var n = String(needle || "").replace(/\r/g, "").trim();
    if (!n) throw new Error("无定位原文");
    n = n.slice(0, 80);
    var s = selection();
    s.HomeKey(6);
    var hit = false;
    try {
      hit = s.Find.Execute(n);
    } catch (e1) {
      try {
        s.Find.Text = n;
        hit = s.Find.Execute();
      } catch (e2) {
        throw new Error("Find 失败: " + e2);
      }
    }
    if (!hit) {
      var got = String(s.Text || "").replace(/\r/g, "");
      if (!(got && n && got.indexOf(n.slice(0, Math.min(n.length, 4))) >= 0)) {
        throw new Error("未找到: " + n.slice(0, 40));
      }
    }
    return true;
  }

  function findNth(needle, nth) {
    var want = Number(nth) || 0;
    if (want <= 0) {
      findAndHighlight(needle);
      return true;
    }
    var n = String(needle || "").replace(/\r/g, "").trim();
    if (!n) throw new Error("无定位原文");
    n = n.slice(0, 80);
    var s = selection();
    s.HomeKey(6);
    var i = 0;
    while (i <= want) {
      var hit = false;
      try {
        hit = s.Find.Execute(n);
      } catch (e1) {
        try {
          s.Find.Text = n;
          hit = s.Find.Execute();
        } catch (e2) {
          throw new Error("Find 失败: " + e2);
        }
      }
      if (!hit) throw new Error("未找到: " + n.slice(0, 40));
      if (i === want) return true;
      try {
        s.Collapse(0);
      } catch (eC) {}
      i += 1;
    }
    return true;
  }

  function proofFindProbe(original, snap, start) {
    var o = String(original || "").replace(/\r/g, "\n");
    if (o.replace(/\s/g, "").length <= 40) return o;
    snap = String(snap || "");
    start = Number(start);
    if (snap && start >= 0) {
      var a = Math.max(0, start - 12);
      var b = Math.min(snap.length, start + Math.min(o.length, 40) + 12);
      var slice = snap.slice(a, b);
      if (slice.replace(/\s/g, "").length >= 8) return slice;
    }
    var mid = Math.floor(o.length / 3);
    return o.slice(mid, mid + 40);
  }

  function countBefore(hay, needle, pos) {
    if (!needle) return 0;
    var n = 0;
    var idx = 0;
    var chunk = String(hay || "").slice(0, Math.max(0, pos));
    while (idx < chunk.length) {
      var p = chunk.indexOf(needle, idx);
      if (p < 0) break;
      n += 1;
      idx = p + 1;
    }
    return n;
  }

  function locateProofSpan(opts) {
    opts = opts || {};
    findNth(opts.original, Number(opts.nth) || 0);
    revealFindHit();
    return { start: selection().Start, end: selection().End };
  }

  function applyProofSpan(opts, suggestion) {
    clearProofPaint();
    findNth(opts.original, Number(opts.nth) || 0);
    selection().Text = String(suggestion == null ? "" : suggestion);
  }

  function applySuggestion(original, suggestion) {
    findAndHighlight(original);
    selection().Text = String(suggestion == null ? "" : suggestion);
  }

  global.GwDoc = {
    getSelectionText: getSelectionText,
    getSelectionInfo: getSelectionInfo,
    rangeTextLen: rangeTextLen,
    proofFollowPos: proofFollowPos,
    selectRange: selectRange,
    clearPaint: clearPaint,
    clearProofPaint: clearProofPaint,
    scrubProofDirt: scrubProofDirt,
    highlightRange: highlightRange,
    replaceSelection: replaceSelection,
    replaceRange: replaceRange,
    getDocumentText: getDocumentText,
    contentStart: contentStart,
    setDocumentText: setDocumentText,
    insertAtCursor: insertAtCursor,
    writeDocumentStyled: writeDocumentStyled,
    gongwenLevel: gongwenLevel,
    selectCurrentParagraph: selectCurrentParagraph,
    listHeadings: listHeadings,
    listSiblingHeadings: listSiblingHeadings,
    selectHeadingBody: selectHeadingBody,
    writeUnderCurrentHeading: writeUnderCurrentHeading,
    selectHeadingSection: selectHeadingSection,
    selectSiblingHeadings: selectSiblingHeadings,
    selectSiblingHeadingsByIndex: selectSiblingHeadingsByIndex,
    replaceSiblingHeadings: replaceSiblingHeadings,
    headingTextsByIndices: headingTextsByIndices,
    selectHeadingLineByIndex: selectHeadingLineByIndex,
    selectHeadingBlock: selectHeadingBlock,
    selectHeadingBlockByIndex: selectHeadingBlockByIndex,
    headingInfo: headingInfo,
    findAndHighlight: findAndHighlight,
    locateProofSpan: locateProofSpan,
    applyProofSpan: applyProofSpan,
    applySuggestion: applySuggestion
  };
})(window);
