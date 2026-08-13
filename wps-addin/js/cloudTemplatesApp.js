/**
 * 云端双轨模板窗 — 对齐原 editor tplModal：分组 + 文种药丸 + 列表 + 预览
 * 见 specs/2026-08-13-04-WPS云端模板一对一复刻.md
 */
(function (global) {
  var state = {
    rail: "official",
    groups: [],
    categories: [],
    group: "",
    category: "",
    templates: [],
    pick: "",
    body: "",
    title: "",
    cache: {},
    mineList: [],
    mineId: null,
    mineCatCode: "",
    search: ""
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(msg, kind) {
    var el = $("gwTplStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "gw-tpl-status" + (kind ? " " + kind : "");
  }

  function friendly(err) {
    return global.GwRelay && GwRelay.friendlyError
      ? GwRelay.friendlyError(err)
      : String((err && err.message) || err || "失败");
  }

  function closeWin() {
    try {
      window.close();
    } catch (e) {}
  }

  function syncLandBtn() {
    var btn = $("gwTplLand");
    if (!btn) return;
    if (state.rail === "mine") {
      var body = String(($("gwMineBody") && $("gwMineBody").value) || "").trim();
      btn.disabled = !body;
    } else {
      btn.disabled = !String(state.body || "").trim();
    }
  }

  function syncSearchBtn() {
    var btn = $("gwTplSearchBtn");
    var pop = $("gwTplSearchPop");
    if (!btn) return;
    var off = state.rail === "official";
    btn.hidden = !off;
    btn.classList.toggle("has-q", !!String(state.search || "").trim());
    btn.classList.toggle("on", pop && !pop.hidden);
  }

  function openSearchPop() {
    var pop = $("gwTplSearchPop");
    if (!pop) return;
    pop.hidden = false;
    syncSearchBtn();
    try {
      $("gwTplSearch").focus();
      $("gwTplSearch").select();
    } catch (e) {}
  }

  function closeSearchPop(clear) {
    var pop = $("gwTplSearchPop");
    if (pop) pop.hidden = true;
    if (clear) {
      state.search = "";
      if ($("gwTplSearch")) $("gwTplSearch").value = "";
      if (state.rail === "official") renderBrowseChrome();
    }
    syncSearchBtn();
  }

  function setRail(rail) {
    state.rail = rail === "mine" ? "mine" : "official";
    var off = state.rail === "official";
    Array.prototype.forEach.call(
      document.querySelectorAll("#gwTplTabs [data-rail]"),
      function (btn) {
        btn.classList.toggle("on", btn.getAttribute("data-rail") === state.rail);
      }
    );
    $("gwTplBodyOfficial").hidden = !off;
    $("gwTplBodyMine").hidden = off;
    $("gwTplNew").hidden = off;
    if (off) closeMineEdit();
    closeSearchPop(false);
    syncSearchBtn();
    setStatus(
      off
        ? "官方只读；管理员更新后下次打开即新内容"
        : "点列表或「新建」进入全页编辑；返回列表可继续选。"
    );
    if (off) {
      renderBrowseChrome();
      loadTplList(state.category);
    } else {
      closeMineEdit();
      loadMineList();
    }
    syncLandBtn();
  }

  function filteredCats() {
    var q = String(state.search || "").trim().toLowerCase();
    var cats = (state.categories || []).filter(function (c) {
      return (c.grp || "其他") === state.group;
    });
    if (q) {
      cats = (state.categories || []).filter(function (c) {
        return (
          String(c.name || "").toLowerCase().indexOf(q) >= 0 ||
          String(c.code || "").toLowerCase().indexOf(q) >= 0
        );
      });
    }
    return cats;
  }

  function filteredTemplates() {
    var q = String(state.search || "").trim().toLowerCase();
    var list = state.templates || [];
    if (!q) return list;
    return list.filter(function (t) {
      return (
        String(t.title || "").toLowerCase().indexOf(q) >= 0 ||
        String(t.code || "").toLowerCase().indexOf(q) >= 0 ||
        String(t.blurb || "").toLowerCase().indexOf(q) >= 0
      );
    });
  }

  function renderBrowseChrome() {
    var groups = state.groups.length
      ? state.groups
      : Array.from(
          new Set(
            (state.categories || []).map(function (c) {
              return c.grp || "其他";
            })
          )
        );
    if (!state.group || groups.indexOf(state.group) < 0) {
      state.group = groups[0] || "";
    }
    var gEl = $("gwTplGroups");
    gEl.innerHTML = groups
      .map(function (g) {
        return (
          '<button type="button" data-tpl-grp="' +
          escapeHtml(g) +
          '" class="' +
          (g === state.group ? "on" : "") +
          '">' +
          escapeHtml(g) +
          "</button>"
        );
      })
      .join("");

    var cats = filteredCats();
    var cEl = $("gwTplCats");
    cEl.innerHTML =
      cats
        .map(function (c) {
          return (
            '<button type="button" data-tpl-cat="' +
            escapeHtml(c.code) +
            '" class="' +
            (c.code === state.category ? "on" : "") +
            '">' +
            escapeHtml(c.name || c.code) +
            "</button>"
          );
        })
        .join("") ||
      '<span class="gw-tpl-empty">无匹配文种</span>';

    renderTplListUi();
  }

  function renderTplListUi() {
    var lEl = $("gwTplList");
    var list = filteredTemplates();
    lEl.innerHTML = list.length
      ? list
          .map(function (t) {
            var key = t.code || "fb:" + (t.category || state.category);
            return (
              '<button type="button" class="gw-tpl-item' +
              (key === state.pick ? " on" : "") +
              '" data-tpl-code="' +
              escapeHtml(t.code || "") +
              '" data-tpl-key="' +
              escapeHtml(key) +
              '"><b>' +
              escapeHtml(t.title || t.code) +
              "</b><span>" +
              escapeHtml(t.blurb || t.version || "") +
              "</span></button>"
            );
          })
          .join("")
      : '<div class="gw-tpl-empty">该文种暂无模板，可稍后由后台补录</div>';
  }

  function renderMineList() {
    var el = $("gwTplMineList");
    var list = state.mineList || [];
    el.innerHTML = list.length
      ? list
          .map(function (t) {
            var on = Number(state.mineId) === Number(t.id) ? " on" : "";
            return (
              '<button type="button" class="gw-tpl-item' +
              on +
              '" data-mid="' +
              escapeHtml(t.id) +
              '"><b>' +
              escapeHtml(t.title || "未命名") +
              "</b><span>" +
              escapeHtml(
                (t.category_code || "") +
                  (t.chars != null ? " · " + t.chars + "字" : "")
              ) +
              "</span></button>"
            );
          })
          .join("")
      : '<div class="gw-tpl-empty">还没有「我的」模板，点下方「新建」</div>';
  }

  function loadGenres() {
    setStatus("加载文种…");
    return GwRelay.genres()
      .then(function (j) {
        state.categories = (j && j.categories) || [];
        state.groups =
          (j && j.groups) ||
          Array.from(
            new Set(
              state.categories.map(function (c) {
                return c.grp || "其他";
              })
            )
          );
        if (!state.category && state.categories.length) {
          state.category = state.categories[0].code || "";
          state.group = state.categories[0].grp || state.groups[0] || "";
        } else {
          var hit = state.categories.filter(function (c) {
            return c.code === state.category;
          })[0];
          if (hit) state.group = hit.grp || state.group;
        }
        setStatus("");
        renderBrowseChrome();
        return loadTplList(state.category);
      })
      .catch(function (err) {
        setStatus(friendly(err), "err");
        $("gwTplGroups").innerHTML = "";
        $("gwTplCats").innerHTML =
          '<span class="gw-tpl-empty err">文种加载失败</span>';
      });
  }

  function loadTplList(categoryCode) {
    var code = categoryCode || state.category || "";
    if (!code) return Promise.resolve();
    state.category = code;
    $("gwTplList").innerHTML = '<div class="gw-tpl-empty">加载中…</div>';
    $("gwTplPrev").textContent = "";
    $("gwTplPrevHead").textContent = "加载列表…";
    state.pick = "";
    state.body = "";
    syncLandBtn();
    return GwRelay.listTemplates(code)
      .then(function (j) {
        state.templates = (j && j.templates) || [];
        $("gwTplPrevHead").textContent =
          (j && j.category_name ? j.category_name : code) + " · 选择一份预览";
        renderBrowseChrome();
        if (state.templates.length) {
          var t0 = state.templates[0];
          state.pick = t0.code || "fb:" + code;
          renderTplListUi();
          return previewTpl(t0.code || "");
        }
        syncLandBtn();
      })
      .catch(function (err) {
        $("gwTplList").innerHTML =
          '<div class="gw-tpl-empty err">加载失败：' +
          escapeHtml(friendly(err)) +
          "</div>";
      });
  }

  function previewTpl(templateCode) {
    var cat = state.category || "";
    var cacheKey = templateCode || "fb:" + cat;
    $("gwTplPrevHead").textContent = "加载预览…";
    syncLandBtn();
    var cached = state.cache[cacheKey];
    var p = cached
      ? Promise.resolve(cached)
      : GwRelay.getTemplate(templateCode, cat).then(function (data) {
          state.cache[cacheKey] = data;
          return data;
        });
    return p
      .then(function (data) {
        state.body = (data && data.body_md) || "";
        state.title = (data && data.title) || templateCode || "骨架";
        if (data && data.category) state.category = data.category;
        $("gwTplPrev").textContent = state.body || "（无正文）";
        $("gwTplPrevHead").textContent = state.title;
        syncLandBtn();
      })
      .catch(function (err) {
        state.body = "";
        $("gwTplPrev").textContent = "";
        $("gwTplPrevHead").textContent = friendly(err);
        setStatus(friendly(err), "err");
        syncLandBtn();
      });
  }

  function loadMineList() {
    if (!(GwRelay.isLoggedIn && GwRelay.isLoggedIn())) {
      $("gwTplMineList").innerHTML =
        '<div class="gw-tpl-empty">「我的」需登录账号。<br/>请关闭本窗，在助手右上角登录后再开。</div>';
      setStatus("请先登录", "err");
      return Promise.resolve();
    }
    setStatus("加载我的模板…");
    return GwRelay.listUserTemplates()
      .then(function (j) {
        state.mineList = (j && j.templates) || [];
        setStatus(
          state.mineList.length
            ? "共 " + state.mineList.length + " / " + (j.limit || 50)
            : "还没有「我的」模板"
        );
        renderMineList();
        syncLandBtn();
      })
      .catch(function (err) {
        state.mineList = [];
        setStatus(friendly(err), "err");
        $("gwTplMineList").innerHTML =
          '<div class="gw-tpl-empty err">' + escapeHtml(friendly(err)) + "</div>";
      });
  }

  function openMineEdit(isNew) {
    var listPane = $("gwTplMineListPane");
    var edit = $("gwTplMineEdit");
    if (listPane) listPane.hidden = true;
    if (edit) edit.hidden = false;
    if ($("gwMineEditTitle")) {
      $("gwMineEditTitle").textContent = isNew ? "新建模板" : "编辑模板";
    }
    try {
      $("gwMineTitle").focus();
    } catch (e) {}
    syncLandBtn();
  }

  function closeMineEdit() {
    var listPane = $("gwTplMineListPane");
    var edit = $("gwTplMineEdit");
    if (edit) edit.hidden = true;
    if (listPane) listPane.hidden = false;
  }

  function loadMineOne(id) {
    setStatus("打开模板…");
    return GwRelay.getUserTemplate(id)
      .then(function (j) {
        var t = (j && j.template) || {};
        state.mineId = t.id;
        state.mineCatCode = t.category_code || "";
        $("gwMineTitle").value = t.title || "";
        $("gwMineBody").value = t.body_md || "";
        setStatus("");
        renderMineList();
        openMineEdit(false);
      })
      .catch(function (err) {
        setStatus(friendly(err), "err");
      });
  }

  function startNewMine() {
    state.mineId = null;
    state.mineCatCode = state.category || "";
    $("gwMineTitle").value = "";
    $("gwMineBody").value = "";
    renderMineList();
    openMineEdit(true);
  }

  function saveMine() {
    var title = String(($("gwMineTitle") && $("gwMineTitle").value) || "").trim();
    var body = String(($("gwMineBody") && $("gwMineBody").value) || "");
    var cat = state.mineCatCode || state.category || "";
    if (!title) {
      setStatus("请填标题", "err");
      return;
    }
    if (!body.trim()) {
      setStatus("请填正文", "err");
      return;
    }
    var payload = state.mineId
      ? {
          op: "update",
          id: state.mineId,
          title: title,
          body_md: body,
          category_code: cat
        }
      : {
          op: "create",
          title: title,
          body_md: body,
          category_code: cat
        };
    setStatus("保存中…");
    GwRelay.mutateUserTemplate(payload)
      .then(function (j) {
        var t = (j && j.template) || {};
        if (t.id) state.mineId = t.id;
        if (t.category_code != null) state.mineCatCode = t.category_code || "";
        setStatus("已保存到云端", "ok");
        return loadMineList();
      })
      .catch(function (err) {
        setStatus(friendly(err), "err");
      });
  }

  function deleteMine() {
    if (!state.mineId) {
      setStatus("尚未保存的草稿可直接关闭", "err");
      return;
    }
    if (!confirm("删除云端「我的」模板？本机已下载的文件不会自动删。")) return;
    setStatus("删除中…");
    GwRelay.mutateUserTemplate({ op: "delete", id: state.mineId })
      .then(function () {
        state.mineId = null;
        state.mineCatCode = "";
        $("gwMineTitle").value = "";
        $("gwMineBody").value = "";
        closeMineEdit();
        setStatus("已删除", "ok");
        return loadMineList();
      })
      .catch(function (err) {
        setStatus(friendly(err), "err");
      });
  }

  function landCurrent(force) {
    var title = "";
    var code = "";
    var body = "";
    if (state.rail === "official") {
      title = state.title || "骨架";
      code = state.category || "tpl";
      body = state.body;
    } else {
      title = String(($("gwMineTitle") && $("gwMineTitle").value) || "").trim() || "骨架";
      code = state.mineCatCode || state.category || "tpl";
      body = String(($("gwMineBody") && $("gwMineBody").value) || "");
    }
    if (!String(body || "").trim()) {
      setStatus("正文为空，无法下载", "err");
      return;
    }
    if (!global.GwProject || !GwProject.landTemplate) {
      setStatus("本机落盘不可用", "err");
      return;
    }
    var r = GwProject.landTemplate({
      title: title,
      category: code,
      body_md: body,
      force: !!force
    });
    if (r && r.need_confirm) {
      if (confirm("本机已有同名模板，覆盖？\n" + (r.path || ""))) {
        landCurrent(true);
      }
      return;
    }
    if (!r || !r.ok) {
      setStatus((r && r.error) || "下载失败", "err");
      return;
    }
    setStatus("已下载到本机：" + r.path, "ok");
  }

  function bind() {
    $("gwTplClose").onclick = closeWin;
    $("gwTplCloseX").onclick = closeWin;
    $("gwTplTabs").onclick = function (e) {
      var b = e.target.closest("[data-rail]");
      if (!b) return;
      setRail(b.getAttribute("data-rail"));
    };
    $("gwTplSearchBtn").onclick = function () {
      var pop = $("gwTplSearchPop");
      if (pop && !pop.hidden) closeSearchPop(false);
      else openSearchPop();
    };
    $("gwTplSearchClear").onclick = function () {
      closeSearchPop(true);
    };
    $("gwTplSearch").oninput = function () {
      state.search = $("gwTplSearch").value || "";
      syncSearchBtn();
      renderBrowseChrome();
    };
    $("gwTplSearch").onkeydown = function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeSearchPop(true);
      }
    };
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        var pop = $("gwTplSearchPop");
        if (pop && !pop.hidden) closeSearchPop(false);
      }
    });
    $("gwTplGroups").onclick = function (e) {
      var b = e.target.closest("[data-tpl-grp]");
      if (!b) return;
      state.group = b.getAttribute("data-tpl-grp") || "";
      var first = (state.categories || []).filter(function (c) {
        return (c.grp || "其他") === state.group;
      })[0];
      if (first) {
        state.category = first.code;
        loadTplList(first.code);
      } else {
        renderBrowseChrome();
      }
    };
    $("gwTplCats").onclick = function (e) {
      var b = e.target.closest("[data-tpl-cat]");
      if (!b) return;
      state.category = b.getAttribute("data-tpl-cat") || "";
      var hit = (state.categories || []).filter(function (c) {
        return c.code === state.category;
      })[0];
      if (hit) state.group = hit.grp || state.group;
      renderBrowseChrome();
      loadTplList(state.category);
    };
    $("gwTplList").onclick = function (e) {
      var b = e.target.closest("[data-tpl-key]");
      if (!b) return;
      state.pick = b.getAttribute("data-tpl-key") || "";
      renderTplListUi();
      previewTpl(b.getAttribute("data-tpl-code") || "");
    };
    $("gwTplMineList").onclick = function (e) {
      var b = e.target.closest("[data-mid]");
      if (!b) return;
      loadMineOne(b.getAttribute("data-mid"));
    };
    $("gwTplNew").onclick = startNewMine;
    $("gwMineSave").onclick = saveMine;
    $("gwMineDel").onclick = deleteMine;
    $("gwMineLand").onclick = function () {
      landCurrent(false);
    };
    $("gwMineEditClose").onclick = closeMineEdit;
    $("gwTplLand").onclick = function () {
      landCurrent(false);
    };
    $("gwMineBody").oninput = syncLandBtn;
    $("gwMineTitle").oninput = syncLandBtn;
  }

  function boot() {
    bind();
    if (!global.GwRelay || !GwRelay.baseUrl || !GwRelay.baseUrl()) {
      setStatus("未配置中转地址，请先在助手登录页核对", "err");
      return;
    }
    setRail("official");
    loadGenres();
  }

  global.GwCloudTplApp = { boot: boot };
})(window);
