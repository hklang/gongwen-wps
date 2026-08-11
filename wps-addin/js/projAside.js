/**
 * 公文工程左栏 — 对齐旧 #projAside；数据走 GwProject。
 */
(function () {
  var state = {
    asideSelectedRel: "",
    fileCtxRel: "",
    fileCtxIgnoreUntil: 0,
    snapshot: null,
    lastFileClick: { rel: "", t: 0 }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    var el = $("projStatus");
    if (!el) return;
    var text = String(msg || "").trim();
    el.hidden = !text;
    el.textContent = text;
    el.className = "proj-aside-foot" + (kind ? " " + kind : "");
  }

  function shortName(p) {
    return GwProject.baseName(p);
  }

  function isFileSecFolded(key) {
    try {
      return localStorage.getItem("fileSecFolded." + key) === "1";
    } catch (e) {
      return false;
    }
  }

  function setFileSecFolded(key, folded) {
    try {
      localStorage.setItem("fileSecFolded." + key, folded ? "1" : "0");
    } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderFileSection(key, title, items, emptyHint) {
    var list = Array.isArray(items) ? items : [];
    var hasCurrent = list.some(function (it) {
      return it && it.current;
    });
    var folded = !hasCurrent && isFileSecFolded(key);
    var html =
      '<div class="file-sec' +
      (folded ? " folded" : "") +
      '" data-sec="' +
      key +
      '"><div class="file-sec-bar">' +
      '<button type="button" class="file-sec-head" data-sec-toggle="' +
      key +
      '" aria-expanded="' +
      (folded ? "false" : "true") +
      '"><span class="file-sec-caret" aria-hidden="true"></span>' +
      '<span class="file-sec-title">' +
      title +
      '</span><span class="file-sec-count">' +
      list.length +
      "</span></button>";
    if (key === "materials") {
      html +=
        '<button type="button" class="file-sec-act" data-convert-materials ' +
        'title="素材转换（后续）">转换</button>';
    }
    if (key === "templates") {
      html +=
        '<button type="button" class="file-sec-act" data-cloud-templates ' +
        'title="浏览云端骨架并下载到本机模板夹">☁ 云端</button>';
    }
    html += '</div><div class="file-sec-body">';
    if (!list.length) {
      html +=
        '<div class="file-empty">' +
        (emptyHint ||
          (key === "materials"
            ? "仅显示 doc / docx；放入「素材」后刷新"
            : key === "templates"
              ? "点「☁ 云端」下载；右键「引用」或「用 WPS 打开」"
              : "（空）")) +
        "</div>";
    } else {
      list.forEach(function (it) {
        var cur = it.current ? " current" : "";
        var act = it.activeTemplate ? " active-tpl" : "";
        var sel =
          GwProject.normRel(it.path) === state.asideSelectedRel ? " selected" : "";
        var titleText = String(it.title || it.path || "");
        var short = titleText.length > 28 ? titleText.slice(0, 27) + "…" : titleText;
        var badge = it.current ? " · 当前" : "";
        var rel = escapeHtml(String(it.path || ""));
        html +=
          '<div class="file-item' +
          cur +
          act +
          sel +
          '" data-rel="' +
          rel +
          '" title="' +
          rel +
          '"><button type="button" class="file-item-main" data-open-rel="' +
          rel +
          '"><span>' +
          escapeHtml(short) +
          badge +
          "</span><small>" +
          escapeHtml(it.path || "") +
          "</small></button></div>";
      });
    }
    return html + "</div></div>";
  }

  function renderUnbound(data) {
    var body = $("projAsideBody");
    if ($("projAsideTitle")) $("projAsideTitle").textContent = "工程文件";
    var tip = data && data.unsaved
      ? "当前文档尚未保存到磁盘。<br/>请先「另存为」，工程根将自动对应该文件夹，并创建 素材/ 模板/ 版本。"
      : "无法定位当前文档目录。<br/>请先保存文档；或点上方文件夹图标改绑工程根。";
    body.innerHTML = '<div class="file-empty">' + tip + "</div>";
  }

  function renderProjectFiles(quiet) {
    var data = GwProject.listProjectFiles();
    state.snapshot = data;
    if (data.unbound) {
      renderUnbound(data);
      if (!quiet) {
        setStatus(data.unsaved ? "请先保存文档" : "无工程根", "warn");
      }
      return;
    }
    if ($("projAsideTitle")) {
      $("projAsideTitle").textContent = data.name
        ? "工程 · " + data.name
        : "工程文件";
    }
    var docsEmpty =
      !data.docs.length && data.materials.length
        ? "根目录暂无文稿；材料在下方「素材」"
        : "（空）";
    $("projAsideBody").innerHTML =
      renderFileSection("docs", "文稿", data.docs, docsEmpty) +
      renderFileSection("materials", "素材", data.materials) +
      renderFileSection("templates", "模板", data.templates) +
      renderFileSection("versions", "版本", data.versions);
    if (!quiet) {
      var src =
        data.source === "active"
          ? "当前文档目录"
          : data.source === "manual"
            ? "手动改绑"
            : "已存路径";
      var via =
        data.via === "wpsfs"
          ? "本机扫描"
          : data.via === "fso"
            ? "FSO 扫描"
            : "索引模式（未扫到盘）";
      setStatus(src + " · " + via, data.via === "index" ? "warn" : "");
    }
  }

  function bindProject() {
    var r = GwProject.pickFolder();
    if (r.cancelled) {
      setStatus("已取消改绑", "");
      return;
    }
    if (!r.ok) {
      setStatus(r.error || "改绑失败", "err");
      return;
    }
    renderProjectFiles(true);
    setStatus("已改绑：" + (r.name || r.root), "ok");
  }

  function paintSelection() {
    var body = $("projAsideBody");
    if (!body) return;
    var sel = state.asideSelectedRel;
    body.querySelectorAll(".file-item").forEach(function (el) {
      var rel = GwProject.normRel(el.getAttribute("data-rel") || "");
      el.classList.toggle("selected", !!sel && rel === sel);
    });
  }

  function openInWps(rel) {
    var pathRel = GwProject.normRel(rel);
    if (!pathRel) {
      setStatus("无文件路径", "err");
      return;
    }
    setStatus("正在打开…", "");
    var r = GwProject.openInWpsReadOnly(pathRel);
    if (!r.ok) {
      setStatus(r.error || "打开失败", "err");
      return;
    }
    if (r.reused) setStatus("已切到：" + shortName(pathRel), "ok");
    else if (r.warn) setStatus(r.warn + "：" + shortName(pathRel), "warn");
    else setStatus("只读打开：" + shortName(pathRel), "ok");
  }

  function selectRel(rel) {
    state.asideSelectedRel = GwProject.normRel(rel);
    paintSelection();
    setStatus("已选中：" + shortName(rel) + " · 再点一次打开", "");
  }

  function hideFileCtxMenu() {
    var menu = $("fileCtxMenu");
    if (menu) menu.hidden = true;
    state.fileCtxRel = "";
  }

  function showFileCtxMenu(x, y, rel) {
    var menu = $("fileCtxMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "fileCtxMenu";
      menu.className = "file-ctx-menu";
      document.body.appendChild(menu);
    }
    menu.innerHTML =
      '<button type="button" data-file-open>用 WPS 打开</button>' +
      '<button type="button" data-file-cite>引用</button>' +
      '<button type="button" data-file-del>删除</button>';
    var pathRel = GwProject.normRel(rel);
    state.fileCtxRel = pathRel;
    state.asideSelectedRel = pathRel;
    state.fileCtxIgnoreUntil = Date.now() + 400;
    var acted = false;
    function runAct(act, e) {
      if (acted) return;
      acted = true;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      hideFileCtxMenu();
      if (act === "open") {
        openInWps(pathRel);
      } else if (act === "cite") {
        var c = GwProject.addCite(pathRel);
        if (!c.ok) setStatus(c.error || "引用失败", "err");
        else if (c.exists) setStatus("已在引用：" + shortName(pathRel), "");
        else setStatus("已引用：" + shortName(pathRel), "ok");
      } else if (act === "del") {
        if (!window.confirm("删除工程内文件？\n" + pathRel)) return;
        var d = GwProject.deleteRel(pathRel);
        if (!d.ok) setStatus(d.error || "删除失败", "err");
        else {
          GwProject.removeCite(pathRel);
          renderProjectFiles(true);
          setStatus("已删除：" + shortName(pathRel), "warn");
        }
      }
    }
    menu.querySelectorAll("[data-file-open]").forEach(function (btn) {
      btn.onclick = function (e) {
        runAct("open", e);
      };
    });
    menu.querySelectorAll("[data-file-cite]").forEach(function (btn) {
      btn.onclick = function (e) {
        runAct("cite", e);
      };
    });
    menu.querySelectorAll("[data-file-del]").forEach(function (btn) {
      btn.onclick = function (e) {
        runAct("del", e);
      };
    });
    menu.hidden = false;
    var left = Math.min(x, window.innerWidth - (menu.offsetWidth || 100) - 8);
    var top = Math.min(y, window.innerHeight - (menu.offsetHeight || 70) - 8);
    menu.style.left = Math.max(4, left) + "px";
    menu.style.top = Math.max(4, top) + "px";
    paintSelection();
  }

  function setCollapsed(on) {
    var aside = $("projAside");
    if (!aside) return;
    aside.classList.toggle("collapsed", !!on);
    try {
      localStorage.setItem("projAsideCollapsed", on ? "1" : "0");
    } catch (e) {}
  }

  function bindEvents() {
    $("btnProjBind").addEventListener("click", bindProject);
    $("btnProjRefresh").addEventListener("click", function () {
      renderProjectFiles(false);
    });
    $("btnProjCollapse").addEventListener("click", function () {
      setCollapsed(true);
    });
    $("projAsideRail").addEventListener("click", function () {
      setCollapsed(false);
    });

    $("projAsideBody").addEventListener("click", function (e) {
      if (e.target.closest("[data-convert-materials]")) {
        setStatus("「转换」暂不需要（直接引用 docx）", "warn");
        return;
      }
      if (e.target.closest("[data-cloud-templates]")) {
        setStatus("「☁ 云端」待接双轨模板", "warn");
        return;
      }
      var head = e.target.closest("[data-sec-toggle]");
      if (head) {
        var key = head.getAttribute("data-sec-toggle");
        var sec = head.closest(".file-sec");
        if (!sec || !key) return;
        var folded = !sec.classList.contains("folded");
        sec.classList.toggle("folded", folded);
        head.setAttribute("aria-expanded", folded ? "false" : "true");
        setFileSecFolded(key, folded);
        return;
      }
      var openBtn = e.target.closest("[data-open-rel]");
      if (openBtn) {
        var rel = GwProject.normRel(openBtn.getAttribute("data-open-rel") || "");
        var now = Date.now();
        // 单击重绘会打断原生 dblclick；用 450ms 内同文件再点 = 打开
        if (
          rel &&
          rel === state.lastFileClick.rel &&
          now - state.lastFileClick.t < 450
        ) {
          state.lastFileClick = { rel: "", t: 0 };
          openInWps(rel);
        } else {
          state.lastFileClick = { rel: rel, t: now };
          selectRel(rel);
        }
      }
    });

    $("projAsideBody").addEventListener("contextmenu", function (e) {
      var item = e.target.closest("[data-rel]");
      if (!item) return;
      e.preventDefault();
      showFileCtxMenu(e.clientX, e.clientY, item.getAttribute("data-rel"));
    });

    document.addEventListener(
      "pointerdown",
      function (e) {
        var menu = $("fileCtxMenu");
        if (!menu || menu.hidden) return;
        if (Date.now() < state.fileCtxIgnoreUntil) return;
        if (e.target.closest("#fileCtxMenu")) return;
        hideFileCtxMenu();
      },
      true
    );

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideFileCtxMenu();
    });
  }

  function init() {
    bindEvents();
    try {
      if (localStorage.getItem("projAsideCollapsed") === "1") setCollapsed(true);
    } catch (e) {}
    renderProjectFiles(true);
    if (!GwProject.getRoot()) {
      setStatus("请先保存当前文档", "warn");
    } else if (!GwProject.hasDiskApi || !GwProject.hasDiskApi()) {
      setStatus("已定位工程根，但无磁盘 API，无法列文件", "warn");
    } else if (GwProject.isManualRoot && GwProject.isManualRoot()) {
      setStatus("手动改绑中（刷新仍用此根）", "");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
