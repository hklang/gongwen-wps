/**
 * 对话工具环：发送前增量索引 → 多轮 tool_calls → 本机执行 → 再请求中转
 */
(function (global) {
  var MAX_ROUNDS = 6;

  function wantsFactual(msg) {
    return /充填|写数|据实|素材|数据|指标|完成情况|汇报/.test(
      String(msg || "")
    );
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
    var capability = opts.capability === "strong" ? "strong" : "fast";
    var allowEdit = !!opts.allowEdit;
    var citeMats = opts.materials || [];
    var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};

    if (!message) {
      return Promise.reject(new Error("请先输入内容"));
    }
    if (!global.GwRelay || !GwRelay.chat) {
      return Promise.reject(new Error("无中转模块"));
    }

    var state = {
      readSet: [],
      toolResults: [],
      steps: [],
      readMeta: []
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

    function oneRound(forceFinal, round) {
      var ws = slimWorkspace(
        GwMaterialIndex ? GwMaterialIndex.workspaceForAi() : {},
        state.readSet
      );
      status(
        forceFinal
          ? "正在作答…"
          : "模型思考中（第 " + (round + 1) + " 轮）…",
        state
      );
      return GwRelay.chat(message, contextMd, capability, allowEdit, null, {
        workspace: ws,
        tool_results: state.toolResults,
        read_set: state.readSet.slice(),
        force_final: !!forceFinal
      }).then(function (json) {
        if (forceFinal) return { done: true, json: json };
        var parsed = GwMaterialTools.parseAgentPayload(
          (json && json.reply) || "",
          json
        );
        if (parsed.kind === "tools" && parsed.tool_calls && parsed.tool_calls.length) {
          return { done: false, calls: parsed.tool_calls, json: json };
        }
        return { done: true, json: json, parsed: parsed };
      });
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
        var round = 0;

        function loop(force) {
          return oneRound(force, round).then(function (r) {
            if (r.done) {
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
              /* force_final 时 reply 可能仍是整段 JSON */
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
              if (
                wantsFactual(message) &&
                !GwMaterialTools.hasUsableReads(state.toolResults) &&
                !(citeMats && citeMats.length)
              ) {
                reply +=
                  "\n\n（提示：本轮未成功精读到素材正文。请将材料放入工程「素材/」并点刷新，或右键引用后再试；无依据处勿编造数字。）";
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
            var ex = executeCalls(r.calls || []);
            round += 1;
            if (ex.dupOnly || round >= MAX_ROUNDS || round >= 4) {
              return loop(true);
            }
            return loop(false);
          });
        }

        return loop(false);
      });
  }

  /**
   * 精修：同步索引后，若无引用则按要求检索并精读最多 2 篇，作为 materials 送出方案
   */
  function prepareSuggestMaterials(requirement, citeMats) {
    var mats = (citeMats || []).slice();
    try {
      GwMaterialIndex.syncIncremental();
    } catch (e) {}
    if (mats.length) return Promise.resolve(mats);
    try {
      var q = String(requirement || "").replace(/\s+/g, " ").trim().slice(0, 40);
      var hits = GwMaterialTools.search_materials(q || "工作").hits || [];
      if (!hits.length) {
        var list = GwMaterialTools.list_files();
        hits = ((list && list.materials) || []).slice(0, 2).map(function (m) {
          return { path: m.path, title: m.title };
        });
      }
      hits.slice(0, 2).forEach(function (h) {
        var rd = GwMaterialTools.read_file(h.path, 8000);
        if (rd.ok) {
          mats.push({
            path: rd.path,
            title: rd.title,
            text: rd.text,
            ok: true
          });
        }
      });
    } catch (e2) {}
    return Promise.resolve(mats);
  }

  global.GwChatLoop = {
    runChat: runChat,
    prepareSuggestMaterials: prepareSuggestMaterials,
    wantsFactual: wantsFactual
  };
})(window);
