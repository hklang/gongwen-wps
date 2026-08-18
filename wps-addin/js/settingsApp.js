/**
 * 独立设置窗 UI：校对 | 我的词库 | 高级；确定写盘 / 取消关闭
 */
(function (global) {
  var draft = null;
  var pane = "general";
  var dictTab = "wl";
  var cloudProof = null;

  var SCENE_META = [
    { id: "政务公文", tip: "公文格式、政治规范、内容重复等" },
    { id: "新闻资讯", tip: "错别字、表述、敏感用语" },
    { id: "个人写作", tip: "错别字、标点、词库" }
  ];

  var ENG_HINT = {
    punctuation: "标点",
    format: "公文格式",
    dictionary: "账号词库",
    typo: "错别字",
    grammar: "语法",
    sensitive: "政治规范",
    style: "文风",
    logic: "前后矛盾",
    dataverify: "对照已收录口径",
    duplicate: "跨段同事项"
  };

  function $(id) {
    return document.getElementById(id);
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call(
      (root || document).querySelectorAll(sel)
    );
  }

  function queryPane() {
    try {
      var m = String(location.search || "").match(/[?&]pane=([^&]+)/);
      if (!m) return "general";
      var p = decodeURIComponent(m[1]);
      if (
        p === "dict" ||
        p === "advanced" ||
        p === "proof" ||
        p === "general" ||
        p === "facts"
      ) {
        return p;
      }
      if (p === "suite" || p === "write") return "advanced";
      return "general";
    } catch (e) {
      return "general";
    }
  }

  function closeWin() {
    try {
      window.close();
    } catch (e) {}
    try {
      if (global.Application && Application.Quit) {
        /* 勿 Quit 整个 WPS */
      }
    } catch (e2) {}
  }

  function currentEngines() {
    var scene = draft.proof.scene || "政务公文";
    var map = draft.proof.sceneEngineMap || {};
    if (!map[scene]) map[scene] = (GwSettings.SCENES_DEFAULT[scene] || []).slice();
    return map[scene];
  }

  function setEngineOn(id, on) {
    var list = currentEngines().slice();
    var i = list.indexOf(id);
    if (on && i < 0) list.push(id);
    if (!on && i >= 0) list.splice(i, 1);
    draft.proof.sceneEngineMap[draft.proof.scene] = list;
  }

  function engineCheckboxesHtml(selectedIds) {
    var sel = selectedIds || [];
    return GwSettings.ENGINE_LABELS.map(function (e) {
      var on = sel.indexOf(e.id) >= 0;
      return (
        '<label class="gw-set-eng"><input type="checkbox" data-eng="' +
        e.id +
        '"' +
        (on ? " checked" : "") +
        "><span><b>" +
        e.name +
        "</b><small>" +
        (ENG_HINT[e.id] || e.group) +
        "</small></span></label>"
      );
    }).join("");
  }

  function bindEngineChecks(rootId) {
    var root = $(rootId);
    if (!root) return;
    root.onchange = function (e) {
      var el = e.target;
      if (!el || !el.getAttribute("data-eng")) return;
      setEngineOn(el.getAttribute("data-eng"), !!el.checked);
    };
  }

  function accountHint() {
    try {
      var t = global.GwRelay && GwRelay.tokens && GwRelay.tokens();
      if (t && (t.access || t.refresh)) {
        if (t.email && String(t.email).indexOf("测试") >= 0) {
          return "测试模式 · 不限额度";
        }
        return t.email || "已登录";
      }
    } catch (e0) {}
    return "未登录（请回助手窗右上角登录）";
  }

  function renderGeneral(body) {
    body.innerHTML =
      "<h3>通用设置</h3>" +
      '<p class="gw-set-desc">账号与助手总览。工程文件夹请在左侧「工程」栏改绑，不在此设置。</p>' +
      '<div class="gw-set-block">' +
      "<h4>账号与额度</h4>" +
      '<p class="gw-set-hint" id="gwAccHint"></p>' +
      '<p class="gw-set-hint">登录、注册、查看额度：请关闭本窗后，在助手右上角点账号按钮。</p>' +
      "</div>" +
      '<div class="gw-set-block">' +
      "<h4>关于智能能力</h4>" +
      '<p class="gw-set-hint">标准 / 增强由云端自动路由，此处不选手动模型、不展示厂商名。</p>' +
      '<p class="gw-set-hint">撰写层级、出结论/多份、校对选区等当次操作在助手底栏/校对条完成，无需进设置。</p>' +
      "</div>";
    $("gwAccHint").textContent = accountHint();
  }

  function renderProof(body) {
    var curScene = draft.proof.scene || "政务公文";
    body.innerHTML =
      "<h3>校对</h3>" +
      '<p class="gw-set-desc">场景 = 一套检查配方。先选哪类稿，再勾本场景要跑哪些项；与词库、数据核验表配合，不是三选一。</p>' +
      '<div class="gw-set-block"><h4>我在写哪类稿</h4>' +
      '<div class="gw-set-scene" id="gwScene"></div>' +
      '<div class="gw-set-scene-detail">' +
      "<b>「" +
      escapeHtml(curScene) +
      "」检查项</b>" +
      '<p class="gw-set-hint gw-set-scene-eng-hint">勾选只写入当前场景；换场景不丢各自配方。点确定后生效。</p>' +
      '<div class="gw-set-engines" id="gwEngProof">' +
      engineCheckboxesHtml(currentEngines()) +
      "</div>" +
      '<button type="button" class="gw-set-linkish" id="gwSceneReset">恢复本场景默认</button>' +
      "</div></div>" +
      '<div class="gw-set-block"><h4>查得严不严</h4>' +
      '<div class="gw-set-sens" id="gwSens">' +
      '<button type="button" data-sens="strict"><b>严格</b><small>宁可误报不可漏报</small></button>' +
      '<button type="button" data-sens="normal"><b>标准</b><small>平衡精度与召回</small></button>' +
      '<button type="button" data-sens="relaxed"><b>宽松</b><small>只标确定无疑</small></button>' +
      "</div></div>" +
      '<div class="gw-set-block"><h4>默认范围</h4>' +
      '<div class="gw-set-row"><span class="gw-set-label">打开校对时</span>' +
      '<select id="gwScope"><option value="full">全文</option>' +
      '<option value="selection">选区</option></select></div>' +
      '<p class="gw-set-hint">当次仍可在校对条改选区/全文。</p></div>' +
      '<div class="gw-set-block"><h4>行业易错包</h4>' +
      '<label class="gw-set-check"><input type="checkbox" id="gwIndustryPack"' +
      (draft.proof.industryPack !== false ? " checked" : "") +
      " /> 使用行业易错包</label>" +
      '<p class="gw-set-hint">政务通用易错，默认开。关掉后只走你的词库。</p></div>';

    var sc = $("gwScene");
    sc.innerHTML = SCENE_META.map(function (s) {
      return (
        '<button type="button" data-scene="' +
        s.id +
        '"' +
        (curScene === s.id ? ' class="on"' : "") +
        "><b>" +
        s.id +
        "</b><small>" +
        escapeHtml(s.tip) +
        "</small></button>"
      );
    }).join("");
    sc.onclick = function (e) {
      var b = e.target.closest("[data-scene]");
      if (!b) return;
      draft.proof.scene = b.getAttribute("data-scene");
      render();
    };
    bindEngineChecks("gwEngProof");
    $("gwSceneReset").onclick = function () {
      var def =
        (GwSettings.SCENES_DEFAULT && GwSettings.SCENES_DEFAULT[curScene]) ||
        [];
      draft.proof.sceneEngineMap[curScene] = def.slice();
      render();
    };
    qsa("#gwSens [data-sens]").forEach(function (btn) {
      btn.classList.toggle(
        "on",
        btn.getAttribute("data-sens") === draft.proof.sensitivity
      );
    });
    $("gwSens").onclick = function (e) {
      var b = e.target.closest("[data-sens]");
      if (!b) return;
      draft.proof.sensitivity = b.getAttribute("data-sens");
      render();
    };
    $("gwScope").value = draft.proof.defaultScope || "full";
    $("gwScope").onchange = function () {
      draft.proof.defaultScope = $("gwScope").value;
    };
    $("gwIndustryPack").onchange = function () {
      draft.proof.industryPack = $("gwIndustryPack").checked;
    };
  }

  function ensureRelayBase() {
    if (!global.GwRelay) return;
    if (!GwRelay.baseUrl()) GwRelay.setBase("http://127.0.0.1:3000");
  }

  function loadCloudProof(done) {
    ensureRelayBase();
    if (!global.GwRelay || !GwRelay.getUserProof) {
      done(null, "无法连接中转");
      return;
    }
    GwRelay.getUserProof()
      .then(function (d) {
        done(d, "");
      })
      .catch(function (e) {
        done(
          null,
          (GwRelay.friendlyError && GwRelay.friendlyError(e)) || "请先登录账号"
        );
      });
  }

  function delCloud(kind, id, after) {
    GwRelay.mutateUserProof({ op: "delete", kind: kind, id: id })
      .then(after)
      .catch(function (e) {
        alert(
          (GwRelay.friendlyError && GwRelay.friendlyError(e)) || "删除失败"
        );
      });
  }

  function renderDict(body) {
    body.className = "gw-set-body gw-set-body-lib";
    body.innerHTML =
      "<h3>我的词库</h3>" +
      '<p class="gw-set-desc">跟账号走。正文划选后点校对条「词典」或「必改」。本页只查看和删除。</p>' +
      '<p class="gw-set-hint" id="gwCloudHint">加载中…</p>' +
      '<div class="gw-lib">' +
      '<div class="gw-lib-tabs" id="gwLibTabs">' +
      '<button type="button" data-lib="wl">别再报这些</button>' +
      '<button type="button" data-lib="mf">必须改</button>' +
      "</div>" +
      '<div class="gw-lib-meta" id="gwLibMeta"></div>' +
      '<ul class="gw-lib-list" id="gwLibList"></ul>' +
      "</div>";
    loadCloudProof(function (data, err) {
      var hint = $("gwCloudHint");
      if (!hint) return;
      if (err) {
        hint.textContent = err;
        cloudProof = null;
        paintDictList();
        return;
      }
      cloudProof = data || {};
      hint.textContent = "已登录 · 跟账号走";
      paintDictList();
    });
    $("gwLibTabs").onclick = function (e) {
      var b = e.target.closest("[data-lib]");
      if (!b) return;
      dictTab = b.getAttribute("data-lib") === "mf" ? "mf" : "wl";
      paintDictList();
    };
    $("gwLibList").onclick = function (e) {
      var b = e.target.closest("[data-del-kind]");
      if (!b) return;
      delCloud(
        b.getAttribute("data-del-kind"),
        Number(b.getAttribute("data-del-id")),
        function () {
          loadCloudProof(function (data, err) {
            cloudProof = err ? null : data || {};
            var hint = $("gwCloudHint");
            if (hint) hint.textContent = err || "已登录 · 跟账号走";
            paintDictList();
          });
        }
      );
    };
  }

  function paintDictList() {
    var tabs = $("gwLibTabs");
    var meta = $("gwLibMeta");
    var list = $("gwLibList");
    if (!tabs || !meta || !list) return;
    qsa("[data-lib]", tabs).forEach(function (btn) {
      btn.classList.toggle("on", btn.getAttribute("data-lib") === dictTab);
    });
    var wl = (cloudProof && cloudProof.whitelist) || [];
    var mf = (cloudProof && cloudProof.mustfix) || [];
    if (dictTab === "mf") {
      meta.textContent = mf.length ? "共 " + mf.length + " 条" : "";
      list.innerHTML = mf.length
        ? mf
            .map(function (x) {
              return (
                '<li class="gw-lib-row">' +
                '<div class="gw-lib-pair">' +
                "<b>" +
                escapeHtml(x.wrong) +
                "</b>" +
                '<span class="gw-lib-arrow" aria-hidden="true">→</span>' +
                "<span>" +
                escapeHtml(x.right) +
                "</span></div>" +
                '<button type="button" data-del-kind="mustfix" data-del-id="' +
                x.id +
                '">删除</button></li>'
              );
            })
            .join("")
        : '<li class="gw-lib-empty">还没有。正文划选「错→对」后点校对条「必改」。</li>';
      return;
    }
    meta.textContent = wl.length ? "共 " + wl.length + " 个词" : "";
    list.innerHTML = wl.length
      ? wl
          .slice()
          .sort(function (a, b) {
            return String(a.word || "").localeCompare(String(b.word || ""));
          })
          .map(function (w) {
            return (
              '<li class="gw-lib-row">' +
              '<span class="gw-lib-word" title="' +
              escapeHtml(w.word) +
              '">' +
              escapeHtml(w.word) +
              "</span>" +
              '<button type="button" data-del-kind="whitelist" data-del-id="' +
              w.id +
              '">删除</button></li>'
            );
          })
          .join("")
      : '<li class="gw-lib-empty">还没有。正文划选后点校对条「词典」。</li>';
  }

  function renderFacts(body) {
    body.innerHTML =
      "<h3>数据核验</h3>" +
      '<p class="gw-set-desc">划选正文，校对条点「数据」，整段收录并记下日期。启用请在「校对」勾选数据核验。</p>' +
      '<p class="gw-set-hint" id="gwCloudHint">加载中…</p>' +
      '<div class="gw-set-block"><h4>已收录</h4><ul class="gw-set-list gw-set-facts" id="gwFiList"></ul></div>';
    loadCloudProof(function (data, err) {
      var hint = $("gwCloudHint");
      if (!hint) return;
      if (err) {
        hint.textContent = err;
        return;
      }
      hint.textContent = "已登录 · 跟账号走";
      var items = (data && data.facts) || [];
      $("gwFiList").innerHTML =
        items
          .map(function (it) {
            var meta = it.snippet
              ? fmtRecorded(it.recorded_at) + "收录"
              : String(it.label || "") +
                "：" +
                String(it.value || "") +
                String(it.unit || "");
            var bodyText = it.snippet ? String(it.snippet) : "";
            return (
              '<li class="gw-set-fact">' +
              "<div>" +
              '<div class="gw-set-fact-meta">' +
              escapeHtml(meta) +
              "</div>" +
              (bodyText
                ? '<div class="gw-set-fact-body">' +
                  escapeHtml(bodyText) +
                  "</div>"
                : "") +
              "</div>" +
              '<button type="button" data-fi-id="' +
              it.id +
              '">删除</button></li>'
            );
          })
          .join("") || '<li style="color:#a8a29e">暂无。校对条划选后点「数据」。</li>';
      $("gwFiList").onclick = function (e) {
        var b = e.target.closest("[data-fi-id]");
        if (!b) return;
        delCloud("facts", Number(b.getAttribute("data-fi-id")), function () {
          render();
        });
      };
    });
  }

  function fmtRecorded(s) {
    var m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s ? String(s) : "";
    return m[1] + "年" + Number(m[2]) + "月" + Number(m[3]) + "日";
  }

  function renderAdvanced(body) {
    body.innerHTML =
      "<h3>高级</h3>" +
      '<p class="gw-set-desc">精修习惯。校对检查项请到左侧「校对」按场景勾选。</p>' +
      '<div class="gw-set-block"><h4>精修习惯</h4>' +
      '<div class="gw-set-row"><span class="gw-set-label">默认套数</span>' +
      '<select id="gwSuiteCount">' +
      [2, 3, 4, 5, 6]
        .map(function (n) {
          return (
            '<option value="' +
            n +
            '"' +
            (Number(draft.suite.count) === n ? " selected" : "") +
            ">" +
            n +
            " 套</option>"
          );
        })
        .join("") +
      "</select></div>" +
      '<div class="gw-set-row"><span class="gw-set-label">默认预览</span>' +
      '<select id="gwOptView">' +
      '<option value="diff"' +
      (draft.suite.optView !== "new" ? " selected" : "") +
      ">对照 diff</option>" +
      '<option value="new"' +
      (draft.suite.optView === "new" ? " selected" : "") +
      ">新稿</option></select></div>" +
      '<label class="gw-set-check"><input type="checkbox" id="gwReqSel"' +
      (draft.suite.requireSelection !== false ? " checked" : "") +
      "> 精修必须先钉住选区</label></div>";

    $("gwSuiteCount").onchange = function () {
      draft.suite.count = Number($("gwSuiteCount").value) || 3;
    };
    $("gwOptView").onchange = function () {
      draft.suite.optView = $("gwOptView").value;
    };
    $("gwReqSel").onchange = function () {
      draft.suite.requireSelection = !!$("gwReqSel").checked;
    };
  }

  function render() {
    var body = $("gwSetBody");
    if (!body || !draft) return;
    body.className = "gw-set-body";
    qsa("#gwSetNav [data-pane]").forEach(function (btn) {
      btn.classList.toggle("on", btn.getAttribute("data-pane") === pane);
    });

    if (pane === "general") {
      renderGeneral(body);
      return;
    }
    if (pane === "proof") {
      renderProof(body);
      return;
    }
    if (pane === "dict") {
      renderDict(body);
      return;
    }
    if (pane === "facts") {
      renderFacts(body);
      return;
    }
    renderAdvanced(body);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function commit() {
    if (!draft || !global.GwSettings) return;
    GwSettings.save(draft);
    closeWin();
  }

  function cancel() {
    closeWin();
  }

  function boot() {
    if (!global.GwSettings) return;
    draft = GwSettings.clone(GwSettings.load());
    pane = queryPane();
    $("gwSetNav").onclick = function (e) {
      var b = e.target.closest("[data-pane]");
      if (!b) return;
      pane = b.getAttribute("data-pane");
      render();
    };
    $("gwSetOk").onclick = commit;
    $("gwSetCancel").onclick = cancel;
    $("gwSetCloseX").onclick = cancel;
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") cancel();
    });
    render();
  }

  global.GwSettingsApp = { boot: boot };
})(window);
