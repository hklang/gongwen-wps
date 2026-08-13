/**
 * 本机材料工具：list_files / read_file / search_materials（工程根沙箱）
 */
(function (global) {
  var MAX_READ = 12000;
  var MAX_SEARCH_HITS = 5;
  var MAX_HIT_CHARS = 800;
  /** 单块传输硬顶（非内容裁判）；超出标明 truncated */
  var TRANSPORT_HARD_CAP = 100000;
  var _contextBag = null;

  function setContextBag(bag) {
    _contextBag = bag && typeof bag === "object" ? bag : null;
  }

  function clipTransport(text, key) {
    var s = String(text || "");
    if (s.length <= TRANSPORT_HARD_CAP) {
      return { ok: true, key: key, chars: s.length, text: s, truncated: false };
    }
    return {
      ok: true,
      key: key,
      chars: s.length,
      text: s.slice(0, TRANSPORT_HARD_CAP),
      truncated: true,
      note: "仅达传输硬顶，已截断；非宿主内容取舍"
    };
  }

  function fetch_context(keys) {
    var list = [];
    if (Array.isArray(keys)) list = keys;
    else if (keys && typeof keys === "object") {
      if (Array.isArray(keys.keys)) list = keys.keys;
      else if (keys.key) list = [keys.key];
    }
    if (!list.length) {
      return {
        ok: false,
        error: "缺少 keys（pin|base_draft|task_card|history|doc_full）"
      };
    }
    var bag = _contextBag || {};
    var out = { ok: true, items: [] };
    list.forEach(function (raw) {
      var k = String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/-/g, "_");
      if (k === "pin" || k === "pinned") {
        out.items.push(clipTransport(bag.pin || "", "pin"));
      } else if (k === "base_draft" || k === "draft" || k === "basedraft") {
        out.items.push(clipTransport(bag.base_draft || bag.baseDraft || "", "base_draft"));
      } else if (k === "task_card" || k === "taskcard") {
        out.items.push({
          ok: true,
          key: "task_card",
          text: String(bag.task_card || bag.taskCard || ""),
          chars: String(bag.task_card || bag.taskCard || "").length
        });
      } else if (k === "history") {
        var h = bag.history;
        var ht =
          typeof h === "string"
            ? h
            : JSON.stringify(h || [], null, 0);
        out.items.push(clipTransport(ht, "history"));
      } else if (k === "doc_full" || k === "doc" || k === "document") {
        out.items.push(clipTransport(bag.doc_full || bag.docMd || "", "doc_full"));
      } else {
        out.items.push({ ok: false, key: k, error: "未知 key" });
      }
    });
    return out;
  }

  function resolveSafe(rel) {
    var root = GwProject.getRoot();
    if (!root) throw new Error("无工程根");
    var relNorm = GwProject.normRel(rel);
    if (!relNorm || relNorm.indexOf("..") >= 0) throw new Error("非法路径");
    var abs = GwProject.joinRoot(root, relNorm);
    var rootNorm = String(root).replace(/[\\\/]+$/, "").toLowerCase();
    var absNorm = String(abs).replace(/[\\\/]+$/, "").toLowerCase();
    if (absNorm !== rootNorm && absNorm.indexOf(rootNorm + "\\") !== 0) {
      throw new Error("路径越出工程根");
    }
    return { abs: abs, rel: relNorm, root: root };
  }

  function list_files() {
    var ws =
      global.GwMaterialIndex && GwMaterialIndex.workspaceForAi
        ? GwMaterialIndex.workspaceForAi()
        : null;
    if (ws && ws.catalog && ws.catalog.length) {
      return {
        ok: true,
        root: ws.root,
        name: ws.name,
        items: ws.catalog,
        materials: (ws.materials || []).map(function (m) {
          return {
            path: m.path,
            title: m.title,
            summary: m.summary,
            zone: "materials"
          };
        }),
        templates: (ws.templates || []).map(function (m) {
          return {
            path: m.path,
            title: m.title,
            summary: m.summary,
            zone: "templates"
          };
        })
      };
    }
    var listed = GwProject.listProjectFiles();
    if (!listed.ok) {
      return { ok: false, error: "无法列出", items: [] };
    }
    var items = []
      .concat(listed.materials || [])
      .concat(listed.templates || [])
      .map(function (it) {
        var p = String(it.path || "");
        return {
          path: p,
          title: it.title,
          zone: p.indexOf("模板/") === 0 ? "templates" : "materials",
          bytes: it.size || 0
        };
      });
    return {
      ok: true,
      root: listed.root,
      name: listed.name,
      items: items
    };
  }

  function read_file(rel, maxChars) {
    var safe;
    try {
      safe = resolveSafe(rel);
    } catch (e) {
      return { ok: false, error: String(e.message || e), path: rel };
    }
    var lim = Math.min(Math.max(Number(maxChars) || MAX_READ, 200), 40000);
    var rd = GwProject.readTextRel(safe.rel);
    if (!rd.ok) {
      return { ok: false, error: rd.error || "读失败", path: safe.rel };
    }
    var text = String(rd.text || "");
    var truncated = text.length > lim;
    return {
      ok: true,
      path: safe.rel,
      title: GwProject.titleOf(GwProject.baseName(safe.rel)),
      truncated: truncated,
      text: truncated ? text.slice(0, lim) : text,
      via: rd.via,
      readAt: new Date().toISOString()
    };
  }

  function search_materials(query) {
    var q = String(query || "").trim();
    if (!q) return { ok: false, error: "缺少检索词", hits: [] };
    var qLower = q.toLowerCase();
    var hits = [];
    var ws =
      global.GwMaterialIndex && GwMaterialIndex.workspaceForAi
        ? GwMaterialIndex.workspaceForAi()
        : { materials: [] };
    var pool = (ws.materials || []).slice();
    for (var i = 0; i < pool.length && hits.length < MAX_SEARCH_HITS; i++) {
      var it = pool[i];
      var nameHit =
        String(it.path || "")
          .toLowerCase()
          .indexOf(qLower) >= 0 ||
        String(it.title || "")
          .toLowerCase()
          .indexOf(qLower) >= 0;
      var sum = String(it.summary || "");
      var idx = sum.toLowerCase().indexOf(qLower);
      if (!nameHit && idx < 0) {
        var rd = read_file(it.path, 8000);
        if (!rd.ok) continue;
        sum = rd.text || "";
        idx = sum.toLowerCase().indexOf(qLower);
        if (idx < 0 && !nameHit) continue;
      }
      var snippet;
      if (idx >= 0) {
        var start = Math.max(0, idx - 80);
        snippet = sum.slice(start, start + MAX_HIT_CHARS);
      } else {
        snippet = sum.slice(0, Math.min(400, MAX_HIT_CHARS));
      }
      hits.push({ path: it.path, title: it.title, snippet: snippet });
    }
    return { ok: true, query: q, hits: hits };
  }

  function executeTool(name, args) {
    var n = String(name || "").trim();
    var a = args && typeof args === "object" ? args : {};
    try {
      if (n === "list_files") return { name: n, result: list_files() };
      if (n === "read_file") {
        return {
          name: n,
          result: read_file(a.path || a.rel || "", a.max_chars || a.maxChars)
        };
      }
      if (n === "search_materials") {
        return {
          name: n,
          result: search_materials(a.query || a.q || "")
        };
      }
      if (n === "fetch_context") {
        return {
          name: n,
          result: fetch_context(a.keys || a.key || a)
        };
      }
      return { name: n, result: { ok: false, error: "未知工具：" + n } };
    } catch (e) {
      return {
        name: n,
        result: { ok: false, error: String(e.message || e) }
      };
    }
  }

  function parseAgentPayload(raw, jsonHint) {
    if (
      jsonHint &&
      (jsonHint.type === "tool_calls" ||
        Array.isArray(jsonHint.tool_calls) ||
        Array.isArray(jsonHint.calls))
    ) {
      var list0 = jsonHint.tool_calls || jsonHint.calls || [];
      return {
        kind: "tools",
        tool_calls: list0.map(function (c, idx) {
          return {
            id: String((c && c.id) || "call_" + idx),
            name: String((c && (c.name || c.tool)) || ""),
            arguments: (c && (c.arguments || c.args)) || {}
          };
        })
      };
    }
    var s = String(raw || "").trim();
    if (!s) return { kind: "final", reply: "", tool_calls: null };
    var fence = /^```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    var obj = null;
    try {
      obj = JSON.parse(s);
    } catch (e1) {
      var i = s.indexOf("{");
      var j = s.lastIndexOf("}");
      if (i >= 0 && j > i) {
        try {
          obj = JSON.parse(s.slice(i, j + 1));
        } catch (e2) {
          obj = null;
        }
      }
    }
    if (!obj || typeof obj !== "object") {
      return { kind: "final", reply: String(raw || "").trim(), tool_calls: null };
    }
    if (
      obj.type === "tool_calls" ||
      obj.type === "tools" ||
      Array.isArray(obj.tool_calls) ||
      Array.isArray(obj.calls)
    ) {
      var list = obj.tool_calls || obj.calls || [];
      return {
        kind: "tools",
        tool_calls: list.map(function (c, idx) {
          return {
            id: String((c && c.id) || "call_" + idx),
            name: String((c && (c.name || c.tool)) || ""),
            arguments: (c && (c.arguments || c.args)) || {}
          };
        })
      };
    }
    if (Array.isArray(obj.need_files)) {
      return {
        kind: "tools",
        tool_calls: obj.need_files.map(function (p, idx) {
          return {
            id: "need_" + idx,
            name: "read_file",
            arguments: { path: p }
          };
        })
      };
    }
    if (obj.type === "ready" || obj.ready === true) {
      return {
        kind: "ready",
        reply: String(obj.reply || obj.message || "资料已齐").trim(),
        tool_calls: null
      };
    }
    return {
      kind: "final",
      reply: String(obj.reply || obj.message || obj.content || raw || "").trim(),
      tool_calls: null,
      edit: obj.edit || null,
      options: Array.isArray(obj.options) ? obj.options : null
    };
  }

  function hasUsableReads(toolResults) {
    var ok = false;
    (toolResults || []).forEach(function (tr) {
      if (
        tr &&
        tr.name === "read_file" &&
        tr.result &&
        tr.result.ok &&
        String(tr.result.text || "").replace(/\s/g, "").length >= 40
      ) {
        ok = true;
      }
    });
    return ok;
  }

  function shortName(p) {
    var s = String(p || "").replace(/\\/g, "/");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  global.GwMaterialTools = {
    list_files: list_files,
    read_file: read_file,
    search_materials: search_materials,
    fetch_context: fetch_context,
    setContextBag: setContextBag,
    executeTool: executeTool,
    parseAgentPayload: parseAgentPayload,
    hasUsableReads: hasUsableReads,
    shortName: shortName
  };
})(window);
