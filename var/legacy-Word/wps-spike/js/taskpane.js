(function () {
  var CHIP_SLICE = 28;
  var LIVE_MS = 200;
  var state = {
    tab: "write",
    chat: [],
    options: [],
    proof: [],
    live: null,
    work: null,
    selPopOpen: false,
    busy: false,
    liveTimer: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function tip(msg) {
    var el = $("aiTip");
    if (el) {
      el.hidden = !msg;
      el.textContent = msg || "";
    }
  }

  function capability() {
    var el = $("aiCapability");
    return el && el.value === "strong" ? "strong" : "fast";
  }

  function ensureBase() {
    if (!GwRelay.baseUrl()) {
      GwRelay.setBase("http://49.233.190.103:8080/gongwen-relay");
    }
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
    var t = info ? String(info.text || "").replace(/\s+$/, "") : "";
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
      heading: info.heading || null
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

  function setWorkFromSnapshot(snap, extras) {
    extras = extras || {};
    state.work = {
      text: snap.text,
      start: snap.start,
      end: snap.end,
      heading: snap.heading || null,
      items: extras.items || null
    };
    state.selPopOpen = false;
    renderWorkChip();
    var n = (extras.items && extras.items.length) || 1;
    tip(
      "已钉住 · " +
        charCount(snap.text) +
        " 字" +
        (n > 1 ? " · 同级×" + n : "")
    );
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
      var t = info ? String(info.text || "").replace(/\s+$/, "") : "";
      if (t.replace(/\s/g, "")) {
        snap = {
          text: t,
          start: info.start,
          end: info.end,
          heading: info.heading || null
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
    return setWorkFromSnapshot(snap, {});
  }

  function clearWork(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    state.work = null;
    state.selPopOpen = false;
    renderWorkChip();
    tip("已清除");
  }

  function restoreWorkRange() {
    if (!state.work) return;
    try {
      if (
        typeof state.work.start === "number" &&
        typeof state.work.end === "number"
      ) {
        GwDoc.selectRange(state.work.start, state.work.end);
      }
    } catch (e) {}
  }

  function applyWorkReplace(md) {
    if (state.work && state.work.items && state.work.items.length > 1) {
      tip("同级多条暂不支持一次写回，请取消扩选后单条精修");
      alert("同级多标题暂不支持一次写回，请取消扩选后只精修一条。");
      return;
    }
    restoreWorkRange();
    GwDoc.replaceSelection(md || "");
    state.work = null;
    setSelPop(false);
    renderWorkChip();
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
    $("aiCompose").hidden = tab === "proof";
    $("aiWriteTips").hidden = tab !== "write";
    $("aiSuitePresets").hidden = tab !== "suite";
    var expandWrap = $("aiExpandSibWrap");
    if (expandWrap) expandWrap.hidden = tab !== "suite";
    $("aiChatAuthWrap").hidden = tab !== "write";
    $("aiSuiteHint").hidden = tab !== "suite";
    $("aiClearChat").hidden = tab === "proof" || tab === "suite";
    var ha = $("aiHeadActions");
    if (ha) ha.hidden = false;
    $("aiReq").placeholder =
      tab === "suite"
        ? "写精修要求，或点上方快捷项…"
        : "问点什么，或点上方立意 / 搭架 / 充填…";
    $("aiSend").textContent =
      tab === "suite" ? (state.options.length ? "再出" : "出方案") : "发送";
    tip(
      tab === "suite"
        ? "划选后点「钉住」；可反复换钉"
        : tab === "proof"
          ? "选范围后点开始校对"
          : "撰写对话；授权改稿时可写回选区"
    );
    renderWorkChip();
    renderOpts();
  }

  function renderOpts() {
    var box = $("aiOpts");
    if (!box) return;
    box.innerHTML = "";
    if (state.tab === "proof") {
      if (!state.proof.length) {
        box.innerHTML =
          '<div class="ai-empty">点上方「开始校对」；结果点条目可定位。</div>';
        return;
      }
      state.proof.forEach(function (item, idx) {
        var div = document.createElement("div");
        div.className = "ai-err";
        div.innerHTML =
          '<div class="ai-err-type">#' +
          (idx + 1) +
          " " +
          (item.reason || item.type || "问题") +
          "</div>" +
          '<div class="ai-err-body"><del></del><ins></ins></div>' +
          '<div class="ai-err-acts">' +
          '<button type="button" data-act="go">定位</button>' +
          '<button type="button" data-act="fix">采纳</button></div>';
        div.querySelector("del").textContent = item.original || "";
        div.querySelector("ins").textContent = item.suggestion || "";
        div.querySelector('[data-act="go"]').onclick = function (ev) {
          ev.stopPropagation();
          try {
            GwDoc.findAndHighlight(item.original);
          } catch (e) {
            tip(e.message);
          }
        };
        div.querySelector('[data-act="fix"]').onclick = function (ev) {
          ev.stopPropagation();
          try {
            GwDoc.applySuggestion(item.original, item.suggestion);
            div.classList.add("applied");
          } catch (e) {
            tip(e.message);
          }
        };
        div.onclick = function () {
          try {
            GwDoc.findAndHighlight(item.original);
          } catch (e) {
            tip(e.message);
          }
        };
        box.appendChild(div);
      });
      return;
    }

    if (state.tab === "suite") {
      if (!state.options.length) {
        box.innerHTML =
          '<div class="ai-empty">划选后点「钉住」，再出方案；可随时换钉。</div>';
        return;
      }
      state.options.forEach(function (opt, idx) {
        var div = document.createElement("div");
        div.className = "ai-opt";
        div.innerHTML =
          '<div class="ai-opt-head"><span class="ai-tag">' +
          String.fromCharCode(65 + idx) +
          '</span><span>方案</span></div>' +
          '<div class="ai-body"></div>' +
          '<div class="ai-actions"><button type="button" class="primary">采用</button></div>';
        div.querySelector(".ai-body").textContent = opt.md || "";
        div.querySelector("button").onclick = function () {
          try {
            applyWorkReplace(opt.md || "");
            div.classList.add("adopted");
            tip("已写回选区");
          } catch (e) {
            tip(e.message);
            alert(e.message);
          }
        };
        box.appendChild(div);
      });
      return;
    }

    if (!state.chat.length) {
      box.innerHTML =
        '<div class="ai-empty">撰写：可先划选钉住作上下文。立意 / 搭架 / 充填为引导。</div>';
      return;
    }
    var log = document.createElement("div");
    log.className = "ai-chat-log";
    state.chat.forEach(function (m) {
      var b = document.createElement("div");
      b.className = "ai-bubble " + (m.role === "user" ? "user" : "assistant");
      b.textContent = m.text;
      if (m.role === "assistant" && m.allowApply) {
        var acts = document.createElement("div");
        acts.className = "ai-actions";
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "primary";
        btn.textContent = "写回选区";
        btn.onclick = function () {
          try {
            applyWorkReplace(m.text);
            tip("已写回选区");
          } catch (e) {
            alert(e.message);
          }
        };
        acts.appendChild(btn);
        b.appendChild(acts);
      }
      log.appendChild(b);
    });
    box.appendChild(log);
    box.scrollTop = box.scrollHeight;
  }

  function setBusy(on) {
    state.busy = !!on;
    $("aiSend").disabled = !!on;
    $("proofRun").disabled = !!on;
  }

  function sendWrite() {
    var msg = ($("aiReq").value || "").trim();
    if (!msg) {
      tip("请先输入内容");
      return;
    }
    if (!workText().replace(/\s/g, "")) {
      commitLiveToWork({});
    }
    var ctx = workText();
    var allow =
      document.querySelector('input[name="aiEditMode"]:checked') &&
      document.querySelector('input[name="aiEditMode"]:checked').value ===
        "auth";
    state.chat.push({ role: "user", text: msg });
    $("aiReq").value = "";
    renderOpts();
    setBusy(true);
    tip("撰写中…");
    ensureBase();
    GwRelay.chat(msg, ctx, capability(), allow)
      .then(function (data) {
        var reply = (data && data.reply) || "(空回复)";
        state.chat.push({
          role: "assistant",
          text: reply,
          allowApply: allow
        });
        renderOpts();
        tip("完成");
      })
      .catch(function (e) {
        tip(e.message || "失败");
        state.chat.push({
          role: "assistant",
          text: "失败：" + (e.message || e)
        });
        renderOpts();
      })
      .then(function () {
        setBusy(false);
      });
  }

  function sendSuite() {
    if (!workText().replace(/\s/g, "")) {
      commitLiveToWork({ alert: true });
    }
    if (!workText().replace(/\s/g, "")) {
      tip("精修须先钉住");
      alert("请先在正文划选，再点「钉住」");
      return;
    }
    var req = ($("aiReq").value || "").trim() || "优化表述，更准确凝练";
    setBusy(true);
    tip("出方案中…");
    ensureBase();
    GwRelay.suggest(workText(), req, capability())
      .then(function (data) {
        state.options = (data && data.options) || [];
        syncTabUi();
        tip("已出 " + state.options.length + " 案");
      })
      .catch(function (e) {
        tip(e.message || "失败");
        alert(e.message || e);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function runProof() {
    var scope =
      (document.querySelector('input[name="proofScope"]:checked') || {})
        .value || "full";
    var text = "";
    try {
      if (scope === "selection") {
        if (!workText().replace(/\s/g, "")) {
          commitLiveToWork({ alert: true });
        }
        text = workText() || liveText() || GwDoc.getSelectionText();
      } else {
        text = GwDoc.getDocumentText();
      }
    } catch (e) {
      alert(e.message);
      return;
    }
    if (!String(text).replace(/\s/g, "")) {
      alert(scope === "selection" ? "请先划选并钉住" : "文档为空");
      return;
    }
    setBusy(true);
    tip("校对中…");
    $("proofClear").disabled = false;
    ensureBase();
    GwRelay.proofread(text)
      .then(function (data) {
        state.proof =
          (data && (data.results || (data.data && data.data.results))) || [];
        renderOpts();
        tip("发现 " + state.proof.length + " 处");
      })
      .catch(function (e) {
        tip(e.message || "失败");
        alert(e.message || e);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function switchTab(tab) {
    state.tab = tab;
    if (tab === "proof") {
      state.proof = [];
    }
    syncTabUi();
  }

  window.onload = function () {
    ensureBase();
    syncTabUi();
    startLiveWatch();

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
      document.querySelectorAll("[data-write-tip]"),
      function (btn) {
        btn.onclick = function () {
          $("aiReq").value = btn.getAttribute("data-write-tip") || "";
          $("aiReq").focus();
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

    $("aiSend").onclick = function () {
      if (state.tab === "suite") sendSuite();
      else sendWrite();
    };
    $("aiClearChat").onclick = function () {
      state.chat = [];
      state.options = [];
      renderOpts();
    };
    $("proofRun").onclick = runProof;
    $("proofClear").onclick = function () {
      state.proof = [];
      $("proofClear").disabled = true;
      renderOpts();
    };
  };
})();
