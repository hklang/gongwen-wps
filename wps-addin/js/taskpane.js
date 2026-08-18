(function () {
  var CHIP_SLICE = 28;
  var LIVE_MS = 200;
  var state = {
    tab: "write",
    chatWrite: [],
    chatSuite: [],
    options: [],
    proof: [],
    proofSnap: null,
    proofActive: -1,
    proofFollowTimer: null,
    proofJumpUntil: 0,
    live: null,
    work: null,
    selPopOpen: false,
    busy: false,
    liveTimer: null,
    previewId: null,
    adoptedId: null,
    optView: "diff",
    suiteBaseline: "",
    /** 同级多标题出方案前的原文数组（与 work.items 一一对应） */
    suiteBaselineItems: null,
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
    lastUnderstand: null,
    /** 忙时阶段文案（状态条心跳） */
    busyPhase: "",
    busyTimer: null,
    busyAt: 0,
    /** 本轮发送前自动档相对路径（挂到助手消息） */
    pendingTurnAutoRel: "",
    /** 还原本轮后：当前结论卡不可落/预览/采用，直到下一轮出结果 */
    writeLiveFrozen: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function writeChat() {
    return state.chatWrite;
  }

  function suiteChat() {
    return state.chatSuite;
  }

  /** 当前页签对话：撰写 / 精修各自独立 */
  function activeChat() {
    return state.tab === "suite" ? state.chatSuite : state.chatWrite;
  }

  function tip(msg) {
    var el = $("aiTip");
    if (el) {
      el.hidden = !msg;
      el.textContent = msg || "";
    }
  }

  function formatWaitSec(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "分" + (s % 60) + "秒";
  }

  function paintBusyTip() {
    if (!state.busy) return;
    var phase = state.busyPhase || (state.tab === "suite" ? "出方案中" : "处理中");
    var wait = state.busyAt ? Date.now() - state.busyAt : 0;
    var base =
      (state.lastUnderstand && state.lastUnderstand.line) || "";
    var line = base ? base + " · " + phase : phase;
    if (wait >= 20000 && wantThinkSlow()) line += "（增强思考中，请稍候）";
    tip(line);
    var st = $("aiEditStatus");
    if (st && state.busy) {
      var short = (state.lastUnderstand && state.lastUnderstand.short) || "进行中";
      st.textContent = short + " · " + formatWaitSec(wait);
    }
  }

  function setBusyPhase(phase) {
    state.busyPhase = String(phase || "").trim();
    if (state.busy) paintBusyTip();
  }

  function tipProgress(progress) {
    setBusyPhase(progress);
  }

  function startBusyTicker() {
    stopBusyTicker();
    state.busyTimer = setInterval(function () {
      if (!state.busy) {
        stopBusyTicker();
        return;
      }
      paintBusyTip();
      /* 增强档常超过 1～3 分钟；超时解锁放宽，避免误杀进行中的请求 */
      var wait = state.busyAt ? Date.now() - state.busyAt : 0;
      if (wait > 240000) {
        setBusy(false);
        tip("等待超过 4 分钟已解锁。若稍后仍返回结果可忽略；也可再发一次");
        logWarn("send.busy_timeout", { wait: wait });
      }
    }, 1000);
  }

  function stopBusyTicker() {
    if (state.busyTimer) {
      clearInterval(state.busyTimer);
      state.busyTimer = null;
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
    var pinOn = assembled.trace && assembled.trace.pinChars > 0;
    var short = "撰写";
    var line = pinOn ? "清单已列钉住 · 要则点名取" : "清单点名 · 要啥给啥";
    state.lastUnderstand = {
      short: short,
      line: line,
      intent: classified.intent || ""
    };
    var st = $("aiEditStatus");
    if (st) st.textContent = short;
    tip(line);
    logInfo("ctx.understand", state.lastUnderstand);
    if (align && align.trace) logInfo("quality.align", align.trace);
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
    /* 发送路径不重读 read_set 盘文件，避免 COM 抽文卡死「没反应」 */
    if (state.styleRefText) parts.push(String(state.styleRefText));
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
    /* 交稿闸不占侧栏：只走底栏 tip + GwLog，检查单面板默认隐藏 */
    hideQualityBar();
    return chk;
  }

  function hideQualityBar() {
    var bar = $("aiQualityBar");
    if (!bar) return;
    bar.hidden = true;
    bar.innerHTML = "";
  }

  function renderQualityBar() {
    hideQualityBar();
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
    return GwRelay.chat(prompt, "", "fast", false, null, {
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
          "fast",
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

  function refreshStyleFingerprint(opts) {
    opts = opts || {};
    if (!window.GwProject || !GwProject.getStyleRefRel) {
      state.styleFp = null;
      state.styleRefText = "";
      return null;
    }
    var rel = GwProject.getStyleRefRel();
    if (!rel) {
      state.styleFp = null;
      state.styleRefText = "";
      return null;
    }
    if (
      !opts.force &&
      state.styleFp &&
      state.styleFp.path === rel &&
      !state.styleFp.error &&
      state.styleRefText
    ) {
      return state.styleFp;
    }
    var title = GwProject.titleOf(GwProject.baseName(rel));
    if (!window.GwQualityKernel) {
      state.styleFp = { path: rel, title: title };
      return state.styleFp;
    }
    try {
      var rd = GwProject.readTextRel(rel);
      if (!rd || !rd.ok) {
        state.styleFp = {
          path: rel,
          title: title,
          error: (rd && rd.error) || "读失败"
        };
        state.styleRefText = "";
        logWarn("quality.style_ref.fail", state.styleFp.error);
        return state.styleFp;
      }
      state.styleRefText = String(rd.text || "").slice(0, 14000);
      state.styleFp = GwQualityKernel.extractStyleFingerprint(
        state.styleRefText,
        { path: rel, title: title }
      );
      logInfo("quality.style_ref", {
        path: rel,
        chars: state.styleFp.charCount,
        headings: (state.styleFp.headings && state.styleFp.headings.length) || 0
      });
      return state.styleFp;
    } catch (e) {
      state.styleFp = {
        path: rel,
        title: title,
        error: String((e && e.message) || e)
      };
      state.styleRefText = "";
      logWarn("quality.style_ref.crash", state.styleFp.error);
      return state.styleFp;
    }
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
  var lastSessionRoot = "";

  function slimWorkForStore(w) {
    if (!w || !String(w.text || "").replace(/\s/g, "")) return null;
    if (typeof w.start !== "number" || typeof w.end !== "number") return null;
    var o = {
      text: String(w.text).slice(0, 20000),
      start: w.start,
      end: w.end,
      endsWithPara: !!w.endsWithPara
    };
    if (w.heading) o.heading = w.heading;
    if (w.items && w.items.length) o.items = w.items.slice(0, 40);
    return o;
  }

  function applyRestoredWork(data) {
    var w = data && data.work;
    if (!w || !String(w.text || "").replace(/\s/g, "")) return;
    if (typeof w.start !== "number" || typeof w.end !== "number") return;
    state.work = {
      text: String(w.text),
      start: w.start,
      end: w.end,
      heading: w.heading || null,
      items: w.items || null,
      endsWithPara: !!w.endsWithPara
    };
  }

  function slimChatForStore(list) {
    return (list || []).slice(-50).map(function (m) {
      var o = {
        role: m.role,
        text: String(m.text || "").slice(0, 12000)
      };
      if (m.editMd) o.editMd = String(m.editMd).slice(0, 8000);
      if (m.variants && m.variants.length) {
        o.variants = m.variants.slice(0, 6).map(function (v) {
          return {
            id: v.id,
            note: v.note,
            md: String(v.md || "").slice(0, 12000)
          };
        });
      }
      if (m.autoVersionRel) o.autoVersionRel = String(m.autoVersionRel);
      if (m.pinBound) o.pinBound = true;
      if (typeof m.pinStart === "number") o.pinStart = m.pinStart;
      if (typeof m.pinEnd === "number") o.pinEnd = m.pinEnd;
      if (m.adoptedId) o.adoptedId = m.adoptedId;
      if (m.suite) o.suite = true;
      if (m.suiteOptions && m.suiteOptions.length) {
        o.suiteOptions = m.suiteOptions.slice(0, 6).map(function (opt) {
          return {
            id: opt.id,
            note: opt.note,
            md: String(opt.md || "").slice(0, 8000),
            recommend: !!opt.recommend,
            score: opt.score,
            items: opt.items
          };
        });
      }
      return o;
    });
  }

  function slimProofForStore(items) {
    return (items || []).slice(0, 200).map(function (it) {
      var o = {
        type: it.type,
        original: String(it.original || "").slice(0, 2000),
        suggestion: String(it.suggestion || "").slice(0, 2000),
        reason: String(it.reason || "").slice(0, 500),
        start: Number(it.start),
        end: Number(it.end),
        _ignored: !!it._ignored,
        _applied: !!it._applied
      };
      if (it.path) o.path = it.path;
      if (it.peer) o.peer = String(it.peer).slice(0, 2000);
      if (it.peerPath) o.peerPath = it.peerPath;
      return o;
    });
  }

  function slimProofSnapForStore(snap) {
    if (!snap || snap.text == null) return null;
    return {
      text: String(snap.text).slice(0, 80000),
      baseStart: Number(snap.baseStart) || 0,
      scope: snap.scope || "full"
    };
  }

  function lastSuiteOptionsFromChat(list) {
    var i;
    for (i = (list || []).length - 1; i >= 0; i--) {
      var m = list[i];
      if (m && Array.isArray(m.suiteOptions) && m.suiteOptions.length) {
        return m.suiteOptions;
      }
      if (m && m.suite && Array.isArray(m.variants) && m.variants.length) {
        return m.variants;
      }
    }
    return [];
  }

  function memPersistCount() {
    return (
      ((state.chatWrite && state.chatWrite.length) || 0) +
      ((state.chatSuite && state.chatSuite.length) || 0) +
      ((state.proof && state.proof.length) || 0) +
      ((state.options && state.options.length) || 0)
    );
  }

  function setProofClearEnabled() {
    var btn = $("proofClear");
    if (btn) btn.disabled = !(state.proof && state.proof.length);
  }

  function storeHasSession(data) {
    if (!data) return false;
    return !!(
      (data.chatWrite && data.chatWrite.length) ||
      (data.chatSuite && data.chatSuite.length) ||
      (data.chat && data.chat.length) ||
      (data.proof && data.proof.length) ||
      (data.options && data.options.length)
    );
  }

  function splitRestoredChats(data) {
    var nextWrite = [];
    var nextSuite = [];
    if (Array.isArray(data.chatWrite) || Array.isArray(data.chatSuite)) {
      nextWrite = data.chatWrite || [];
      nextSuite = data.chatSuite || [];
      if (
        !nextSuite.length &&
        Array.isArray(data.chat) &&
        data.chat.length
      ) {
        data.chat.forEach(function (m) {
          if (m && m.suite) nextSuite.push(m);
        });
      }
    } else if (Array.isArray(data.chat) && data.chat.length) {
      data.chat.forEach(function (m) {
        if (m && m.suite) nextSuite.push(m);
        else if (m) nextWrite.push(m);
      });
    }
    return { write: nextWrite, suite: nextSuite };
  }

  function restoreProofFromStore(data) {
    if (!Array.isArray(data.proof) || !data.proof.length) {
      state.proof = [];
      state.proofSnap = null;
      state.proofActive = -1;
      return;
    }
    state.proof = data.proof;
    state.proofSnap = slimProofSnapForStore(data.proofSnap);
    var a = Number(data.proofActive);
    state.proofActive = a >= 0 && a < state.proof.length ? a : 0;
    stampProofItems(state.proof, state.proofSnap && state.proofSnap.text);
  }

  function restoreSuiteLiveFromStore(data) {
    state.previewId = null;
    state.adoptedId = null;
    if (Array.isArray(data.options) && data.options.length) {
      state.options = data.options;
    } else {
      state.options = lastSuiteOptionsFromChat(state.chatSuite);
    }
    if (data.suiteBaseline) state.suiteBaseline = String(data.suiteBaseline);
    if (Array.isArray(data.suiteBaselineItems)) {
      state.suiteBaselineItems = data.suiteBaselineItems;
    }
  }

  function restoreTabFromStore(data) {
    if (data.tab === "write" || data.tab === "suite" || data.tab === "proof") {
      state.tab = data.tab;
    }
  }

  function sessionRoot() {
    if (!window.GwProject || !GwProject.getRoot) return "";
    return String(GwProject.getRoot() || "");
  }

  function sessionStoreGetAt(root) {
    if (!window.GwProject || !GwProject.readMetaJsonAt) return null;
    if (!root) return null;
    return GwProject.readMetaJsonAt(root, "session.json");
  }

  function sessionStoreSetAt(root, obj) {
    if (!window.GwProject || !GwProject.writeMetaJsonAt) return false;
    if (!root) return false;
    return !!GwProject.writeMetaJsonAt(root, "session.json", obj);
  }

  function sessionStoreGet() {
    return sessionStoreGetAt(sessionRoot());
  }

  function sessionStoreSet(obj) {
    return sessionStoreSetAt(sessionRoot(), obj);
  }

  function sessionOldCount(old) {
    if (!old) return 0;
    return (
      ((old.chatWrite && old.chatWrite.length) || 0) +
      ((old.chatSuite && old.chatSuite.length) || 0) +
      ((old.chat && old.chat.length) || 0) +
      ((old.proof && old.proof.length) || 0) +
      ((old.options && old.options.length) || 0)
    );
  }

  function takeLegacyPrefsSnapshot() {
    if (!window.GwUserPrefs) return null;
    var raw = GwUserPrefs.get(CHAT_STORE_KEY);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      return storeHasSession(data) ? data : null;
    } catch (e) {
      return null;
    }
  }

  function slimOptionsForStore(list) {
    return (list || []).slice(0, 6).map(function (opt) {
      return {
        id: opt.id,
        note: opt.note,
        md: String(opt.md || "").slice(0, 8000),
        recommend: !!opt.recommend,
        score: opt.score,
        items: opt.items
      };
    });
  }

  function sessionPayload(reason) {
    return {
      v: 3,
      savedAt: Date.now(),
      reason: reason || "",
      tab: state.tab,
      chatWrite: slimChatForStore(state.chatWrite),
      chatSuite: slimChatForStore(state.chatSuite),
      work: slimWorkForStore(state.work),
      proof: slimProofForStore(state.proof),
      proofSnap: slimProofSnapForStore(state.proofSnap),
      proofActive: state.proofActive,
      options: slimOptionsForStore(state.options),
      suiteBaseline: state.suiteBaseline
        ? String(state.suiteBaseline).slice(0, 20000)
        : "",
      suiteBaselineItems: state.suiteBaselineItems
        ? state.suiteBaselineItems.slice(0, 40)
        : null,
      baseDraft: state.baseDraft || null,
      taskCard: state.taskCard || null,
      _clarifyAskedOnce: !!state._clarifyAskedOnce
    };
  }

  function persistChat(reason, root) {
    try {
      root = root || sessionRoot();
      if (!root) {
        logWarn("chat.persist.skip_no_root", reason || "");
        return;
      }
      var allowEmpty =
        reason === "user_clear" ||
        reason === "user_clear_proof" ||
        reason === "proof_ok";
      if (!memPersistCount() && !allowEmpty) {
        var oldN = sessionOldCount(sessionStoreGetAt(root));
        if (oldN > 0) {
          logWarn("chat.persist.skip_empty_overwrite", {
            reason: reason || "",
            oldN: oldN
          });
          return;
        }
      }
      var ok = sessionStoreSetAt(root, sessionPayload(reason));
      logInfo("chat.persist", {
        reason: reason || "",
        writeN: (state.chatWrite && state.chatWrite.length) || 0,
        suiteN: (state.chatSuite && state.chatSuite.length) || 0,
        proofN: (state.proof && state.proof.length) || 0,
        optN: (state.options && state.options.length) || 0,
        root: root,
        ok: !!ok
      });
      if (!ok) logWarn("chat.persist.fail_disk", root);
    } catch (e) {
      logWarn("chat.persist.fail", String(e && e.message ? e.message : e));
    }
  }

  function restoreChat() {
    try {
      var data = sessionStoreGet();
      if (!data) {
        var legacy = takeLegacyPrefsSnapshot();
        if (legacy && sessionRoot()) {
          sessionStoreSet(legacy);
          try {
            if (window.GwUserPrefs) GwUserPrefs.set(CHAT_STORE_KEY, "");
          } catch (eClr) {}
          data = legacy;
          logInfo("chat.restore.migrated_prefs", sessionRoot());
        }
      }
      if (!data || !storeHasSession(data)) {
        logInfo("chat.restore.skip", data ? "no_session" : "empty");
        return false;
      }
      applyRestoredWork(data);
      var split = splitRestoredChats(data);
      state.chatWrite = split.write;
      state.chatSuite = split.suite;
      rehomeMisplacedSuiteMessages();
      restoreProofFromStore(data);
      restoreSuiteLiveFromStore(data);
      restoreTabFromStore(data);
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
      state.pendingClarify = null;
      state._clarifyAskedOnce = !!data._clarifyAskedOnce;
      logInfo("chat.restore.ok", {
        writeN: state.chatWrite.length,
        suiteN: state.chatSuite.length,
        proofN: (state.proof && state.proof.length) || 0,
        optN: (state.options && state.options.length) || 0,
        tab: state.tab,
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

  function wipeSessionMemory() {
    try {
      stopProofFollow();
    } catch (eStop) {}
    try {
      wipeProofMark();
    } catch (eWipe) {}
    state.chatWrite = [];
    state.chatSuite = [];
    state.options = [];
    state.proof = [];
    state.proofSnap = null;
    state.proofActive = -1;
    state.work = null;
    state.baseDraft = null;
    state.taskCard = window.GwContextKernel
      ? GwContextKernel.emptyCard()
      : null;
    state.pendingClarify = null;
    state._clarifyAskedOnce = false;
    state.lastUnderstand = null;
    state.readSet = [];
    state.suiteBaseline = "";
    state.suiteBaselineItems = null;
    state.previewId = null;
    state.adoptedId = null;
    state.writeLiveFrozen = false;
  }

  function applyRestoredSessionUi(ok) {
    var parts = [];
    if (state.chatWrite.length) parts.push("撰写 " + state.chatWrite.length);
    if (state.chatSuite.length) parts.push("精修 " + state.chatSuite.length);
    if (state.proof.length) parts.push("校对 " + state.proof.length + " 处");
    if (state.options.length) parts.push("方案 " + state.options.length);
    if (ok) tip("已恢复 · " + (parts.join(" · ") || "本工程记忆"));
    syncTabUi();
    if (state.tab === "proof" && state.proof && state.proof.length) {
      startProofFollow();
    }
  }

  function bindProjectSession() {
    if (!window.GwProject) return;
    if (GwProject.onRootWillChange) {
      GwProject.onRootWillChange(function () {
        persistChat("root_leave");
      });
    }
    if (GwProject.onRootChanged) {
      GwProject.onRootChanged(function (prev, next) {
        wipeSessionMemory();
        var ok = false;
        try {
          ok = restoreChat();
        } catch (eR) {
          logWarn("chat.restore.root_change", String(eR && eR.message));
        }
        lastSessionRoot = sessionRoot();
        applyRestoredSessionUi(ok);
        if (!ok) tip("已切换工程 · 本工程暂无会话");
      });
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

  /** 钉住原文（有则返回）；全文不走这里 */
  function focusContextMd() {
    var pin = workText();
    if (pin.replace(/\s/g, "")) return pin.slice(0, 6000);
    return "";
  }

  /** 思考（慢）勾选 → strong；默认 fast。撰写/精修共用 */
  function wantThinkSlow() {
    var el = $("aiThinkSlow");
    return !!(el && el.checked);
  }
  function capabilityForSend() {
    return wantThinkSlow() ? "strong" : "fast";
  }
  function capabilityWriteTalk() {
    return capabilityForSend();
  }
  function capabilityWriteFinal() {
    return capabilityForSend();
  }
  function capabilitySuite() {
    return capabilityForSend();
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

  function ensureDefaultWriteLevel() {
    var box = $("aiWriteLevels");
    if (!box) return;
    if (box.querySelector("[data-write-level].on")) return;
    var body = box.querySelector('[data-write-level="body"]');
    if (body) body.classList.add("on");
  }

  function writeLevelConstraint(levels) {
    var parts = [];
    var hasH1 = levels.indexOf("h1") >= 0;
    var hasH2 = levels.indexOf("h2") >= 0;
    var hasH3 = levels.indexOf("h3") >= 0;
    var hasBody = levels.indexOf("body") >= 0;
    parts.push("用户已点选产出层级：" + levels.join(",") + "。");
    parts.push(
      "落稿按井号套字体：# 文题、## 一级、### 二级、#### 三级。只输出点选层级，未点选的井号不要出现。"
    );
    if (hasH1) {
      parts.push("点选了一级：先一行「# …」文题，再「## 一、…」。不要用单个 # 写章节。");
    }
    if (hasH2) {
      parts.push("点选了二级：行首「### （一）…」。");
      if (!hasH1) parts.push("未点选一级：不要输出 ## 行。");
    }
    if (hasH3) {
      parts.push("点选了三级：行首「#### …」。");
      if (!hasH1 && !hasH2) parts.push("未点选一/二级：不要输出 ## 或 ### 行。");
    }
    if (hasBody && !hasH1 && !hasH2 && !hasH3) {
      parts.push("点选了正文、未点选标题：不要标题井号行。");
    }
    if (!hasBody && (hasH1 || hasH2 || hasH3)) {
      parts.push("未点选正文：只要标题行。");
    }
    return parts.join("");
  }

  function pinnedScopeHint() {
    var t = workText();
    if (!t.replace(/\s/g, "")) return "";
    return "\n【钉住范围】\n" + t.slice(0, 6000);
  }

  function buildWriteUserPacket(req, pin, inv, historyBlock) {
    var parts = [];
    var hist = String(historyBlock || "").trim();
    if (hist) parts.push(hist);
    parts.push("【本轮要求】\n" + String(req || "").trim());
    var p = String(pin || "").trim();
    if (p.replace(/\s/g, "")) {
      var n = p.replace(/\s/g, "").length;
      if (p.length > 6000) {
        p = p.slice(0, 6000) + "\n（已截断，共约" + n + "字）";
      }
      parts.push("【本轮钉住】\n" + p);
    }
    var invT = String(inv || "").trim();
    if (invT) parts.push(invT);
    return parts.join("\n\n");
  }

  function pinHistoryBlock(list) {
    if (!window.GwContextKernel || !GwContextKernel.formatPinHistory) return "";
    return GwContextKernel.formatPinHistory(list || [], currentWorkPin(), 10, {
      lastAdoptedId: state.adoptedId || ""
    });
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
    var bits = [];
    if (levels.indexOf("h1") >= 0) bits.push("一级=# 文题 + ## 一、");
    if (levels.indexOf("h2") >= 0) bits.push("二级=### （一）");
    if (levels.indexOf("h3") >= 0) bits.push("三级=####");
    if (levels.indexOf("body") >= 0) bits.push("正文=段落");
    return "点选层级：" + bits.join("；") + "。";
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

  function nthBefore(snap, needle, pos) {
    if (!needle) return 0;
    var n = 0;
    var idx = 0;
    var chunk = String(snap || "").slice(0, Math.max(0, pos));
    while (idx < chunk.length) {
      var p = chunk.indexOf(needle, idx);
      if (p < 0) break;
      n += 1;
      idx = p + 1;
    }
    return n;
  }

  function peerPos(snap, peer, origStart, origEnd) {
    if (!peer) return -1;
    var idx = 0;
    var s = String(snap || "");
    while (true) {
      var p = s.indexOf(peer, idx);
      if (p < 0) return -1;
      if (p + peer.length <= origStart || p >= origEnd) return p;
      idx = p + 1;
    }
  }

  function stampProofItems(items, snap) {
    snap = String(snap || "");
    (items || []).forEach(function (it) {
      var orig = String(it.original || "");
      var a = Number(it.start);
      if (!(a >= 0)) a = Math.max(0, snap.indexOf(orig));
      it._nth = nthBefore(snap, orig, a);
      var peer = String(it.peer || "");
      if (peer) {
        var pp = peerPos(snap, peer, a, Number(it.end) || a + orig.length);
        it._peerStart = pp;
        it._peerNth = pp < 0 ? 0 : nthBefore(snap, peer, pp);
      }
    });
  }

  function proofLocOpts(item, which) {
    var snap = state.proofSnap || {};
    var peer = which === "peer";
    return {
      original: peer ? item.peer : item.original,
      start: peer ? item._peerStart : item.start,
      end: peer
        ? item._peerStart >= 0
          ? item._peerStart + String(item.peer || "").length
          : -1
        : item.end,
      nth: peer ? item._peerNth : item._nth,
      baseStart: snap.baseStart,
      snap: snap.text
    };
  }

  function wipeProofMark() {
    if (!window.GwDoc) return;
    if (GwDoc.clearProofPaint) GwDoc.clearProofPaint();
    if (GwDoc.scrubProofDirt) GwDoc.scrubProofDirt();
  }

  function locateProofItem(item, which) {
    if (!item || !window.GwDoc || !GwDoc.locateProofSpan) return;
    GwDoc.locateProofSpan(proofLocOpts(item, which || "orig"));
  }

  function setProofActive(idx, opts) {
    opts = opts || {};
    if (idx < 0 || idx >= state.proof.length) return;
    state.proofActive = idx;
    var box = $("aiOpts");
    if (!box) return;
    var cards = box.querySelectorAll("[data-proof-i]");
    Array.prototype.forEach.call(cards, function (el) {
      el.classList.toggle("on", Number(el.getAttribute("data-proof-i")) === idx);
    });
    var on = box.querySelector('[data-proof-i="' + idx + '"]');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    updateProofSum();
    if (opts.locate && !state.proof[idx]._applied) {
      state.proofJumpUntil = Date.now() + 900;
      try {
        locateProofItem(state.proof[idx], opts.peer ? "peer" : "orig");
      } catch (e) {
        tip(e.message);
      }
    }
  }

  function stopProofFollow() {
    if (state.proofFollowTimer) {
      clearInterval(state.proofFollowTimer);
      state.proofFollowTimer = null;
    }
  }

  function hitProofInPara(pos) {
    var best = -1;
    var bestDist = 1e15;
    state.proof.forEach(function (it, i) {
      if (it._applied || it._ignored) return;
      var spans = [[Number(it.start), Number(it.end)]];
      if (it._peerStart >= 0) {
        spans.push([
          it._peerStart,
          it._peerStart + String(it.peer || "").length
        ]);
      }
      spans.forEach(function (sp) {
        var a = sp[0];
        var b = sp[1];
        if (!(a >= 0 && b > a)) return;
        if (b <= pos.paraStart || a >= pos.paraEnd) return;
        var dist =
          pos.rel >= a && pos.rel <= b
            ? 0
            : pos.rel < a
              ? a - pos.rel
              : pos.rel - b;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
    });
    return best;
  }

  function startProofFollow() {
    stopProofFollow();
    if (state.tab !== "proof" || !state.proof.length) return;
    state.proofFollowTimer = setInterval(function () {
      if (state.tab !== "proof" || !state.proof.length) return;
      if (Date.now() < (state.proofJumpUntil || 0)) return;
      var snap = state.proofSnap;
      if (!snap || !window.GwDoc || !GwDoc.proofFollowPos) return;
      try {
        var pos = GwDoc.proofFollowPos(Number(snap.baseStart || 0));
        var hit = hitProofInPara(pos);
        if (hit >= 0 && hit !== state.proofActive) setProofActive(hit, {});
      } catch (eF) {}
    }, 250);
  }

  function shiftProofAfter(at, delta, oldText, newText) {
    var snap = state.proofSnap && state.proofSnap.text;
    if (snap && at >= 0) {
      var oldLen = String(oldText || "").length;
      state.proofSnap.text =
        snap.slice(0, at) + String(newText || "") + snap.slice(at + oldLen);
    }
    state.proof.forEach(function (it) {
      if (it._applied) return;
      var a = Number(it.start);
      var b = Number(it.end);
      if (a >= at) {
        it.start = a + delta;
        it.end = b + delta;
      } else if (b > at) {
        it.start = -1;
        it.end = -1;
      }
      if (it._peerStart >= 0 && it._peerStart >= at) it._peerStart += delta;
    });
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
    state.suiteBaselineItems = null;
  }

  /** 换钉前：把当前方案卡归档进最近一轮精修助手消息，对话不丢 */
  function archiveSuiteOptionsToChat() {
    if (!state.options || !state.options.length) return;
    var list = state.chatSuite || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var m = list[i];
      if (m && m.role === "assistant" && m.suite) {
        m.suiteOptions = state.options.slice();
        m.variants = state.options.slice();
        m.previewId = state.previewId || null;
        m.adoptedId = state.adoptedId || null;
        persistChat("suite_archive_pin");
        return;
      }
    }
  }

  function lastSuiteAssistantIndex() {
    var list = state.chatSuite || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].role === "assistant" && list[i].suite) return i;
    }
    return -1;
  }

  /** hist=只读历史卡；live=可预览/采用 */
  function buildSuiteOptCardHtml(opt, mode) {
    var hist = mode === "hist";
    var view = state.optView === "new" ? "new" : "diff";
    var badge = hist
      ? "历史"
      : state.adoptedId === opt.id
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
    var cls = "ai-opt" + (hist ? " suite-hist" : "");
    if (!hist && opt.recommend) cls += " recommend";
    if (!hist && state.adoptedId === opt.id) cls += " adopted";
    else if (!hist && state.previewId === opt.id) cls += " chosen";
    var actions = hist
      ? '<div class="ai-actions"><span class="ai-hist-note">仅供查看</span></div>'
      : '<div class="ai-actions">' +
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
    return (
      '<div class="' +
      cls +
      '">' +
      '<div class="ai-opt-head">' +
      '<span class="ai-tag">' +
      escHtml(opt.id) +
      "</span>" +
      (!hist && opt.recommend ? '<span class="ai-rec">推荐</span>' : "") +
      (!hist && opt.score ? "<span>" + escHtml(opt.score) + "分</span>" : "") +
      "<span>" +
      badge +
      "</span>" +
      (hist
        ? ""
        : '<div class="ai-view-tabs">' +
          '<button type="button" data-ai-view="diff" class="' +
          (view === "diff" ? "on" : "") +
          '">对照</button>' +
          '<button type="button" data-ai-view="new" class="' +
          (view === "new" ? "on" : "") +
          '">新稿</button></div>') +
      (hist
        ? ""
        : '<span class="diff-stat">删' +
          diff.del +
          " · 增" +
          diff.ins +
          "</span>") +
      "</div>" +
      (opt.note ? '<div class="ai-note">' + escHtml(opt.note) + "</div>" : "") +
      '<div class="' +
      bodyCls +
      '"' +
      (hist ? "" : ' data-ai-preview="' + escHtml(opt.id) + '"') +
      ">" +
      bodyHtml +
      "</div>" +
      actions +
      "</div>"
    );
  }

  function countSuiteChat() {
    var n = 0;
    (state.chatSuite || []).forEach(function (m) {
      if (m && m.suite) n++;
      else if (m) n++;
    });
    return n;
  }

  /** 把误写入撰写轨的精修消息挪回精修轨 */
  function rehomeMisplacedSuiteMessages() {
    if (!state.chatWrite || !state.chatWrite.length) return false;
    var moved = 0;
    var keep = [];
    state.chatWrite.forEach(function (m) {
      if (m && m.suite) {
        state.chatSuite.push(m);
        moved++;
      } else {
        keep.push(m);
      }
    });
    if (!moved) return false;
    state.chatWrite = keep;
    persistChat("rehome_suite");
    logInfo("chat.rehome_suite", { moved: moved, suiteN: state.chatSuite.length });
    return true;
  }

  function suiteSiblingIndices() {
    var items = state.work && state.work.items;
    if (!items || items.length < 2) return null;
    return items.map(function (it) {
      return it.index;
    });
  }

  /** 同级标题原文列表：优先按段落序号现读 */
  function suiteSiblingTexts() {
    var indices = suiteSiblingIndices();
    if (!indices) return null;
    if (GwDoc.headingTextsByIndices) {
      return GwDoc.headingTextsByIndices(indices);
    }
    return (state.work.items || []).map(function (it) {
      return String(it.text || "").trim();
    });
  }

  function resolveSuiteWriteLines(md, optItems) {
    var n = (state.work.items && state.work.items.length) || 0;
    var rows = null;
    if (Array.isArray(optItems) && optItems.length) {
      rows = optItems.map(function (x) {
        return String(x == null ? "" : x).trim();
      });
    } else {
      rows = String(md || "")
        .split(/\n\n+/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (rows.length !== n) {
        rows = String(md || "")
          .split(/\n+/)
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean);
      }
    }
    if (rows.length !== n) {
      throw new Error(
        "方案有 " + rows.length + " 条，钉住同级 " + n + " 条，请重新出方案"
      );
    }
    return rows;
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
    return (list || [])
      .filter(function (o) {
        return o && String(o.md || "").replace(/\s/g, "").length >= 20;
      })
      .slice(0, 6);
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
    var msg = writeChat()[mi];
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
      !writeChat()[mi] ||
      !writeChat()[mi].variants ||
      !writeChat()[mi].variants[vi]
    ) {
      return;
    }
    state.baseDraft = { mi: mi, vi: vi };
    logInfo("draft.base", { mi: mi, vi: vi, reason: reason || "" });
  }

  /** 当前续改底稿 md：仅用户采用过的卡；禁止回落「最近一组 options」以防换节串味 */
  function resolveBaseDraftMd() {
    var b = state.baseDraft;
    if (
      b &&
      writeChat()[b.mi] &&
      writeChat()[b.mi].variants &&
      writeChat()[b.mi].variants[b.vi]
    ) {
      return String(writeChat()[b.mi].variants[b.vi].md || "");
    }
    return "";
  }

  function isBaseDraftCard(mi, vi) {
    var b = state.baseDraft;
    return !!(b && b.mi === mi && b.vi === vi);
  }

  function bindBubblePin(bubble) {
    bubble.pinBound = true;
    if (
      state.work &&
      typeof state.work.start === "number" &&
      typeof state.work.end === "number"
    ) {
      bubble.pinStart = state.work.start;
      bubble.pinEnd = state.work.end;
    }
  }

  function rebaseLastWritePin(start, end) {
    var list = activeChat() || [];
    var i;
    for (i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].pinBound) {
        list[i].pinStart = start;
        list[i].pinEnd = end;
        return;
      }
    }
  }

  /** 落稿后钉子跟到新范围，避免芯片变「未钉住」、下一轮丢【钉住】 */
  function retargetWorkAfterWrite(md, startHint) {
    var info = null;
    try {
      info = GwDoc.getSelectionInfo();
    } catch (e) {}
    var start =
      typeof startHint === "number"
        ? startHint
        : info && typeof info.start === "number"
          ? info.start
          : null;
    var end =
      info && typeof info.end === "number"
        ? info.end
        : info && typeof info.start === "number"
          ? info.start
          : start;
    var text = String(md || "");
    if (!text.replace(/\s/g, "") && info) text = String(info.text || "");
    if (!text.replace(/\s/g, "") || typeof start !== "number") return;
    if (typeof end !== "number" || end <= start) {
      if (state.work) state.work.text = text;
      renderWorkChip();
      persistChat("pin_retarget_text");
      return;
    }
    if (!state.work) {
      state.work = { heading: null, items: null, endsWithPara: false };
    }
    state.work.text = text;
    state.work.start = start;
    state.work.end = end;
    if (info && info.heading) state.work.heading = info.heading;
    if (info) state.work.endsWithPara = !!info.endsWithPara;
    rebaseLastWritePin(start, end);
    renderWorkChip();
    persistChat("pin_retarget");
  }

  function currentWorkPin() {
    if (
      state.work &&
      typeof state.work.start === "number" &&
      typeof state.work.end === "number"
    ) {
      return { start: state.work.start, end: state.work.end };
    }
    return null;
  }

  /** 本轮可落稿的结论卡：最后一条带 variants 的助手消息，且其后还没有新的用户发送 */
  function liveWriteAssistantIndex() {
    if (state.writeLiveFrozen) return -1;
    var list = writeChat() || [];
    var lastAsst = -1;
    var i;
    for (i = list.length - 1; i >= 0; i--) {
      if (
        list[i] &&
        list[i].role === "assistant" &&
        list[i].variants &&
        list[i].variants.length
      ) {
        lastAsst = i;
        break;
      }
    }
    if (lastAsst < 0) return -1;
    for (i = lastAsst + 1; i < list.length; i++) {
      if (list[i] && list[i].role === "user") return -1;
    }
    return lastAsst;
  }

  /** @deprecated 由 Kernel.assembleWriteLayers 替代；保留兜底 */
  function baseDraftConstraint() {
    var md = resolveBaseDraftMd();
    if (!String(md || "").replace(/\s/g, "")) return "";
    return "\n【焦点·L3·当前结论底稿】\n" + String(md).slice(0, 10000) + "\n";
  }

  function handleCardApply(mode, src) {
    var loc = parseCardSrc(src);
    var writeMode = mode === "full" || mode === "cursor" || mode === "sel";
    if (writeMode && (!loc || loc.mi !== liveWriteAssistantIndex())) {
      tip("上一轮结论仅供查看，请用本轮卡片落稿");
      return;
    }
    if (loc) markBaseDraft(loc.mi, loc.vi, "card_" + mode);
    var md = resolveChatMd(src);
    if (mode === "full") applyDraftFull(md);
    else if (mode === "cursor") applyDraftCursor(md);
    else if (mode === "sel") applyDraftSelection(md);
    else if (mode === "copy") copyDocDraft(md);
    else return;
    renderOpts();
  }

  function captureTurnAutoVersion() {
    state.pendingTurnAutoRel = "";
    if (!window.GwProject || !GwProject.saveAutoVersion) {
      return { ok: false, soft: true, error: "工程模块未就绪" };
    }
    try {
      var kind = state.tab === "suite" ? "suite" : "write";
      var sv = GwProject.saveAutoVersion(kind);
      if (sv && sv.ok && sv.path) {
        state.pendingTurnAutoRel = String(sv.path);
        return sv;
      }
      return {
        ok: false,
        soft: true,
        error: (sv && sv.error) || "自动备份失败"
      };
    } catch (e) {
      return { ok: false, soft: true, error: String(e.message || e) };
    }
  }

  function saveVersionOrThrow() {
    var rel = String(state.pendingTurnAutoRel || "");
    if (
      rel &&
      window.GwProject &&
      GwProject.relExists &&
      GwProject.relExists(rel)
    ) {
      return { ok: true, path: rel, reused: true };
    }
    var saveFn =
      window.GwProject &&
      (GwProject.saveAutoVersion || GwProject.saveActiveToVersion);
    if (!saveFn) {
      throw new Error("无法存版本：工程模块未就绪");
    }
    var sv = saveFn.call(
      GwProject,
      state.tab === "suite" ? "suite" : "write"
    );
    if (!sv || !sv.ok) {
      throw new Error((sv && sv.error) || "存版本失败，已中止写入");
    }
    if (sv.path) state.pendingTurnAutoRel = String(sv.path);
    return sv;
  }

  function restoreTurnByMi(mi) {
    var lane = state.tab === "suite" ? state.chatSuite : state.chatWrite;
    var msg = (lane || [])[mi | 0];
    if (!msg || !msg.autoVersionRel) {
      tip("本轮没有可还原的版本");
      return;
    }
    var rel = String(msg.autoVersionRel);
    if (
      !window.GwProject ||
      !GwProject.isAutoRestoreable ||
      !GwProject.isAutoRestoreable(rel)
    ) {
      tip("本轮自动档已不在（只留最近 10 份）");
      return;
    }
    tip("正在还原本轮…");
    var rv;
    try {
      rv = GwProject.restoreVersionToActive(rel);
    } catch (e) {
      tip(e.message || "还原失败");
      alert(e.message || e);
      return;
    }
    if (!rv || !rv.ok) {
      tip((rv && rv.error) || "还原失败");
      try {
        if (rv && rv.error) alert(rv.error);
      } catch (a0) {}
      return;
    }
    tip("已还原本轮发送前正文");
    freezeLiveTurnActions();
  }

  /** 还原本轮后与点发送后相同：当前轮预览/采用/整篇/光标/选定收掉 */
  function freezeLiveTurnActions() {
    state.writeLiveFrozen = true;
    if (state.options && state.options.length) {
      archiveSuiteOptionsToChat();
      clearSuiteSuggestions();
    }
    renderOpts();
    syncTabUi();
    syncRestoreBtn();
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
          (sv.reused
            ? "本轮已备份"
            : sv.path
              ? String(sv.path).replace(/^.*[\\\/]/, "")
              : "已保存")
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
            try {
              var secAfter =
                GwDoc.selectHeadingSection && GwDoc.selectHeadingSection();
              if (secAfter && typeof secAfter.start === "number") {
                state.work.start = secAfter.start;
                state.work.end = secAfter.end;
                state.work.text = secAfter.text || text;
                state.work.endsWithPara = true;
                rebaseLastWritePin(secAfter.start, secAfter.end);
                renderWorkChip();
                persistChat("pin_retarget");
              } else {
                retargetWorkAfterWrite(text, state.work.start);
              }
            } catch (eAfter) {
              retargetWorkAfterWrite(text, state.work.start);
            }
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
        retargetWorkAfterWrite(text, coverStart);
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

  function clearActivePinChat() {
    if (state.tab === "suite") state.chatSuite = [];
    else state.chatWrite = [];
  }

  /**
   * 换钉前：正文上若还叠着未采用的预览，先揭掉再清活方案。
   * 已采用的改动是定稿，换钉不得还原。侧栏对话保留，发给模型仍按钉过滤。
   */
  function resetSuiteForNewPin() {
    archiveSuiteOptionsToChat();
    if (
      state.tab === "suite" &&
      state.work &&
      state.suiteBaseline &&
      state.previewId &&
      !state.adoptedId
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
    /* 钉住即换工作选区：旧精修活方案作废；对话不清 */
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
    persistChat("pin");
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
      state.previewId &&
      !state.adoptedId
    ) {
      try {
        writeWorkText(state.suiteBaseline);
      } catch (e) {}
    }
    state.work = null;
    clearActivePinChat();
    clearSuiteSuggestions();
    state.selPopOpen = false;
    syncRestoreBtn();
    renderWorkChip();
    renderOpts();
    if (state.tab === "write") syncWriteLevelPrompt();
    persistChat("unpin");
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
      var items = null;
      if (o && Array.isArray(o.items) && o.items.length) {
        items = o.items.map(function (x) {
          return String(x == null ? "" : x).trim();
        });
      }
      return {
        id: String((o && o.id) || String.fromCharCode(65 + idx)),
        md:
          String((o && (o.md || o.text || o.content)) || "") ||
          (items ? items.join("\n\n") : ""),
        note: (o && o.note) || "",
        recommend: !!(o && o.recommend),
        score: o && o.score,
        items: items
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
    /* 精修：有出方案原文即可还原选区（不依赖 hidden，WPS 下 [hidden] 会盖掉 display） */
    var show =
      state.tab === "suite" && !!(state.work && state.suiteBaseline);
    if (show) {
      btn.removeAttribute("hidden");
      btn.classList.add("show");
    } else {
      btn.setAttribute("hidden", "hidden");
      btn.classList.remove("show");
    }
    btn.disabled = !!state.busy;
    btn.title = "还原为出方案前的选区原文";
  }

  /** 按钉子范围写回；同级多标题则逐条替换全部 */
  function writeWorkText(md, opts) {
    opts = opts || {};
    if (!state.work) throw new Error("请先钉住选区");
    var multi = state.work.items && state.work.items.length > 1;
    if (multi) {
      var lines = resolveSuiteWriteLines(md, opts.items);
      var indices = suiteSiblingIndices();
      var rMulti = GwDoc.replaceSiblingHeadings(indices, lines);
      state.work.text = lines.join("\n\n");
      state.work.items = state.work.items.map(function (it, i) {
        return {
          index: it.index,
          lvl: it.lvl,
          via: it.via,
          text: lines[i]
        };
      });
      state.work.start = rMulti.start;
      state.work.end = rMulti.end;
      rebaseLastWritePin(rMulti.start, rMulti.end);
      renderWorkChip();
      syncRestoreBtn();
      return true;
    }
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
    rebaseLastWritePin(r.start, r.end);
    renderWorkChip();
    syncRestoreBtn();
    return true;
  }

  function previewOpt(id) {
    if (!state.options.length) return;
    var opt = findOpt(id);
    if (!opt || !state.work) return;
    try {
      /* 切换方案前先回到原文锚点内容，再叠新预览（对标 restoreDocPreview + apply） */
      if (state.previewId && state.previewId !== id && state.suiteBaseline) {
        if (
          !writeWorkText(state.suiteBaseline, {
            items: state.suiteBaselineItems
          })
        )
          return;
      }
      if (!writeWorkText(opt.md || "", { items: opt.items })) return;
      state.previewId = id;
      state.adoptedId = null;
      renderOpts();
      syncTabUi();
      tip(
        "预览方案 " +
          id +
          (state.work.items && state.work.items.length > 1
            ? "（已整组写回 " + state.work.items.length + " 条）"
            : "（已叠到正文）")
      );
    } catch (e) {
      tip(e.message || "预览失败");
      alert(e.message || e);
    }
  }

  function stampAdoptedOnLastBubble(id) {
    var list = activeChat() || [];
    var i;
    for (i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].role === "assistant" && list[i].variants && list[i].variants.length) {
        list[i].adoptedId = id;
        return;
      }
    }
  }

  function adoptOpt(id) {
    if (!state.options.length) return;
    var opt = findOpt(id);
    if (!opt || !state.work) return;
    try {
      if (state.previewId === id) {
        /* 已在预览同一方案：正文已是目标，直接确认 */
        state.adoptedId = id;
        state.previewId = null;
      } else {
        if (state.previewId && state.suiteBaseline) {
          if (
            !writeWorkText(state.suiteBaseline, {
              items: state.suiteBaselineItems
            })
          )
            return;
        }
        if (!writeWorkText(opt.md || "", { items: opt.items })) return;
        state.adoptedId = id;
        state.previewId = null;
      }
      stampAdoptedOnLastBubble(id);
      persistChat("adopt");
      renderOpts();
      syncTabUi();
      tip(
        "已采用方案 " +
          id +
          (state.work.items && state.work.items.length > 1
            ? " · 整组 " + state.work.items.length + " 条"
            : "") +
          " · 可还原"
      );
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
      if (
        !writeWorkText(state.suiteBaseline, {
          items: state.suiteBaselineItems
        })
      )
        return;
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
    var aside = $("aiAside");
    if (aside) aside.classList.toggle("is-proof", tab === "proof");
    if ($("aiCompose")) $("aiCompose").hidden = false;
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
    $("aiClearChat").hidden = tab === "proof";
    setProofClearEnabled();
    var ha = $("aiHeadActions");
    if (ha) ha.hidden = false;
    var lv = selectedWriteLevels();
    var liveMi = tab === "write" ? liveWriteAssistantIndex() : -1;
    var liveHasCards =
      liveMi >= 0 &&
      writeChat()[liveMi] &&
      writeChat()[liveMi].variants &&
      writeChat()[liveMi].variants.length;
    $("aiReq").placeholder =
      tab === "suite"
        ? "写精修要求，或点上方充填 / 润色…"
        : liveHasCards
          ? "可直接说：用第二组再短一点；或点卡片写入"
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
            ? state.proof && state.proof.length
              ? "点条即可定位；再点开始校对会重新检查"
              : "选范围后点开始校对"
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

  function proofKindLabel(item) {
    if (item.type === "duplicate") {
      var t = "内容重复";
      if (item.path && item.peerPath) t += " · " + item.path + " ↔ " + item.peerPath;
      return t;
    }
    return (
      {
        typo: "错字",
        punctuation: "标点",
        format: "格式",
        grammar: "语法",
        dictionary: "词库",
        sensitive: "规范",
        style: "文风",
        logic: "逻辑",
        dataverify: "数据"
      }[item.type] ||
      item.type ||
      "问题"
    );
  }

  function updateProofSum() {
    var el = $("proofSum");
    if (!el) return;
    var vis = [];
    (state.proof || []).forEach(function (it, i) {
      if (!it._ignored) vis.push(i);
    });
    var n = vis.length;
    if (state.tab !== "proof" || !n) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    var s = n + " 处 · 点条即定位";
    var k = vis.indexOf(state.proofActive);
    if (k >= 0) s += " · 当前第 " + (k + 1) + " 条";
    el.textContent = s;
  }

  function nextVisibleProof(from) {
    var i;
    for (i = from + 1; i < state.proof.length; i++) {
      if (!state.proof[i]._ignored) return i;
    }
    for (i = from - 1; i >= 0; i--) {
      if (!state.proof[i]._ignored) return i;
    }
    return -1;
  }

  function hideProofCard(idx) {
    var item = state.proof[idx];
    if (!item) return;
    item._ignored = true;
    wipeProofMark();
    var next = nextVisibleProof(idx);
    state.proofActive = next;
    persistChat("proof_ignore");
    renderOpts();
    if (next >= 0) setProofActive(next, {});
  }

  function bindProofCard(div, item, idx) {
    div.querySelector('[data-act="go"]').onclick = function (ev) {
      ev.stopPropagation();
      setProofActive(idx, { locate: true });
    };
    var peerBtn = div.querySelector('[data-act="goPeer"]');
    if (peerBtn) {
      peerBtn.onclick = function (ev) {
        ev.stopPropagation();
        setProofActive(idx, { locate: true, peer: true });
      };
    }
    var fixBtn = div.querySelector('[data-act="fix"]');
    if (fixBtn) {
      if (item._applied) fixBtn.disabled = true;
      fixBtn.onclick = function (ev) {
        ev.stopPropagation();
        if (item._applied) return;
        try {
          GwDoc.applyProofSpan(proofLocOpts(item, "orig"), item.suggestion);
          wipeProofMark();
          var at = Number(item.start);
          item._applied = true;
          shiftProofAfter(
            at,
            String(item.suggestion || "").length -
              String(item.original || "").length,
            item.original,
            item.suggestion
          );
          stampProofItems(state.proof, state.proofSnap && state.proofSnap.text);
          persistChat("proof_apply");
          renderOpts();
          setProofActive(idx, {});
        } catch (e) {
          tip(e.message);
        }
      };
    }
    var wlBtn = div.querySelector('[data-act="wl"]');
    if (wlBtn) {
      wlBtn.onclick = function (ev) {
        ev.stopPropagation();
        hideProofCard(idx);
        tip("已忽略");
      };
    }
    var banBtn = div.querySelector('[data-act="ban"]');
    if (banBtn) {
      banBtn.onclick = function (ev) {
        ev.stopPropagation();
        if (!window.GwProofIngest) return;
        GwProofIngest.absorbIssue("whitelist", item)
          .then(function () {
            hideProofCard(idx);
            tip("已永久不报");
          })
          .catch(function (e) {
            tip(e.message || "写入失败");
          });
      };
    }
    var mfBtn = div.querySelector('[data-act="mf"]');
    if (mfBtn) {
      mfBtn.onclick = function (ev) {
        ev.stopPropagation();
        if (!window.GwProofIngest) return;
        GwProofIngest.absorbIssue("mustfix", item)
          .then(function () {
            tip("已收入必改");
          })
          .catch(function (e) {
            tip(e.message || "收入失败");
          });
      };
    }
    div.onclick = function () {
      setProofActive(idx, { locate: !item._applied });
    };
  }

  function appendProofCard(box, item, idx) {
    var isDup = item.type === "duplicate";
    var explain = item.reason || (isDup ? item.suggestion || "" : "");
    var div = document.createElement("div");
    div.setAttribute("data-proof-i", String(idx));
    div.className =
      "ai-err" +
      (isDup ? " ai-err-dup" : "") +
      (idx === state.proofActive ? " on" : "") +
      (item._applied ? " applied" : "");
    div.innerHTML =
      '<div class="ai-err-type"></div>' +
      (isDup
        ? '<div class="ai-err-verdict"><div class="ai-err-dup-a"></div>' +
          (item.peer ? '<div class="ai-err-dup-b"></div>' : "") +
          "</div>"
        : '<div class="ai-err-verdict"><del></del><span class="ai-err-arrow">→</span><ins></ins></div>') +
      (explain ? '<div class="ai-err-reason"></div>' : "") +
      '<div class="ai-err-acts">' +
      (isDup
        ? '<button type="button" data-act="go">定位</button>' +
          (item.peer
            ? '<button type="button" data-act="goPeer">另处</button>'
            : "")
        : '<button type="button" class="primary" data-act="fix">采纳</button>' +
          '<button type="button" data-act="wl">忽略</button>' +
          '<button type="button" class="ai-linkish" data-act="ban">永久不报</button>' +
          '<button type="button" class="ai-linkish" data-act="mf">必须改</button>' +
          '<button type="button" class="ai-err-go" data-act="go">定位</button>') +
      "</div>";
    div.querySelector(".ai-err-type").textContent = proofKindLabel(item);
    if (explain) div.querySelector(".ai-err-reason").textContent = explain;
    if (isDup) {
      div.querySelector(".ai-err-dup-a").textContent =
        "此处：" + (item.original || "");
      if (item.peer) {
        div.querySelector(".ai-err-dup-b").textContent = "另处：" + item.peer;
      }
    } else {
      div.querySelector("del").textContent = item.original || "";
      div.querySelector("ins").textContent = item.suggestion || "";
    }
    bindProofCard(div, item, idx);
    box.appendChild(div);
  }

  function shouldShowTurnRestore(m) {
    if (!m || m.role !== "assistant") return false;
    if (m.autoVersionRel) return true;
    if (m.suite) return true;
    if (m.variants && m.variants.length) return true;
    return false;
  }

  function appendTurnRestore(parent, m, mi) {
    var row = document.createElement("div");
    row.className = "ai-turn-restore";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "还原本轮";
    btn.setAttribute("data-restore-turn", String(mi));
    var can = false;
    try {
      can = !!(
        m.autoVersionRel &&
        window.GwProject &&
        GwProject.isAutoRestoreable &&
        GwProject.isAutoRestoreable(m.autoVersionRel)
      );
    } catch (eCan) {}
    btn.disabled = !can;
    btn.title = can
      ? "恢复到本轮发送前的整篇正文"
      : m.autoVersionRel
        ? "本轮自动档已不在（只留最近 10 份）"
        : "本轮没有自动档";
    row.appendChild(btn);
    parent.appendChild(row);
  }

  function renderOpts() {
    var box = $("aiOpts");
    if (!box) return;
    box.innerHTML = "";
    if (state.tab !== "proof") updateProofSum();
    if (state.tab === "proof") {
      if (!state.proof.length) {
        updateProofSum();
        box.innerHTML =
          '<div class="ai-empty">点上方「开始校对」；结果点条目可定位。<br/>' +
          '<button type="button" class="ai-linkish" id="proofEmptySet">检查项（含内容重复）→ 设置</button></div>';
        var emptySet = $("proofEmptySet");
        if (emptySet) {
          emptySet.onclick = function () {
            if (window.GwSettingsUI) GwSettingsUI.open("proof");
          };
        }
        return;
      }
      var vis = 0;
      state.proof.forEach(function (item, idx) {
        if (item._ignored) return;
        vis += 1;
        appendProofCard(box, item, idx);
      });
      if (!vis) {
        box.innerHTML =
          '<div class="ai-empty">本轮已全部忽略。再点「开始校对」会重新检查。</div>';
      }
      updateProofSum();
      return;
    }

    if (state.tab === "suite") {
      if (!state.options.length && !countSuiteChat()) {
        box.innerHTML =
          '<div class="ai-empty"><b>精修会改写选定</b>：划选并钉住 → 充填/润色或写要求 → 出方案 → 预览/采用</div>';
        return;
      }
      box.innerHTML = "";
      var liveAsst = state.options.length ? lastSuiteAssistantIndex() : -1;
      if (countSuiteChat()) {
        var slog = document.createElement("div");
        slog.className = "ai-chat-log suite-turns";
        state.chatSuite.forEach(function (m, mi) {
          if (!m) return;
          var sb = document.createElement("div");
          sb.className =
            "ai-bubble " + (m.role === "user" ? "user" : "assistant");
          var sbody = document.createElement("div");
          sbody.className = "ai-bubble-text";
          sbody.textContent = m.text;
          sb.appendChild(sbody);
          if (shouldShowTurnRestore(m)) appendTurnRestore(sb, m, mi);
          slog.appendChild(sb);
          /* 历史方案卡：换钉后仍可见；当前活轮由下方 live 卡负责，避免重复 */
          if (
            m.role === "assistant" &&
            m.suiteOptions &&
            m.suiteOptions.length &&
            mi !== liveAsst
          ) {
            m.suiteOptions.forEach(function (opt) {
              var wrap = document.createElement("div");
              wrap.innerHTML = buildSuiteOptCardHtml(opt, "hist");
              if (wrap.firstChild) slog.appendChild(wrap.firstChild);
            });
          }
        });
        if (slog.childNodes.length) box.appendChild(slog);
      }
      if (!state.options.length) {
        if (!box.childNodes.length) {
          box.innerHTML =
            '<div class="ai-empty"><b>精修会改写选定</b>：划选并钉住 → 充填/润色或写要求 → 出方案 → 预览/采用</div>';
        } else {
          var hint = document.createElement("div");
          hint.className = "ai-empty suite-repin-hint";
          hint.textContent = "已换钉 · 再出方案即可；上方为历史对话与方案";
          box.appendChild(hint);
        }
        box.onclick = function (ev) {
          var t = ev.target;
          var rb = t.closest ? t.closest("[data-restore-turn]") : null;
          if (rb) restoreTurnByMi(rb.getAttribute("data-restore-turn") || "");
        };
        return;
      }
      state.options.forEach(function (opt) {
        var wrap = document.createElement("div");
        wrap.innerHTML = buildSuiteOptCardHtml(opt, "live");
        if (wrap.firstChild) box.appendChild(wrap.firstChild);
      });
      box.onclick = function (ev) {
        var t = ev.target;
        if (!t) return;
        var rb = t.closest ? t.closest("[data-restore-turn]") : null;
        if (rb) {
          restoreTurnByMi(rb.getAttribute("data-restore-turn") || "");
          return;
        }
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

    if (!activeChat().length) {
      box.innerHTML =
        '<div class="ai-empty">撰写：点选「一级/二级/三级/正文」→ 在下方直接说要求 → 发送。形态说明会静默带给模型；卡片上用选定或光标写入。</div>';
      return;
    }
    var log = document.createElement("div");
    log.className = "ai-chat-log";
    var liveMi = liveWriteAssistantIndex();
    activeChat().forEach(function (m, mi) {
      var b = document.createElement("div");
      b.className = "ai-bubble " + (m.role === "user" ? "user" : "assistant");
      var body = document.createElement("div");
      body.className = "ai-bubble-text";
      body.textContent = m.text;
      b.appendChild(body);
      if (shouldShowTurnRestore(m)) appendTurnRestore(b, m, mi);
      if (m.role === "assistant" && m.variants && m.variants.length) {
        var liveCard = mi === liveMi;
        m.variants.forEach(function (v, vi) {
          var card = document.createElement("div");
          card.className =
            "ai-variant" +
            (isBaseDraftCard(mi, vi) ? " is-base" : "") +
            (liveCard ? "" : " write-hist");
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
          if (liveCard) {
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
          } else {
            var histNote = document.createElement("span");
            histNote.className = "ai-hist-note";
            histNote.textContent = "上一轮结论 · 仅供查看";
            acts.appendChild(histNote);
            var copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.textContent = "复制";
            copyBtn.title = "复制到剪贴板";
            copyBtn.setAttribute("data-apply", "copy");
            copyBtn.setAttribute("data-src", src);
            acts.appendChild(copyBtn);
          }
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
      var restoreBtn = t.closest ? t.closest("[data-restore-turn]") : null;
      if (restoreBtn) {
        restoreTurnByMi(restoreBtn.getAttribute("data-restore-turn") || "");
        return;
      }
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
    if (!on) {
      state.busyPhase = "";
      stopBusyTicker();
    } else {
      if (!state.busyPhase) {
        state.busyPhase = state.tab === "suite" ? "出方案中" : "处理中";
      }
      startBusyTicker();
      paintBusyTip();
    }
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
    if (wait > 240000) {
      setBusy(false);
      tip("上次请求超时，已解锁，请再发一次");
      logWarn("send.busy_timeout", { wait: wait });
      return true;
    }
    paintBusyTip();
    return false;
  }

  function doSend() {
    try {
      logInfo("send.click", {
        tab: state.tab,
        busy: !!state.busy,
        busyAt: state.busyAt || 0
      });
      releaseBusyIfStuck();
      if (state.busy) {
        var wait = state.busyAt ? Date.now() - state.busyAt : 0;
        if (wait > 1500) {
          setBusy(false);
          tip("已解锁卡住的发送，正在重发…");
          logWarn("send.force_unlock", { wait: wait });
        } else {
          tip("仍在发送中（" + Math.round(wait / 100) / 10 + "s），请稍候…");
          return;
        }
      }
      if (state._sendLockAt && Date.now() - state._sendLockAt < 400) {
        logInfo("send.debounce", {});
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
  function chatHistoryForRelay(list) {
    var raw = list || writeChat() || [];
    if (window.GwContextKernel && GwContextKernel.pruneHistory) {
      return GwContextKernel.pruneHistory(raw, 10, currentWorkPin());
    }
    return raw
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
    return "";
  }

  function sendWrite() {
    tip("准备发送…");
    var levels = selectedWriteLevels();
    var wantDraft = wantDraftChecked();
    var wantVars = wantVariantsChecked();
    var allow = wantDraft || wantVars;
    var msg = ($("aiReq").value || "").trim();
    logInfo("send.write", {
      allow: allow,
      levels: levels,
      msgLen: msg.length,
      route: allow ? "talk=fast,final=strong" : "talk=fast"
    });
    if (allow && !levels.length) {
      tip("请先点选一级 / 二级 / 三级 / 正文");
      logWarn("send.block", "no_levels");
      return;
    }
    if (!msg && !allow) {
      tip("请先输入内容，或点选层级并勾选「出结论/给多份」");
      logWarn("send.block", "empty");
      return;
    }
    var displayMsg = msg;
    if (!displayMsg && allow) {
      displayMsg = "请按已点选的产出层级给出结论。";
    }

    /* 发出即收掉上一轮整篇/光标/选定，不等登录或模型返回 */
    state.writeLiveFrozen = true;
    renderOpts();

    if (!state.taskCard && window.GwContextKernel) {
      state.taskCard = GwContextKernel.emptyCard();
    }

    var classified = { intent: "", confidence: 1, focusLine: "", soft: false };

    var assembled = { block: "", trace: {} };
    var pinText = workText();
    var docMd = currentDocMd();
    var hist = [];
    var matCount = 0;
    try {
      if (window.GwMaterialIndex && GwMaterialIndex.workspaceForAi) {
        var wsInv = GwMaterialIndex.workspaceForAi() || {};
        matCount = (wsInv.materials && wsInv.materials.length) || 0;
      }
    } catch (eInv) {}
    if (window.GwContextKernel && GwContextKernel.buildContextInventory) {
      assembled = GwContextKernel.buildContextInventory({
        displayMsg: displayMsg,
        pinText: pinText || "",
        pinChars: String(pinText || "").replace(/\s/g, "").length,
        docChars: String(docMd || "").replace(/\s/g, "").length,
        matCount: matCount
      });
      logInfo("ctx.trace", assembled.trace);
    } else {
      assembled.block = "";
    }
    var matsEarly = citedMaterials();
    refreshStyleFingerprint();
    paintUnderstandBar(classified, assembled, null);

    var mats = matsEarly;
    var contextBag = {
      pin: pinText || "",
      doc_full: docMd || ""
    };
    var sendMsg = buildWriteUserPacket(
      displayMsg,
      pinText,
      assembled.block,
      pinHistoryBlock(writeChat())
    );
    withLogin(function () {
      setBusy(true);
      tipProgress(allow ? "撰写中…" : "聊天中…");
      try {
        /* 纯聊天不存；出结论 / 给多份 才存发送前整篇 */
        if (allow) {
          var autoSv = captureTurnAutoVersion();
          if (!autoSv.ok) {
            tip("自动备份未成功，仍继续发送");
            logWarn("turn.auto_version", autoSv.error || "fail");
          }
        } else {
          state.pendingTurnAutoRel = "";
        }
        state.chatWrite.push({ role: "user", text: displayMsg });
        persistChat("user_send");
        logInfo("chat.user", {
          n: state.chatWrite.length,
          len: String(displayMsg || "").length,
          levels: selectedWriteLevels(),
          wantDraft: wantDraftChecked(),
          wantVars: wantVariantsChecked(),
          histN: hist.length,
          intent: classified.intent,
          confidence: classified.confidence,
          inventory: assembled.trace
        });
        $("aiReq").value = "";
        renderOpts();
        hideReadBar();
        var runner =
          window.GwChatLoop && GwChatLoop.runChat
            ? GwChatLoop.runChat({
                message: sendMsg,
                contextMd: "",
                doc_md: "",
                capability: allow
                  ? capabilityWriteFinal()
                  : capabilityWriteTalk(),
                talkCapability: capabilityWriteTalk(),
                finalCapability: allow
                  ? capabilityWriteFinal()
                  : capabilityWriteTalk(),
                allowEdit: allow,
                materials: mats,
                history: hist,
                session_summary: "",
                read_set: (state.readSet || []).slice(),
                contextBag: contextBag,
                want_options: !!wantVars,
                write_levels: levels,
                onStatus: function (s) {
                  var t = String(s || "");
                  if (/已自动精读|自动精读失败|正在自动精读|已回灌/.test(t)) tip(t);
                  else if (/索引|同步|准备素材|工程目录/.test(t))
                    tipProgress("正在准备材料…");
                  else if (
                    /执行|read_file|list_files|search|fetch_context|查阅|准备材料/.test(
                      t
                    )
                  )
                    tipProgress("正在准备材料…");
                  else if (/终稿|打包|增强|作答/.test(t))
                    tipProgress(allow ? "终稿生成中…" : "聊天中…");
                  else tipProgress(allow ? "撰写中…" : "聊天中…");
                }
              })
            : GwRelay.chat(
                sendMsg,
                "",
                allow ? capabilityWriteFinal() : capabilityWriteTalk(),
                allow,
                mats,
                {
                history: hist,
                session_summary: "",
                doc_md: "",
                read_set: (state.readSet || []).slice(),
                want_options: !!wantVars,
                write_levels: levels
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
              variants: variants,
              autoVersionRel: state.pendingTurnAutoRel || ""
            };
            if (variants && variants.length) bindBubblePin(bubble);
            state.writeLiveFrozen = !(variants && variants.length);
            if (wantVars && variants.length >= 2) {
              bubble.text =
                reply +
                (/\n/.test(reply) ? "\n\n" : "\n") +
                "（以下 " +
                variants.length +
                " 组参考，用卡片「选定 / 光标 / 整篇」写入；也可直接说「用第二组再短一点」。）";
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
                "（用卡片按钮写入；也可直接再说要求续改。）";
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
            state.chatWrite.push(bubble);
            /* 出多份不自动设 baseDraft；仅用户选定/光标/整篇才设（打包与取舍补丁） */
            persistChat("assistant_ok");
            logInfo("chat.assistant", {
              n: state.chatWrite.length,
              variants: (bubble.variants && bubble.variants.length) || 0,
              replyLen: String(bubble.text || "").length,
              base: state.baseDraft
            });
            renderOpts();
            syncTabUi();
            var qchk = runDraftGate(checkMd, classified);
            /* 不把交稿闸长文塞进对话气泡，避免占屏 */
            setBusy(false);
            if (!allow || !checkMd) return null;
            tip(
              ((state.lastUnderstand && state.lastUnderstand.line) ||
                "对齐") + " · 交稿深检…"
            );
            return runModelCritic(checkMd, classified)
              .then(function (modelChk) {
                if (!modelChk) return;
                var merged = GwQualityKernel.mergeCritic(qchk, modelChk);
                hideQualityBar();
                tip(merged.tip);
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
                tip("深检未完成（不影响已出稿）");
              });
          })
          .catch(function (e) {
            var err =
              (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
              e.message ||
              "失败";
            tip(err);
            logWarn("chat.fail", err);
            state.chatWrite.push({
              role: "assistant",
              text:
                "失败：" +
                err +
                "\n\n（中转不可用时不再本地拼装提纲，请恢复中转后重发，由模型生成。）",
              autoVersionRel: state.pendingTurnAutoRel || ""
            });
            persistChat("assistant_fail");
            renderOpts();
          })
          .then(function () {
            if (state.busy) setBusy(false);
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
    var needPin =
      !window.GwSettings ||
      !GwSettings.suiteRequireSelection ||
      GwSettings.suiteRequireSelection();
    if (!workText().replace(/\s/g, "")) {
      if (needPin) {
        tip("精修须先钉住");
        alert("请先在正文划选，再点「钉住」");
        return;
      }
      tip("无钉住选区");
      alert("请先划选正文");
      return;
    }
    var req = ($("aiReq").value || "").trim() || "优化表述，更准确凝练";
    var citeMats = citedMaterials();
    withLogin(function () {
      setBusy(true);
      setBusyPhase("精修中…");
      hideReadBar();
      var autoSv = captureTurnAutoVersion();
      if (!autoSv.ok) {
        tip("自动备份未成功，仍继续出方案");
        logWarn("suite.auto_version", autoSv.error || "fail");
      }
      var siblingTexts = null;
      try {
        siblingTexts = suiteSiblingTexts();
      } catch (eSib) {
        tip(eSib.message || "同级锚点失效");
        alert(eSib.message || eSib);
        setBusy(false);
        return Promise.resolve();
      }
      /* 出方案前记下原文，还原选区用这一份（勿等返回后再读，以免已预览） */
      state.suiteBaseline =
        siblingTexts && siblingTexts.length >= 2
          ? siblingTexts.join("\n\n")
          : workText();
      state.suiteBaselineItems =
        siblingTexts && siblingTexts.length >= 2
          ? siblingTexts.slice()
          : null;
      syncRestoreBtn();
      var pinText = workText();
      var docMd = "";
      try {
        docMd = GwDoc.getDocumentText() || "";
      } catch (eDoc) {}
      var matCount = 0;
      try {
        if (window.GwMaterialIndex && GwMaterialIndex.workspaceForAi) {
          var wsInv = GwMaterialIndex.workspaceForAi() || {};
          matCount = (wsInv.materials && wsInv.materials.length) || 0;
        }
      } catch (eInv) {}
      var assembled = { block: "" };
      if (window.GwContextKernel && GwContextKernel.buildContextInventory) {
        assembled = GwContextKernel.buildContextInventory({
          displayMsg: req,
          pinText: pinText,
          pinChars: String(pinText || "").replace(/\s/g, "").length,
          docChars: String(docMd || "").replace(/\s/g, "").length,
          matCount: matCount
        });
      }
      var sendMsg = buildWriteUserPacket(
        req,
        pinText,
        assembled.block,
        pinHistoryBlock(suiteChat())
      );
      var hist = [];
      var suiteN =
        (window.GwSettings && GwSettings.suiteCount
          ? GwSettings.suiteCount()
          : 3) || 3;
      /* 发送即入轨，避免长请求期间切页/换钉后「对话像没了」 */
      state.chatSuite.push({ role: "user", text: req, suite: true });
      persistChat("suite_user");
      if (state.tab === "suite") renderOpts();
      var runner =
        window.GwChatLoop && GwChatLoop.runChat
          ? GwChatLoop.runChat({
              message: sendMsg,
              contextMd: "",
              doc_md: "",
              capability: capabilitySuite(),
              talkCapability: capabilityWriteTalk(),
              finalCapability: capabilitySuite(),
              allowEdit: true,
              materials: citeMats,
              history: hist,
              session_summary: "",
              read_set: (state.readSet || []).slice(),
              contextBag: {
                pin: pinText || "",
                doc_full: docMd || ""
              },
              want_options: true,
              option_count: suiteN,
              onStatus: function (s) {
                var t = String(s || "");
                if (/索引|同步|准备素材|工程目录/.test(t))
                  tipProgress("正在准备材料…");
                else if (
                  /执行|read_file|list_files|search|fetch_context|查阅|准备材料/.test(
                    t
                  )
                )
                  tipProgress("正在准备材料…");
                else if (/终稿|打包|增强|作答/.test(t))
                  tipProgress("精修出方案中…");
                else tipProgress("精修中…");
              }
            })
          : GwRelay.chat(sendMsg, "", capabilitySuite(), true, citeMats, {
              history: hist,
              want_options: true,
              option_count: suiteN,
              read_set: (state.readSet || []).slice()
            }).then(function (data) {
              return {
                reply: (data && data.reply) || "(空回复)",
                options: data && data.options
              };
            });
      return runner
        .then(function (data) {
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
            if (siblingTexts && siblingTexts.length >= 2 && state.work.items) {
              state.work.items = state.work.items.map(function (it, i) {
                return {
                  index: it.index,
                  lvl: it.lvl,
                  via: it.via,
                  text: siblingTexts[i] || it.text
                };
              });
              state.work.text = siblingTexts.join("\n\n");
            }
          }
          archiveSuiteOptionsToChat();
          state.writeLiveFrozen = false;
          state.options = normalizeOptions((data && data.options) || []);
          if (!state.options.length) {
            state.options = extractWriteVariants(
              data,
              (data && data.reply) || "",
              ""
            );
          }
          /* 必须写入 chatSuite：请求返回时用户可能已切到撰写，activeChat() 会写错轨 */
          var bubble = {
            role: "assistant",
            text:
              "已出 " +
              state.options.length +
              " 案 · 可预览 / 采用" +
              (siblingTexts && siblingTexts.length >= 2
                ? "（整组 " + siblingTexts.length + " 条）"
                : ""),
            suite: true,
            suiteOptions: state.options.slice(),
            variants: state.options.slice(),
            autoVersionRel: state.pendingTurnAutoRel || ""
          };
          bindBubblePin(bubble);
          state.chatSuite.push(bubble);
          persistChat("suite_ok");
          renderOpts();
          syncTabUi();
          tip(
            "已出 " +
              state.options.length +
              " 案 · 可预览 / 采用" +
              (siblingTexts && siblingTexts.length >= 2
                ? "（整组 " + siblingTexts.length + " 条）"
                : "")
          );
        })
        .catch(function (e) {
          var em =
            (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
            e.message ||
            "失败";
          state.chatSuite.push({
            role: "assistant",
            text: em,
            suite: true
          });
          persistChat("suite_fail");
          if (state.tab === "suite") renderOpts();
          tip(em);
          alert(em);
        })
        .then(function () {
          setBusy(false);
        });
    }).catch(function () {});
  }

  function applyProofScopeFromSettings() {
    var scope =
      window.GwSettings && GwSettings.proofDefaultScope
        ? GwSettings.proofDefaultScope()
        : "full";
    var radios = document.querySelectorAll('input[name="proofScope"]');
    Array.prototype.forEach.call(radios, function (r) {
      r.checked = r.value === scope;
    });
  }

  function applySuitePrefsFromSettings() {
    if (window.GwSettings && GwSettings.suiteOptView) {
      state.optView = GwSettings.suiteOptView();
    }
  }

  try {
    window.__gwTaskpaneApplyProofScope = applyProofScopeFromSettings;
    window.__gwTaskpaneApplySuitePrefs = applySuitePrefsFromSettings;
  } catch (eHook) {}

  function captureProofScope() {
    var scope =
      (document.querySelector('input[name="proofScope"]:checked') || {})
        .value || "full";
    var text = "";
    var baseStart = 0;
    try {
      if (scope === "selection") {
        text = GwDoc.getSelectionText();
        var info = GwDoc.getSelectionInfo();
        baseStart = Number(info && info.start) || 0;
      } else {
        text = GwDoc.getDocumentText();
        baseStart = GwDoc.contentStart ? GwDoc.contentStart() : 0;
      }
    } catch (e) {
      return { error: e.message, scope: scope };
    }
    if (!String(text).replace(/\s/g, "")) {
      return {
        error: scope === "selection" ? "请先划选要校对的正文" : "文档为空",
        scope: scope
      };
    }
    return { text: text, baseStart: baseStart, scope: scope };
  }

  function proofRelayRequest() {
    try {
      if (window.GwSettings && GwSettings.reload) GwSettings.reload();
    } catch (eRel) {}
    var s = window.GwSettings || {};
    var engines = s.proofEngineIds
      ? s.proofEngineIds()
      : [
          "punctuation",
          "format",
          "dictionary",
          "typo",
          "grammar",
          "sensitive",
          "duplicate"
        ];
    if (!engines.length) engines = ["typo", "grammar"];
    if (
      !engines.some(function (e) {
        return e === "typo" || e === "grammar" || e === "sensitive";
      })
    ) {
      engines = engines.concat(["typo", "grammar"]);
    }
    return {
      engines: engines,
      extra: {
        sensitivity: s.proofSensitivity ? s.proofSensitivity() : "normal",
        whitelist: s.proofWhitelist ? s.proofWhitelist() : [],
        mustfix: s.proofMustfix ? s.proofMustfix() : [],
        facts: s.proofFacts ? s.proofFacts() : [],
        industryPack: s.proofIndustryPack ? s.proofIndustryPack() : true
      }
    };
  }

  function applyProofResults(data, cap) {
    state.proof =
      (data && (data.results || (data.data && data.data.results))) || [];
    state.proofSnap = {
      text: String(cap.text),
      baseStart: cap.baseStart,
      scope: cap.scope
    };
    stampProofItems(state.proof, state.proofSnap.text);
    state.proofActive = state.proof.length ? 0 : -1;
    persistChat("proof_ok");
    setProofClearEnabled();
    renderOpts();
    startProofFollow();
    tip("发现 " + state.proof.length + " 处");
  }

  function runProof() {
    var cap = captureProofScope();
    if (cap.error) {
      alert(cap.error);
      return;
    }
    stopProofFollow();
    wipeProofMark();
    withLogin(function () {
      setBusy(true);
      tip("校对中…");
      $("proofClear").disabled = false;
      var req = proofRelayRequest();
      if (window.GwProofIngest) GwProofIngest.hidePanel();
      return GwRelay.proofread(cap.text, req.engines, req.extra)
        .then(function (data) {
          applyProofResults(data, cap);
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
          if (state.tab === "proof" && state.proof.length) {
            state.proofJumpUntil = Date.now() + 900;
            try {
              locateProofItem(state.proof[0], "orig");
            } catch (eLoc) {
              tip(eLoc.message);
            }
          }
        });
    }).catch(function () {});
  }

  function switchTab(tab) {
    var prev = state.tab;
    if (prev === "proof" && tab !== "proof") {
      stopProofFollow();
      wipeProofMark();
    }
    state.tab = tab;
    if (tab === "proof") {
      wipeProofMark();
    }
    if (tab === "suite" || tab === "write") {
      rehomeMisplacedSuiteMessages();
    }
    logInfo("ui.tab", {
      from: prev,
      to: tab,
      writeN: state.chatWrite.length,
      suiteN: state.chatSuite.length
    });
    syncTabUi();
    persistChat("tab");
    if (tab === "proof" && state.proof && state.proof.length) {
      startProofFollow();
    }
  }

  window.GwProofUi = {
    activeItem: function () {
      var i = state.proofActive;
      if (i < 0 || i >= state.proof.length) return null;
      var it = state.proof[i];
      return it && !it._ignored ? it : null;
    }
  };

  window.onload = function () {
    logInfo("ui.onload", {
      href: String(location.href || ""),
      base: (window.GwRelay && GwRelay.baseUrl && GwRelay.baseUrl()) || ""
    });
    ensureBase();
    try {
      wipeProofMark();
    } catch (eWipe) {}
    setBusy(false);
    state.pendingClarify = null;
    if (window.GwSettingsUI) GwSettingsUI.init();
    if (window.GwAccount) GwAccount.init();
    applyProofScopeFromSettings();
    applySuitePrefsFromSettings();
    try {
      window.addEventListener("focus", function () {
        try {
          if (window.GwSettings && GwSettings.reload) GwSettings.reload();
          applyProofScopeFromSettings();
          applySuitePrefsFromSettings();
        } catch (eF) {}
      });
    } catch (eFocus) {}
    try {
      var restored = restoreChat();
      applyRestoredSessionUi(restored);
      if (restored) persistChat("restore");
      lastSessionRoot = sessionRoot();
    } catch (eRestore) {
      logWarn("chat.restore.crash", String(eRestore && eRestore.message));
    }
    bindProjectSession();
    ensureDefaultWriteLevel();
    syncTabUi();
    if (state.tab === "proof" && state.proof && state.proof.length) {
      startProofFollow();
    }
    startLiveWatch();

    window.addEventListener("beforeunload", function () {
      persistChat("beforeunload");
      try {
        wipeProofMark();
      } catch (eU) {}
    });
    window.addEventListener("pagehide", function () {
      persistChat("pagehide");
      try {
        wipeProofMark();
      } catch (eP) {}
    });
    /* 定时落盘，防最小化关窗来不及写 beforeunload */
    setInterval(function () {
      var r = sessionRoot();
      if (
        lastSessionRoot &&
        r &&
        lastSessionRoot.replace(/\\/g, "/").toLowerCase() !==
          r.replace(/\\/g, "/").toLowerCase()
      ) {
        persistChat("root_leave", lastSessionRoot);
        wipeSessionMemory();
        var okMiss = false;
        try {
          okMiss = restoreChat();
        } catch (eMiss) {}
        lastSessionRoot = r;
        applyRestoredSessionUi(okMiss);
      } else {
        lastSessionRoot = r || lastSessionRoot;
      }
      if (memPersistCount() || workText().replace(/\s/g, ""))
        persistChat("interval");
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
    var thinkSlow = $("aiThinkSlow");
    if (thinkSlow) {
      try {
        if (localStorage.getItem("gongwen.aiThinkSlow") === "1") {
          thinkSlow.checked = true;
        }
      } catch (eThink0) {}
      thinkSlow.onchange = function () {
        try {
          localStorage.setItem(
            "gongwen.aiThinkSlow",
            thinkSlow.checked ? "1" : "0"
          );
        } catch (eThink1) {}
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
        n: activeChat().length,
        tab: state.tab,
        stack: "user_click_aiClearChat"
      });
      /* 铁律：清空对话绝不碰 ActiveDocument；只清当前页签对话轨与对应自动夹 */
      if (window.GwProject && GwProject.clearAutoLane) {
        try {
          GwProject.clearAutoLane(state.tab === "suite" ? "suite" : "write");
        } catch (eClr) {}
      }
      if (state.tab === "suite") {
        state.chatSuite = [];
        state.options = [];
        state.previewId = null;
        state.adoptedId = null;
        state.suiteBaseline = "";
        state.suiteBaselineItems = null;
      } else {
        state.chatWrite = [];
        state.baseDraft = null;
        state.writeLiveFrozen = false;
        state.taskCard = window.GwContextKernel
          ? GwContextKernel.emptyCard()
          : null;
        state.pendingClarify = null;
        state._clarifyAskedOnce = false;
        state.lastUnderstand = null;
        state.readSet = [];
      }
      persistChat("user_clear");
      syncRestoreBtn();
      renderOpts();
      syncTabUi();
      var qBar = $("aiQualityBar");
      if (qBar) {
        qBar.hidden = true;
        qBar.innerHTML = "";
      }
      tip(
        state.tab === "suite"
          ? "已清空精修对话 · 正文未改动"
          : "已清空撰写对话 · 正文未改动"
      );
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
    if (window.GwProofIngest) GwProofIngest.init();
    var proofSet = $("proofOpenSet");
    if (proofSet) {
      proofSet.onclick = function () {
        if (window.GwSettingsUI) GwSettingsUI.open("proof");
      };
    }
    $("proofClear").onclick = function () {
      stopProofFollow();
      wipeProofMark();
      state.proof = [];
      state.proofSnap = null;
      state.proofActive = -1;
      persistChat("user_clear_proof");
      setProofClearEnabled();
      if (window.GwProofIngest) GwProofIngest.hidePanel();
      renderOpts();
      tip("已清空校对结果 · 正文未改动");
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
      refreshStyleFingerprint({ force: true });
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
