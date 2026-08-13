/**
 * 对话工具环：发送前增量索引 → 多轮 tool_calls → 本机执行 → 再请求中转
 * 是否精读、读哪些：交给模型；宿主不按用户口令做意图白名单拦截。
 */
(function (global) {
  var MAX_ROUNDS = 4;

  function scrubFalseMaterialClaims(reply) {
    var t = String(reply || "");
    if (!t) return t;
    t = t.replace(
      /三组均据[^。\n]{0,30}材料落稿[^。\n]{0,40}[。.]?/g,
      "本轮未带上素材正文，组内数字仅能标【待核实】，请先引用或放入「素材/」。"
    );
    t = t.replace(/均?据[^。\n]{0,24}材料落稿/g, "在未精读素材正文的前提下试写");
    t = t.replace(/据[^「」\n]{0,16}材料/g, "在缺少精读材料时");
    return t;
  }

  function slimWorkspace(ws, readSet) {
    if (!ws) return {};
    var readMap = {};
    (readSet || []).forEach(function (p) {
      readMap[p] = true;
    });
    return {
      name: ws.name || "",
      root: ws.root || "",
      catalog: (ws.catalog || []).slice(0, 40),
      /* 已精读的不再塞摘要，省窗 */
      materials: (ws.materials || [])
        .filter(function (m) {
          return !readMap[m.path];
        })
        .slice(0, 20)
        .map(function (m) {
          return {
            path: m.path,
            title: m.title,
            summary: String(m.summary || "").slice(0, 400)
          };
        }),
      templates: (ws.templates || []).slice(0, 15).map(function (m) {
        return {
          path: m.path,
          title: m.title,
          summary: String(m.summary || "").slice(0, 280)
        };
      })
    };
  }

  function runChat(opts) {
    opts = opts || {};
    var message = String(opts.message || "").trim();
    var contextMd = String(opts.contextMd || "");
    var allowEdit = !!opts.allowEdit;
    /* 交流 flash、终稿 pro；纯聊天全程 flash */
    var talkCap =
      opts.talkCapability === "strong"
        ? "strong"
        : opts.talkCapability === "fast"
          ? "fast"
          : "fast";
    var finalCap = allowEdit
      ? opts.finalCapability === "fast"
        ? "fast"
        : opts.finalCapability === "strong"
          ? "strong"
          : opts.capability === "fast"
            ? "fast"
            : "strong"
      : talkCap;
    var citeMats = opts.materials || [];
    var history = Array.isArray(opts.history) ? opts.history : [];
    var sessionSummary = String(opts.session_summary || "");
    var docMd = String(opts.doc_md || "");
    var seedReadSet = Array.isArray(opts.read_set) ? opts.read_set.slice() : [];
    var contextBag = opts.contextBag && typeof opts.contextBag === "object"
      ? opts.contextBag
      : null;
    var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};

    if (!message) {
      return Promise.reject(new Error("请先输入内容"));
    }
    if (!global.GwRelay || !GwRelay.chat) {
      return Promise.reject(new Error("无中转模块"));
    }

    if (global.GwMaterialTools && GwMaterialTools.setContextBag) {
      GwMaterialTools.setContextBag(
        contextBag || {
          pin: contextMd,
          doc_full: docMd,
          history: history,
          base_draft: "",
          task_card: ""
        }
      );
    }

    var state = {
      readSet: seedReadSet.slice(),
      toolResults: [],
      steps: [],
      readMeta: [],
      lastReasoning: ""
    };

    function status(msg, extra) {
      try {
        onStatus(msg, extra || state);
      } catch (e) {}
    }

    function syncIndex() {
      status("正在同步素材索引…");
      if (!global.GwMaterialIndex) {
        return Promise.resolve({ ok: true, skipped: true });
      }
      try {
        var r = GwMaterialIndex.syncIncremental(function (p) {
          if (p && p.path) {
            status(
              "索引 " + (p.current || "") + "/" + (p.total || "") + " · " + p.path
            );
          }
        });
        return Promise.resolve(r);
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e.message || e) });
      }
    }

    function seedCited() {
      (citeMats || []).forEach(function (m) {
        if (!m || !m.ok || !m.text) return;
        var p = GwProject.normRel(m.path || m.title || "");
        if (!p) return;
        if (state.readSet.indexOf(p) < 0) state.readSet.push(p);
        state.toolResults.push({
          id: "cite_" + state.toolResults.length,
          name: "read_file",
          arguments: { path: p },
          result: {
            ok: true,
            path: p,
            title: m.title || p,
            text: m.text,
            via: "cite"
          }
        });
        state.readMeta.push({
          path: p,
          title: m.title || GwMaterialTools.shortName(p),
          at: new Date().toISOString()
        });
      });
    }

    function seedMatList(mats, via) {
      var n = 0;
      (mats || []).forEach(function (m) {
        if (!m || !(m.ok || m.text) || !m.text) return;
        var p = GwProject.normRel(m.path || m.title || "");
        if (!p) return;
        if (state.readSet.indexOf(p) >= 0) return;
        state.readSet.push(p);
        state.toolResults.push({
          id: via + "_" + state.toolResults.length,
          name: "read_file",
          arguments: { path: p },
          result: {
            ok: true,
            path: p,
            title: m.title || p,
            text: String(m.text || "").slice(0, 12000),
            via: via || "auto"
          }
        });
        state.readMeta.push({
          path: p,
          title: m.title || GwMaterialTools.shortName(p),
          at: new Date().toISOString()
        });
        n += 1;
      });
      return n;
    }

    function executeCalls(calls) {
      var newReads = 0;
      var dupOnly = true;
      for (var i = 0; i < calls.length; i++) {
        var call = calls[i];
        var args = call.arguments || {};
        var rel = GwProject.normRel(args.path || args.rel || "");
        if (call.name === "read_file" && rel && state.readSet.indexOf(rel) >= 0) {
          state.steps.push({ name: call.name, detail: rel + "（已读跳过）" });
          continue;
        }
        dupOnly = false;
        var label =
          call.name +
          (args.path || args.query ? " " + (args.path || args.query) : "");
        status("正在执行 " + label + "…");
        state.steps.push({
          name: call.name,
          detail: args.path || args.query || ""
        });
        var ex = GwMaterialTools.executeTool(call.name, args);
        if (call.name === "read_file" && ex.result && ex.result.ok && ex.result.path) {
          if (state.readSet.indexOf(ex.result.path) < 0) {
            state.readSet.push(ex.result.path);
          }
          state.readMeta.push({
            path: ex.result.path,
            title: ex.result.title || GwMaterialTools.shortName(ex.result.path),
            at: ex.result.readAt || new Date().toISOString()
          });
          newReads += 1;
        }
        state.toolResults.push({
          id: call.id,
          name: call.name,
          arguments: args,
          result: ex.result
        });
      }
      return { newReads: newReads, dupOnly: dupOnly && calls.length > 0 };
    }

    function relayMaterials() {
      var out = [];
      var seen = {};
      function push(m) {
        if (!m || !m.text) return;
        var p = GwProject.normRel(m.path || m.title || "");
        if (!p || seen[p]) return;
        seen[p] = true;
        out.push({
          path: p,
          title: m.title || p,
          text: String(m.text).slice(0, 12000)
        });
      }
      (citeMats || []).forEach(push);
      state.toolResults.forEach(function (tr) {
        if (
          tr &&
          tr.name === "read_file" &&
          tr.result &&
          tr.result.ok &&
          tr.result.text
        ) {
          push({
            path: tr.result.path,
            title: tr.result.title,
            text: tr.result.text
          });
        }
      });
      return out;
    }

    function oneRound(forceFinal, round, cap, gatherOnly) {
      var useCap = cap || talkCap;
      var ws = slimWorkspace(
        GwMaterialIndex ? GwMaterialIndex.workspaceForAi() : {},
        state.readSet
      );
      var mats = relayMaterials();
      status(
        forceFinal
          ? useCap === "strong"
            ? "①材料已齐 → ②增强模型出终稿"
            : "正在作答…"
          : gatherOnly
            ? "①准备材料（第 " +
              (round + 1) +
              "/" +
              MAX_ROUNDS +
              " 轮，标准档取数）"
            : "处理中（第 " + (round + 1) + " 轮）…",
        state
      );
      return GwRelay.chat(
        message,
        "",
        useCap,
        allowEdit,
        mats.length ? mats : null,
        {
          workspace: ws,
          tool_results: state.toolResults,
          read_set: state.readSet.slice(),
          force_final: !!forceFinal,
          gather_only: !!gatherOnly,
          history: history,
          session_summary: sessionSummary,
          doc_md: "",
          assistant_reasoning: state.lastReasoning || ""
        }
      ).then(function (json) {
        if (json && json.reasoning_content) {
          state.lastReasoning = String(json.reasoning_content || "");
        }
        if (forceFinal) return { done: true, json: json };
        var parsed = GwMaterialTools.parseAgentPayload(
          (json && json.reply) || "",
          json
        );
        if (parsed.kind === "tools" && parsed.tool_calls && parsed.tool_calls.length) {
          return { done: false, calls: parsed.tool_calls, json: json };
        }
        /* gather：ready/任何非 tool 答复 → 资料阶段结束，不把 flash 正文当终稿 */
        if (gatherOnly) {
          return { done: true, gatherReady: true, json: json, parsed: parsed };
        }
        return { done: true, json: json, parsed: parsed };
      });
    }

    function packResult(r) {
      var reply =
        (r.json && r.json.reply) ||
        (r.parsed && r.parsed.reply) ||
        "(空回复)";
      var edit =
        (r.json && r.json.edit) ||
        (r.parsed && r.parsed.edit) ||
        null;
      var options =
        (r.json && r.json.options) ||
        (r.parsed && r.parsed.options) ||
        null;
      if (
        allowEdit &&
        GwMaterialTools &&
        GwMaterialTools.parseAgentPayload
      ) {
        var again = GwMaterialTools.parseAgentPayload(reply, r.json);
        if (again && again.edit && !edit) {
          edit = again.edit;
          if (again.reply) reply = again.reply;
        }
        if (again && again.options && again.options.length) {
          options = again.options;
        }
      }
      if (!GwMaterialTools.hasUsableReads(state.toolResults)) {
        reply = scrubFalseMaterialClaims(reply);
      }
      status("完成", state);
      return {
        ok: true,
        reply: reply,
        edit: edit,
        options: options,
        read_set: state.readSet.slice(),
        readMeta: state.readMeta.slice(),
        steps: state.steps.slice(),
        toolResults: state.toolResults
      };
    }

    return syncIndex()
      .then(function (sync) {
        if (sync && sync.ok === false) {
          status("索引同步失败：" + (sync.error || "") + "，仍继续对话");
        } else if (sync && sync.changed != null) {
          status(
            sync.mode === "full"
              ? "已建索引 " + (sync.count || 0) + " 个文件"
              : "索引已同步（更新 " + (sync.changed || 0) + " 个）"
          );
        }
        seedCited();
        /* 要啥给啥：不预灌会话精读/目录假工具轮；由模型 fetch_context / read_file */
        return { autoN: 0 };
      })
      .then(function () {
        var round = 0;
        var needProFinal = allowEdit && finalCap === "strong";

        function finalizeWrite() {
          /* flash 取数结果已在 tool_results；不回灌 flash reasoning 给 pro */
          state.lastReasoning = "";
          var n = (state.toolResults && state.toolResults.length) || 0;
          status(
            n
              ? "①材料已齐（" + n + " 条）→ ②增强出终稿（质量优先，可能需1～3分钟）"
              : "①无需再取数 → ②增强出终稿（质量优先，可能需1～3分钟）",
            state
          );
          return oneRound(true, round, finalCap, false).then(packResult);
        }

        function hasMaterialPool() {
          if ((citeMats || []).length) return true;
          try {
            if (!global.GwMaterialIndex || !GwMaterialIndex.workspaceForAi)
              return false;
            var ws = GwMaterialIndex.workspaceForAi() || {};
            return !!(ws.catalog && ws.catalog.length);
          } catch (e) {
            return false;
          }
        }

        function gatherLoop() {
          return oneRound(false, round, talkCap, true).then(function (r) {
            if (r.done) {
              return finalizeWrite();
            }
            var ex = executeCalls(r.calls || []);
            round += 1;
            if (ex.dupOnly || round >= MAX_ROUNDS) {
              return finalizeWrite();
            }
            return gatherLoop();
          });
        }

        function chatLoop(force) {
          return oneRound(force, round, talkCap, false).then(function (r) {
            if (r.done) return packResult(r);
            var ex = executeCalls(r.calls || []);
            round += 1;
            if (ex.dupOnly || round >= MAX_ROUNDS) {
              return chatLoop(true);
            }
            return chatLoop(false);
          });
        }

        /* 出稿：有素材池才 flash 取数；否则钉住已在首包，直接 pro 终稿 */
        if (needProFinal) {
          if (!hasMaterialPool()) {
            status("工程无素材待取 → 直接增强出终稿", state);
            return finalizeWrite();
          }
          return gatherLoop();
        }
        return chatLoop(false);
      });
  }

  function extractMaterialKeys(text) {
    var raw = String(text || "");
    var cut = raw
      .split("【宿主约束】")[0]
      .split("【写前对齐】")[0]
      .split("【本轮焦点说明】")[0]
      .split("【风格参照")[0];
    cut = cut.replace(/【[\s\S]*?】/g, " ").replace(/\s+/g, " ").trim();
    var stop =
      /^(继续|完成|这一段|请按|给出|正文|标题|重写|加入|实际|工作|别写|太空|一组|二组|三组|参考|选定|光标|整篇)$/;
    var keys = [];
    var seen = {};
    var m;
    var re = /[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9_-]{1,}/g;
    while ((m = re.exec(cut)) && keys.length < 16) {
      var w = m[0];
      if (stop.test(w) || seen[w]) continue;
      seen[w] = true;
      keys.push(w);
    }
    return keys;
  }

  /**
   * 无引用时自动精读工程「素材/」：关键词命中优先，否则直接读前几篇。
   * 不再用整句「继续完成这一段」去全文匹配（几乎永远 miss）。
   */
  function prepareSuggestMaterials(requirement, citeMats, extra) {
    var mats = (citeMats || []).slice().filter(function (m) {
      return m && m.text;
    });
    if (mats.length) return Promise.resolve(mats);
    try {
      if (global.GwMaterialIndex) GwMaterialIndex.syncIncremental();
    } catch (e) {}

    var pool = [];
    try {
      var listed = GwProject.listProjectFiles();
      if (listed && listed.ok && listed.materials && listed.materials.length) {
        pool = listed.materials.slice();
      }
    } catch (eList) {}
    if (!pool.length) {
      try {
        var lf = GwMaterialTools.list_files();
        pool = (lf && lf.materials) || [];
      } catch (eLf) {}
    }
    if (!pool.length) {
      return Promise.resolve([]);
    }

    var keys = extractMaterialKeys(
      String(requirement || "") +
        "\n" +
        String((extra && extra.contextMd) || "") +
        "\n" +
        String((extra && extra.doc_md) || "")
    );
    var sumByPath = {};
    try {
      if (global.GwMaterialIndex && GwMaterialIndex.workspaceForAi) {
        var wsi = GwMaterialIndex.workspaceForAi() || {};
        (wsi.materials || []).forEach(function (m) {
          if (m && m.path) sumByPath[m.path] = String(m.summary || "");
        });
        (wsi.catalog || []).forEach(function (m) {
          if (m && m.path && !sumByPath[m.path])
            sumByPath[m.path] = "";
        });
      }
    } catch (eIdx) {}
    var scored = pool.map(function (it) {
      var path = String(it.path || "");
      var title = String(it.title || "");
      var sum = sumByPath[path] || String(it.summary || "");
      var blob = (path + " " + title + " " + sum).toLowerCase();
      var score = 0;
      keys.forEach(function (k) {
        if (blob.indexOf(String(k).toLowerCase()) >= 0) score += 3;
      });
      if (/素材/.test(path)) score += 1;
      return { path: path, title: title, score: score };
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    /* 有关键词命中则取命中的；否则仍读前 3 篇，避免「搜不到就空」 */
    var picked = scored.filter(function (x) {
      return x.score > 0;
    });
    if (!picked.length) picked = scored.slice(0, 3);
    else picked = picked.slice(0, 3);

    var errors = [];
    picked.forEach(function (h) {
      if (!h.path) return;
      var rd = GwMaterialTools.read_file(h.path, 10000);
      if (rd && rd.ok && rd.text) {
        mats.push({
          path: rd.path,
          title: rd.title || h.title,
          text: rd.text,
          ok: true
        });
      } else {
        errors.push(
          (h.path || "") + ":" + ((rd && rd.error) || "读失败")
        );
      }
    });
    if (!mats.length && errors.length && global.GwLog) {
      try {
        GwLog.warn("material.auto_read.fail", { errors: errors.slice(0, 5) });
      } catch (eLog) {}
    }
    return Promise.resolve(mats);
  }

  global.GwChatLoop = {
    runChat: runChat,
    prepareSuggestMaterials: prepareSuggestMaterials,
    extractMaterialKeys: extractMaterialKeys
  };
})(window);
