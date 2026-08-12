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
   * 写回选区。Word/WPS 段标记是 \r；若原选区含段末 \r 而新稿没有，
   * 会吞掉回车、与下一段粘连——必须保留。
   */
  function replaceSelection(text, opts) {
    opts = opts || {};
    var s = selection();
    var raw = String(s.Text == null ? "" : s.Text);
    var cur = cleanText(raw);
    if (!cur.replace(/\s/g, "")) throw new Error("请先划选要改的正文");
    var endedWithPara =
      opts.endsWithPara != null
        ? !!opts.endsWithPara
        : /\r$/.test(raw) || /\n$/.test(cur);
    s.Text = toWordText(text, endedWithPara);
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
    var d = doc();
    var rng = d.Range(start, end);
    var raw = String(rng.Text == null ? "" : rng.Text);
    var cur = cleanText(raw);
    if (!cur.replace(/\s/g, "") && !opts.allowEmpty) {
      throw new Error("选区锚点已失效，请重新钉住后再试");
    }
    var endedWithPara =
      opts.endsWithPara != null
        ? !!opts.endsWithPara
        : /\r$/.test(raw) || /\n$/.test(cur);
    var out = toWordText(text, endedWithPara);
    rng.Text = out;
    var ns = rng.Start;
    var ne = rng.End;
    try {
      selectRange(ns, ne);
    } catch (eSel) {}
    return { start: ns, end: ne, text: cleanText(out), endsWithPara: endedWithPara };
  }

  function getDocumentText() {
    return cleanText(doc().Content.Text);
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

  function trySetParaStyle(para, names) {
    var i;
    for (i = 0; i < names.length; i++) {
      try {
        para.Style = names[i];
        return names[i];
      } catch (e) {}
    }
    return "";
  }

  function styleNamesForLevel(lvl) {
    if (lvl === 1) return ["标题 1", "标题1", "Heading 1", "Heading1"];
    if (lvl === 2) return ["标题 2", "标题2", "Heading 2", "Heading2"];
    if (lvl === 3) return ["标题 3", "标题3", "Heading 3", "Heading3"];
    return ["正文", "Normal", "本文"];
  }

  /**
   * 光标处插入多段文本（保留周围既有样式意图；新段按公文序号尝试套标题）。
   */
  function insertAtCursor(text) {
    var s = selection();
    var lines = String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    var i;
    for (i = 0; i < lines.length; i++) {
      if (i > 0) {
        try {
          s.TypeParagraph();
        } catch (eP) {
          s.Text = s.Text + "\r";
        }
      }
      var line = lines[i];
      if (line) {
        try {
          s.TypeText(line);
        } catch (eT) {
          s.Text = String(s.Text || "") + line;
        }
      }
      try {
        var para = s.Paragraphs.Item(1);
        var lvl = gongwenLevel(line);
        if (lvl > 0) trySetParaStyle(para, styleNamesForLevel(lvl));
      } catch (eS) {}
    }
    return true;
  }

  /**
   * 整篇按行写入并尝试套标题样式。调用前须已存版本且用户确认。
   */
  function writeDocumentStyled(text) {
    var lines = String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    while (lines.length && !String(lines[lines.length - 1] || "").replace(/\s/g, "")) {
      lines.pop();
    }
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
    var i;
    for (i = 0; i < lines.length; i++) {
      if (i > 0) {
        try {
          s.TypeParagraph();
        } catch (eP2) {}
      }
      var line = lines[i];
      if (line) {
        try {
          s.TypeText(line);
        } catch (eT2) {
          s.Text = String(s.Text || "") + line;
        }
      }
      try {
        var para = s.Paragraphs.Item(1);
        trySetParaStyle(para, styleNamesForLevel(gongwenLevel(line)));
      } catch (eSt) {}
    }
    return { ok: true, lines: lines.length };
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

  function selectRange(start, end) {
    var s = selection();
    s.SetRange(start, end);
  }

  /** 仅 SetRange，不改高亮/格式（选中态只在侧栏展示） */
  function highlightRange(start, end) {
    var a = start;
    var b = end;
    try {
      if (b > a + 1) b = b - 1;
    } catch (e) {}
    selectRange(a, b);
  }

  function clearPaint() {
    /* 不再涂黄/清黄，避免改用户文稿格式 */
  }

  function paraSelectBounds(p) {
    var a = p.Range.Start;
    var b = p.Range.End;
    try {
      if (b > a + 1) b = b - 1;
    } catch (e) {}
    return { start: a, end: b };
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
    var a = paras.Item(startIdx + 1).Range.Start;
    var b = paras.Item(endIdx).Range.End;
    try {
      if (b > a + 1) b = b - 1;
    } catch (e) {}
    selectRange(a, b);
    return {
      heading: h0,
      from: startIdx + 1,
      to: endIdx,
      text: getSelectionText(),
      start: a,
      end: b,
      info: getSelectionInfo()
    };
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
        return {
          index: i,
          lvl: hh.lvl,
          via: hh.via,
          text: hh.text.slice(0, 120)
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
    if (!hit) throw new Error("未找到: " + n.slice(0, 40));
    /* 只定位选区，不涂色改格式 */
    return true;
  }

  function applySuggestion(original, suggestion) {
    findAndHighlight(original);
    selection().Text = String(suggestion == null ? "" : suggestion);
  }

  global.GwDoc = {
    getSelectionText: getSelectionText,
    getSelectionInfo: getSelectionInfo,
    selectRange: selectRange,
    clearPaint: clearPaint,
    highlightRange: highlightRange,
    replaceSelection: replaceSelection,
    replaceRange: replaceRange,
    getDocumentText: getDocumentText,
    setDocumentText: setDocumentText,
    insertAtCursor: insertAtCursor,
    writeDocumentStyled: writeDocumentStyled,
    gongwenLevel: gongwenLevel,
    selectCurrentParagraph: selectCurrentParagraph,
    listHeadings: listHeadings,
    listSiblingHeadings: listSiblingHeadings,
    selectHeadingBody: selectHeadingBody,
    selectSiblingHeadings: selectSiblingHeadings,
    selectSiblingHeadingsByIndex: selectSiblingHeadingsByIndex,
    selectHeadingLineByIndex: selectHeadingLineByIndex,
    selectHeadingBlock: selectHeadingBlock,
    selectHeadingBlockByIndex: selectHeadingBlockByIndex,
    headingInfo: headingInfo,
    findAndHighlight: findAndHighlight,
    applySuggestion: applySuggestion
  };
})(window);
