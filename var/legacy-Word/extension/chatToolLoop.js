/**
 * 对话工具环：本机执行 list/read/search，中转只跑模型。
 */
const log = require("./log");
const { relayRequest } = require("./relayProxy");
const materialTools = require("./materialTools");
const projectMemory = require("./projectMemory");
const chatInfer = require("./chatInfer");

function collectPinnedPaths(body, msgText) {
  const pinned = [];
  const pushPin = (p) => {
    const rel = String(p || "")
      .trim()
      .replace(/\\/g, "/");
    if (!rel || pinned.indexOf(rel) >= 0) return;
    pinned.push(rel);
  };
  (Array.isArray(body.pinned_paths) ? body.pinned_paths : []).forEach(pushPin);
  const atRe = /@([^\s@，,。；;]+?\.md)/g;
  let am;
  while ((am = atRe.exec(msgText))) pushPin(am[1]);
  return pinned;
}

function rememberNotice(mem, fp, folders, rel, content) {
  try {
    const cur = String(mem.text || "");
    if (cur.indexOf("已读「" + rel + "」") >= 0) return;
    projectMemory.appendNoticeRead(fp, folders, rel, content);
    const latest = projectMemory.readMemory(fp, folders);
    mem.text = latest.text;
    mem.inject = latest.inject;
  } catch (_) { /* ignore */ }
}

function maybeRememberSpoken(mem, fp, folders, msgText) {
  if (!/记住|记下|以后都|不要写|必须按/.test(msgText)) return;
  try {
    const note = msgText.replace(/\s+/g, " ").trim().slice(0, 200);
    if (note && String(mem.text || "").indexOf(note.slice(0, 40)) < 0) {
      projectMemory.appendMemory(fp, folders, note);
      const latest = projectMemory.readMemory(fp, folders);
      mem.text = latest.text;
      mem.inject = latest.inject;
    }
  } catch (_) { /* ignore */ }
}

function decideForceFinal(body, msgText, history, whHistory) {
  const outlineHeads = materialTools.historyHasOutline(history);
  const applyOnly = materialTools.wantsApplyFramework(msgText);
  const continueSec =
    chatInfer.wantsContinueSection && chatInfer.wantsContinueSection(msgText);
  const hist = whHistory || history || [];
  const applyHeads =
    (chatInfer.resolveApplyHeads &&
      chatInfer.resolveApplyHeads(msgText, hist)) ||
    (chatInfer.extractApplyHeads && chatInfer.extractApplyHeads(msgText)) ||
    [];
  return {
    applyOnly,
    outlineHeads,
    forceFinal:
      !!body.force_final ||
      (continueSec && !!body.allow_edit) ||
      (applyOnly && applyHeads.length >= 2) ||
      (applyOnly && outlineHeads.length >= 2) ||
      (applyOnly && !!body.allow_edit && hist.length >= 2),
  };
}

function parseRelayPayload(json) {
  if (
    json.type === "tool_calls" ||
    Array.isArray(json.tool_calls) ||
    Array.isArray(json.calls)
  ) {
    return materialTools.parseAgentPayload(JSON.stringify(json));
  }
  return materialTools.parseAgentPayload(json.reply || json.raw || "");
}

function executeToolCalls(fp, calls, state) {
  let newReads = 0;
  for (const call of calls) {
    const args = call.arguments || {};
    const rel = String(args.path || "").replace(/\\/g, "/");
    if (call.name === "read_file" && rel && state.readSet.indexOf(rel) >= 0) {
      log.info("editor.chat.tool.skipDup", { path: rel });
      continue;
    }
    const label =
      call.name + (args.path || args.query ? " " + (args.path || args.query) : "");
    state.steps.push({
      name: call.name,
      detail: args.path || args.query || "",
    });
    state.pushCtx({ name: call.name, detail: label });
    const ex = materialTools.executeTool(fp, call.name, args);
    if (call.name === "read_file" && ex.result && ex.result.ok && ex.result.path) {
      if (state.readSet.indexOf(ex.result.path) < 0) {
        state.readSet.push(ex.result.path);
      }
      rememberNotice(
        state.mem,
        state.fp,
        state.folders,
        ex.result.path,
        ex.result.text || ex.result.content || ""
      );
      newReads += 1;
    }
    state.toolResults.push({
      id: call.id,
      name: call.name,
      arguments: args,
      result: ex.result,
    });
    log.info("editor.chat.tool", {
      name: call.name,
      ok: !!(ex.result && ex.result.ok),
      detail: label,
    });
  }
  return newReads;
}

function finishChat(state, result, json, payload, parsed) {
  try {
    // force_final 时 payload.tool_results 常被清空；本地兜底必须用真实已读素材
    const patchBody = Object.assign({}, payload || {}, {
      message: state.msgText,
      doc_md: (state.body && state.body.doc_md) || "",
      allow_edit: !!(state.body && state.body.allow_edit),
      tool_results: state.toolResults,
      history: (state.body && state.body.history) || (state.wh && state.wh.history) || [],
      workspace: state.ws,
    });
    json = chatInfer.patchChatResult(patchBody, json);
    if (json && json._localInfer) {
      log.info("editor.chat.localInfer", {
        summary: json.edit && json.edit.summary,
        rename: json.edit && json.edit.rename,
      });
    }
  } catch (e) {
    log.warn("editor.chat.localInfer.fail", {
      message: String(e && e.message ? e.message : e),
    });
  }
  const hasMats =
    (chatInfer.hasUsableMaterialReads &&
      chatInfer.hasUsableMaterialReads(state.toolResults, state.msgText)) ||
    (chatInfer.wantsWriteToCitedFile &&
      chatInfer.wantsWriteToCitedFile(state.msgText));
  const factual =
    chatInfer.wantsFactualWrite && chatInfer.wantsFactualWrite(state.msgText);
  if (parsed && parsed.kind === "final") {
    // 本地已生成 edit 时，勿被模型散文/残缺 edit 盖掉
    if (
      parsed.reply &&
      !(json && json._localInfer && json.edit && json.edit.md) &&
      !json._blockedNoMaterial
    ) {
      json.reply = parsed.reply;
    }
    // 无素材据实写作：禁止把模型胡编的 edit 盖回来
    if (
      parsed.edit &&
      parsed.edit.md &&
      !(json && json._localInfer) &&
      !json._blockedNoMaterial &&
      !(factual && !hasMats)
    ) {
      json.edit = parsed.edit;
    }
  }
  if (state.body.allow_edit) {
    const wantFull =
      chatInfer.wantsFullDraft && chatInfer.wantsFullDraft(state.msgText);
    const missing = !(json.edit && json.edit.md);
    const incomplete =
      wantFull &&
      json.edit &&
      json.edit.md &&
      chatInfer.isIncompleteFullDraft &&
      chatInfer.isIncompleteFullDraft(
        json.edit.md,
        (state.body && state.body.doc_md) || "",
        state.msgText
      );
    // 据实写作且已读到素材，才允许本地扩写；无素材绝不编造
    if ((missing || incomplete) && (!factual || hasMats)) {
      const local = wantFull
        ? chatInfer.inferFullDraftEdit(
            state.msgText,
            (state.body && state.body.doc_md) || "",
            state.toolResults,
            (state.body && state.body.history) || (state.wh && state.wh.history),
            json.edit && json.edit.md
          )
        : chatInfer.inferChatEdit(
            state.msgText,
            (state.body && state.body.doc_md) || "",
            state.ws,
            state.toolResults,
            (state.body && state.body.history) || (state.wh && state.wh.history)
          );
      if (local && local.md) {
        json.edit = local;
        json.reply =
          local.summary + "\n\n（本地已根据素材生成改稿预览，请 Keep All）";
        json._localInfer = true;
      }
    }
  }
  // 收尾再拦一次：防止模型 edit 在 patch 之后又被写回
  if (state.body.allow_edit && chatInfer.blockEditWithoutMaterials) {
    json = chatInfer.blockEditWithoutMaterials(
      {
        allow_edit: true,
        message: state.msgText,
        doc_md: (state.body && state.body.doc_md) || "",
        tool_results: state.toolResults,
        history: (state.body && state.body.history) || [],
      },
      json
    );
  }
  if (json.edit && chatInfer.sanitizeChatEdit) {
    json.edit = chatInfer.sanitizeChatEdit(json.edit);
  }
  if (
    json.edit &&
    json.edit.md &&
    chatInfer.ensureEditTargetFile
  ) {
    const curRel = (() => {
      try {
        return require("path").basename(state.fp || "");
      } catch (_) {
        return "";
      }
    })();
    json.edit = chatInfer.ensureEditTargetFile(
      state.msgText,
      json.edit,
      curRel
    );
  }
  if (json._blockedNoMaterial) {
    log.warn("editor.chat.blockedNoMaterial", {
      reads: state.readSet.slice(),
      msg: String(state.msgText || "").slice(0, 80),
    });
  }
  json.ok = json.ok !== false;
  json.context_steps = state.steps;
  const catItems = (state.catalog && state.catalog.items) || [];
  const nMatFolder = catItems.filter(
    (it) => it && (it.zone === "materials" || /^素材\//.test(String(it.path || "")))
  ).length;
  json.attached = {
    catalog: catItems.length,
    materials: nMatFolder || (state.ws.materials || []).length,
    summary: !!state.wh.summary,
    memory: !!(state.mem.inject && state.mem.inject.trim()),
    pinned: state.pinned.length,
    readSet: state.readSet.slice(),
  };
  json.session_summary = state.compact.summary;
  json.read_set = state.readSet;
  // 铁律：未授权改稿时剥掉一切 edit
  if (!(state.body && state.body.allow_edit)) {
    json.edit = null;
  }
  state.pushCtx(null);
  return { status: (result && result.status) || 200, json };
}

function buildChatPayload(state, forceFinal) {
  const trimmed = materialTools.trimToolResults(state.toolResults, 24000);
  const tip = forceFinal
    ? "\n\n【系统】禁止再调用工具。请直接最终答复；必须依据下方已读素材中的事实与数据写作。" +
      "若已授权且用户要写入某段/整篇/继续下一段，必须输出完整 edit.md，禁止只在 reply 里声称已写入。"
    : "\n\n【系统】写作前若还缺材料可继续 read_file/search_materials；已读素材须用其中可核对的事实与数据，禁止空话润色。";
  const payload = Object.assign({}, state.body, {
    workspace: materialTools.slimWorkspaceForChat(state.ws, trimmed),
    history: state.wh.history,
    session_summary: state.wh.summary,
    read_set: state.readSet,
    // force_final 时仍带上已读素材，否则模型/本地兜底都「没读过文件」
    tool_results: trimmed,
    project_memory: state.mem.inject || "",
    message: state.msgText + tip,
    force_final: forceFinal,
  });
  if (!payload.capability) payload.capability = "fast";
  if (state.relay && state.relay.authMode === "user") {
    delete payload.provider;
    delete payload.model;
  }
  return payload;
}

/** 把预读/补读结果并入 state（去重 path） */
function absorbReads(state, toolResults, steps) {
  const { fp, folders, mem } = state;
  const seen = new Set(
    state.toolResults
      .filter((t) => t && t.name === "read_file" && t.result && t.result.ok)
      .map((t) => String(t.result.path || "").replace(/\\/g, "/"))
  );
  for (const tr of toolResults || []) {
    if (!tr || tr.name !== "read_file" || !tr.result || !tr.result.ok) {
      if (tr) state.toolResults.push(tr);
      continue;
    }
    const rel = String(tr.result.path || "").replace(/\\/g, "/");
    if (rel && seen.has(rel)) continue;
    state.toolResults.push(tr);
    if (rel) {
      seen.add(rel);
      if (state.readSet.indexOf(rel) < 0) state.readSet.push(rel);
      rememberNotice(
        mem,
        fp,
        folders,
        rel,
        tr.result.text || tr.result.content || ""
      );
    }
  }
  for (const s of steps || []) state.steps.push(s);
}

function preloadPinsAndBoot(state, forceFinal) {
  const { fp, folders, mem, body, msgText, pushCtx } = state;
  // 会话带回的 read_set 常无正文：先按路径补读，避免误报「未读到素材」
  if (materialTools.rehydrateMaterialReads) {
    const rh = materialTools.rehydrateMaterialReads(
      fp,
      state.readSet,
      state.toolResults
    );
    absorbReads(state, rh.toolResults, rh.steps);
    if ((rh.toolResults || []).length) {
      log.info("editor.chat.rehydrate", {
        n: rh.toolResults.length,
        paths: (rh.readPaths || []).slice(),
      });
    }
  }
  for (let i = 0; i < state.pinned.length; i++) {
    const p = state.pinned[i];
    if (state.readSet.indexOf(p) >= 0) continue;
    pushCtx({ name: "read_file", detail: "钉 " + p });
    const rd = materialTools.executeTool(fp, "read_file", { path: p });
    absorbReads(
      state,
      [
        {
          id: "pin-read-" + i,
          name: "read_file",
          arguments: { path: p },
          result: rd.result,
        },
      ],
      [{ name: "read_file", detail: p }]
    );
  }
  maybeRememberSpoken(mem, fp, folders, msgText);
  const docMd = String(body.doc_md || "");
  // 不 @ 也要找材料：按消息+当前稿标题检索预读（写稿/授权改稿时必做）
  const wantAuto =
    !!body.allow_edit ||
    /写|改|补|初稿|落到|继续|根据|参考|素材|读(取|一下)|充实|亮点|重点/.test(
      msgText
    );
  const autoBoot =
    wantAuto && materialTools.bootstrapAutoDiscover
      ? materialTools.bootstrapAutoDiscover(fp, msgText, docMd, state.readSet)
      : { toolResults: [], steps: [], readPaths: [], keys: [] };
  // 续写/整篇：按【待补】标题再补读
  const pendingBoot =
    materialTools.bootstrapPendingReads &&
    materialTools.bootstrapPendingReads(fp, docMd, msgText, state.readSet);
  const boot =
    forceFinal
      ? { toolResults: [], steps: [], readPaths: [] }
      : materialTools.bootstrapMaterialReads(fp, msgText, docMd, state.readSet);
  const merged = []
    .concat((autoBoot && autoBoot.toolResults) || [])
    .concat((pendingBoot && pendingBoot.toolResults) || [])
    .concat(boot.toolResults || []);
  const bootSteps = []
    .concat((autoBoot && autoBoot.steps) || [])
    .concat((pendingBoot && pendingBoot.steps) || [])
    .concat(boot.steps || []);
  if (forceFinal) {
    log.info("editor.chat.forceFinal", {
      applyOnly: state.applyOnly,
      autoReads: (autoBoot && autoBoot.readPaths) || [],
      pendingReads: (pendingBoot && pendingBoot.readPaths) || [],
    });
  }
  if (!merged.length) {
    if (wantAuto) {
      log.info("editor.chat.autoDiscover.empty", {
        keys: ((autoBoot && autoBoot.keys) || []).slice(0, 12),
      });
    }
    return;
  }
  absorbReads(state, merged, bootSteps);
  pushCtx(bootSteps[bootSteps.length - 1] || null);
  log.info("editor.chat.bootstrapMaterials", {
    n: merged.length,
    auto: ((autoBoot && autoBoot.readPaths) || []).length,
    pending: ((pendingBoot && pendingBoot.readPaths) || []).length,
    keys: ((autoBoot && autoBoot.keys) || []).slice(0, 12),
    paths: state.readSet.slice(),
  });
}

async function runRelayRounds(state, relay, forceFinal0) {
  let forceFinal = forceFinal0;
  let last = {
    payload: null,
    result: null,
    json: null,
    parsed: null,
  };
  for (let round = 0; round < 6; round++) {
    if (round >= 4) forceFinal = true;
    const payload = buildChatPayload(state, forceFinal);
    last.payload = payload;
    log.info("editor.relay.start", {
      id: "chat-loop-" + round,
      method: "POST",
      path: "/api/chat",
      tools: state.toolResults.length,
      forceFinal,
    });
    const result = await relayRequest(
      relay.serverUrl,
      relay.token,
      "POST",
      "/api/chat",
      payload
    );
    const json = result.json && typeof result.json === "object" ? result.json : {};
    if (result.status >= 400 || json.error) {
      return { status: result.status || 400, json };
    }
    const parsed = parseRelayPayload(json);
    last = { payload, result, json, parsed };
    if (
      !forceFinal &&
      parsed.kind === "tools" &&
      parsed.tool_calls &&
      parsed.tool_calls.length
    ) {
      const newReads = executeToolCalls(state.fp, parsed.tool_calls, state);
      if (newReads === 0) forceFinal = true;
      continue;
    }
    return finishChat(state, result, json, payload, parsed);
  }
  return exhaustFinal(state, relay, last);
}

async function exhaustFinal(state, relay, last) {
  const payload = Object.assign({}, buildChatPayload(state, true), {
    message:
      state.msgText +
      "\n\n【系统】工具轮次已用尽。禁止调用工具，直接输出最终答复/edit 框架。",
    tool_results: [],
  });
  try {
    const result = await relayRequest(
      relay.serverUrl,
      relay.token,
      "POST",
      "/api/chat",
      payload
    );
    const json = result.json && typeof result.json === "object" ? result.json : {};
    if (!(result.status >= 400 || json.error)) {
      const parsed = materialTools.parseAgentPayload(json.reply || json.raw || "");
      if (json.type !== "tool_calls" && parsed.kind !== "tools") {
        return finishChat(state, result, json, payload, parsed);
      }
    }
  } catch (_) { /* fall through */ }
  return finishChat(
    state,
    (last && last.result) || { status: 200 },
    (last && last.json) || { reply: "" },
    (last && last.payload) || payload,
    (last && last.parsed) || { kind: "final" }
  );
}

function createLoopState(body, ctx, webviewPanel, host) {
  const fp = host.activeFsPath(ctx);
  const folders = host.workspaceFolders();
  const msgText = String(body.message || "");
  const ws = host.workspaceSummary(fp, true);
  const catalog = materialTools.catalogForAi(fp);
  const mem = projectMemory.readMemory(fp, folders);
  const steps = [];
  let readSet = Array.isArray(body.read_set) ? body.read_set.slice() : [];
  const compact = materialTools.maybeCompactSummary(
    body.history,
    body.session_summary,
    readSet
  );
  readSet = compact.readSet.slice();
  const wh = materialTools.buildWorkingHistory(body.history, {
    summary: compact.summary,
    readSet,
    maxMsgs: 12,
    maxChars: 10000,
  });
  const pushCtx = (current) => {
    try {
      const items = catalog.items || [];
      const nMat = items.filter(
        (it) =>
          it && (it.zone === "materials" || /^素材\//.test(String(it.path || "")))
      ).length;
      webviewPanel.webview.postMessage({
        type: "chatContext",
        attached: {
          catalog: items.length,
          materials: nMat || (ws.materials || []).length,
          summary: !!wh.summary,
          memory: !!(mem.inject && mem.inject.trim()),
          pinned: (body.pinned_paths || []).length || 0,
          readSet: readSet.slice(),
        },
        steps: steps.slice(),
        current: current || null,
      });
    } catch (_) { /* disposed */ }
  };
  pushCtx(null);
  const decided = decideForceFinal(body, msgText, body.history, wh.history);
  return {
    body,
    msgText,
    ws,
    wh,
    compact,
    steps,
    pinned: collectPinnedPaths(body, msgText),
    catalog,
    mem,
    toolResults: Array.isArray(body.tool_results) ? body.tool_results.slice() : [],
    readSet,
    pushCtx,
    applyOnly: decided.applyOnly,
    forceFinal: decided.forceFinal,
    fp,
    folders,
  };
}

async function runChatToolLoop(body, ctx, webviewPanel, relay, host) {
  const state = createLoopState(body, ctx, webviewPanel, host);
  state.relay = relay || null;
  preloadPinsAndBoot(state, state.forceFinal);
  return runRelayRounds(state, relay, state.forceFinal);
}

module.exports = { runChatToolLoop };
