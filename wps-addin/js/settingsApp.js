/**
 * 独立设置窗 UI：校对 | 我的词库 | 高级；确定写盘 / 取消关闭
 */
(function (global) {
  var draft = null;
  var pane = "general";

  var SCENE_META = [
    { id: "政务公文", tip: "公文格式、政治规范、内容重复等" },
    { id: "新闻资讯", tip: "错别字、表述、敏感用语" },
    { id: "个人写作", tip: "错别字、标点、词库" }
  ];

  function engineLabel(id) {
    var hit = null;
    if (global.GwSettings && GwSettings.ENGINE_LABELS) {
      GwSettings.ENGINE_LABELS.forEach(function (e) {
        if (e.id === id) hit = e.name;
      });
    }
    return hit || id;
  }

  function enginesForScene(sceneId) {
    var map = (draft && draft.proof && draft.proof.sceneEngineMap) || {};
    var list =
      map[sceneId] ||
      (GwSettings.SCENES_DEFAULT && GwSettings.SCENES_DEFAULT[sceneId]) ||
      [];
    return list.slice();
  }

  function enginesSummary(sceneId) {
    return enginesForScene(sceneId)
      .map(engineLabel)
      .join("、");
  }

  var ENG_HINT = {
    punctuation: "本地",
    format: "本地",
    dictionary: "本地词库",
    typo: "错别字",
    grammar: "语法",
    sensitive: "政治规范",
    style: "文风",
    logic: "前后矛盾",
    dataverify: "对照事实表",
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
    var curSum = enginesSummary(curScene) || "（无）";
    body.innerHTML =
      "<h3>校对</h3>" +
      '<p class="gw-set-desc">场景 = 一套检查配方。点选后「开始校对」按该配方跑；与词库、事实口径分工见下方说明。</p>' +
      '<div class="gw-set-block"><h4>我在写哪类稿</h4>' +
      '<div class="gw-set-scene" id="gwScene"></div>' +
      '<div class="gw-set-scene-detail">' +
      "<b>当前「" +
      escapeHtml(curScene) +
      "」将检查：</b>" +
      '<p class="gw-set-scene-list">' +
      escapeHtml(curSum) +
      "</p>" +
      '<button type="button" class="gw-set-linkish" id="gwGotoAdv">去高级微调检查项…</button>' +
      "</div>" +
      '<p class="gw-set-hint">场景只决定开哪些检查引擎。词库管误报/必纠；事实口径给「数据核验」用——三者配合，不是三选一。</p></div>' +
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
      '<p class="gw-set-hint">当次仍可在校对条改选区/全文。</p></div>';

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
        '</small><span class="gw-set-scene-engs">' +
        escapeHtml(enginesSummary(s.id)) +
        "</span></button>"
      );
    }).join("");
    sc.onclick = function (e) {
      var b = e.target.closest("[data-scene]");
      if (!b) return;
      draft.proof.scene = b.getAttribute("data-scene");
      render();
    };
    $("gwGotoAdv").onclick = function () {
      pane = "advanced";
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
  }

  function renderDict(body) {
    body.innerHTML =
      "<h3>我的词库</h3>" +
      '<p class="gw-set-desc">单位专名、常错写法记在这里，越用越省事。</p>' +
      '<div class="gw-set-block"><h4>别再报这些（白名单）</h4>' +
      '<div class="gw-set-add"><input type="text" id="gwWlIn" maxlength="40" placeholder="专有名词，回车添加" />' +
      '<button type="button" id="gwWlAdd">添加</button></div>' +
      '<div class="gw-set-badges" id="gwWlBadges"></div></div>' +
      '<div class="gw-set-block"><h4>这种错必须改</h4>' +
      '<div class="gw-set-add">' +
      '<input type="text" id="gwMfWrong" maxlength="40" placeholder="错误写法" />' +
      "<span>→</span>" +
      '<input type="text" id="gwMfRight" maxlength="40" placeholder="正确写法" />' +
      '<button type="button" id="gwMfAdd">添加</button></div>' +
      '<ul class="gw-set-list" id="gwMfList"></ul></div>';

    function paintWl() {
      $("gwWlBadges").innerHTML = (draft.proof.whitelist || [])
        .map(function (w, i) {
          return (
            "<span>" +
            escapeHtml(w) +
            ' <button type="button" data-wl-del="' +
            i +
            '" aria-label="删除">×</button></span>'
          );
        })
        .join("");
    }
    function paintMf() {
      $("gwMfList").innerHTML = (draft.proof.mustfix || [])
        .map(function (x, i) {
          return (
            "<li><span>" +
            escapeHtml(x.wrong) +
            " → " +
            escapeHtml(x.right) +
            '</span><button type="button" data-mf-del="' +
            i +
            '">删除</button></li>'
          );
        })
        .join("");
    }
    paintWl();
    paintMf();
    function addWl() {
      var w = ($("gwWlIn").value || "").trim().slice(0, 40);
      if (!w) return;
      if (!draft.proof.whitelist) draft.proof.whitelist = [];
      if (draft.proof.whitelist.indexOf(w) < 0) draft.proof.whitelist.push(w);
      $("gwWlIn").value = "";
      paintWl();
    }
    $("gwWlAdd").onclick = addWl;
    $("gwWlIn").onkeydown = function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addWl();
      }
    };
    $("gwWlBadges").onclick = function (e) {
      var b = e.target.closest("[data-wl-del]");
      if (!b) return;
      draft.proof.whitelist.splice(Number(b.getAttribute("data-wl-del")), 1);
      paintWl();
    };
    $("gwMfAdd").onclick = function () {
      var w = ($("gwMfWrong").value || "").trim();
      var r = ($("gwMfRight").value || "").trim();
      if (!w || !r) return;
      if (!draft.proof.mustfix) draft.proof.mustfix = [];
      draft.proof.mustfix.push({ wrong: w, right: r });
      $("gwMfWrong").value = "";
      $("gwMfRight").value = "";
      paintMf();
    };
    $("gwMfList").onclick = function (e) {
      var b = e.target.closest("[data-mf-del]");
      if (!b) return;
      draft.proof.mustfix.splice(Number(b.getAttribute("data-mf-del")), 1);
      paintMf();
    };
  }

  function renderFacts(body) {
    if (!draft.proof.factGroups || !draft.proof.factGroups.length) {
      draft.proof.factGroups = [
        { id: "default", name: "默认", enabled: true, items: [] }
      ];
    }
    var fg = draft.proof.factGroups[0];
    var dvOn = currentEngines().indexOf("dataverify") >= 0;
    var factLis = (fg.items || [])
      .map(function (it, i) {
        return (
          "<li><span>" +
          escapeHtml(it.label) +
          "：" +
          escapeHtml(it.value) +
          (it.unit ? escapeHtml(it.unit) : "") +
          '</span><button type="button" data-fi-del="' +
          i +
          '">删除</button></li>'
        );
      })
      .join("");
    body.innerHTML =
      "<h3>事实口径</h3>" +
      '<p class="gw-set-desc">本机固定数字/口径，校对时与正文对照。不上云。</p>' +
      '<div class="gw-set-block">' +
      '<label class="gw-set-check"><input type="checkbox" id="gwDvOn"' +
      (dvOn ? " checked" : "") +
      "> 校对时启用「数据核验」</label>" +
      '<p class="gw-set-hint">有条目并勾选后才会按表对数；无条目时不打扰。</p>' +
      "</div>" +
      '<div class="gw-set-block"><h4>口径条目</h4>' +
      '<div class="gw-set-add">' +
      '<input type="text" id="gwFiLabel" placeholder="标签 如营收" />' +
      '<input type="text" id="gwFiValue" placeholder="值" />' +
      '<input type="text" id="gwFiUnit" placeholder="单位" style="max-width:72px" />' +
      '<button type="button" id="gwFiAdd">添加</button></div>' +
      '<ul class="gw-set-list" id="gwFiList">' +
      (factLis ||
        '<li style="color:#a8a29e">暂无 · 例如：营收 → 12.3 → 亿元</li>') +
      "</ul></div>";
    $("gwDvOn").onchange = function () {
      setEngineOn("dataverify", !!$("gwDvOn").checked);
    };
    $("gwFiAdd").onclick = function () {
      var label = ($("gwFiLabel").value || "").trim();
      var value = ($("gwFiValue").value || "").trim();
      var unit = ($("gwFiUnit").value || "").trim();
      if (!label || !value) return;
      draft.proof.factGroups[0].items.push({
        label: label,
        value: value,
        unit: unit,
        aliases: []
      });
      if (currentEngines().indexOf("dataverify") < 0) {
        setEngineOn("dataverify", true);
      }
      $("gwFiLabel").value = "";
      $("gwFiValue").value = "";
      $("gwFiUnit").value = "";
      render();
    };
    $("gwFiList").onclick = function (e) {
      var b = e.target.closest("[data-fi-del]");
      if (!b) return;
      draft.proof.factGroups[0].items.splice(
        Number(b.getAttribute("data-fi-del")),
        1
      );
      render();
    };
  }

  function renderAdvanced(body) {
    var eng = currentEngines();
    var engHtml = GwSettings.ENGINE_LABELS.map(function (e) {
      var on = eng.indexOf(e.id) >= 0;
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

    body.innerHTML =
      "<h3>高级</h3>" +
      '<p class="gw-set-desc">精修习惯与检查细项。一般不用改。</p>' +
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
      "> 精修必须先钉住选区</label></div>" +
      '<div class="gw-set-block"><h4>本场景检查项（' +
      escapeHtml(draft.proof.scene) +
      "）</h4>" +
      '<div class="gw-set-engines" id="gwEng">' +
      engHtml +
      "</div>" +
      '<p class="gw-set-hint">只影响当前场景。事实口径请到左侧「事实口径」页。</p></div>';

    $("gwSuiteCount").onchange = function () {
      draft.suite.count = Number($("gwSuiteCount").value) || 3;
    };
    $("gwOptView").onchange = function () {
      draft.suite.optView = $("gwOptView").value;
    };
    $("gwReqSel").onchange = function () {
      draft.suite.requireSelection = !!$("gwReqSel").checked;
    };
    $("gwEng").onchange = function (e) {
      var el = e.target;
      if (!el || !el.getAttribute("data-eng")) return;
      setEngineOn(el.getAttribute("data-eng"), !!el.checked);
    };
  }

  function render() {
    var body = $("gwSetBody");
    if (!body || !draft) return;
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
