/**
 * 从助手窗唤起独立设置 ShowDialog（废除助手内假模态）
 */
(function (global) {
  var TITLE = "公文助手 · 设置";
  var DLG_W = 920;
  var DLG_H = 720;

  function settingsUrl(pane) {
    /* 当前页在 /ui/workspace.html 时 GetUrlPath()==.../ui，勿再拼 /ui/ */
    var q = pane ? "?pane=" + encodeURIComponent(pane) : "";
    try {
      if (typeof GetUrlPath === "function") {
        var base = GetUrlPath();
        if (base && /^https?:/i.test(base)) {
          return base.replace(/\/+$/, "") + "/settings.html" + q;
        }
      }
    } catch (e) {}
    try {
      var href = String(location.href || "").split("?")[0].split("#")[0];
      var slash = href.lastIndexOf("/");
      if (slash > 0) return href.slice(0, slash) + "/settings.html" + q;
    } catch (e2) {}
    return "";
  }

  function showDialog(url) {
    var app = global.Application;
    if (!app) return false;
    var w = DLG_W;
    var h = DLG_H;
    try {
      if (global.GwUserPrefs && GwUserPrefs.loadGeom) {
        var g = GwUserPrefs.loadGeom("settings");
        if (g && g.w >= 640 && g.h >= 480) {
          w = g.w;
          h = g.h;
        }
      }
    } catch (eG) {}

    function tryEx(fn) {
      if (typeof fn !== "function") return false;
      try {
        fn(url, TITLE, w, h, false, true, 2, "", 0, true, false, false);
        return true;
      } catch (e1) {
        try {
          fn(url, TITLE, w, h, false, true, 2);
          return true;
        } catch (e2) {
          return false;
        }
      }
    }

    if (tryEx(app.ShowDialogEx)) return true;
    if (typeof wps !== "undefined" && tryEx(wps.ShowDialogEx)) return true;
    try {
      app.ShowDialog(url, TITLE, w, h, false, true, 2);
      return true;
    } catch (e3) {
      try {
        app.ShowDialog(url, TITLE, w, h, false);
        return true;
      } catch (e4) {
        return false;
      }
    }
  }

  function open(pane) {
    var url = settingsUrl(pane || "proof");
    if (!url) {
      alert("无法解析设置页地址，请用 wpsjs debug 的 http 模式打开助手。");
      return false;
    }
    if (!showDialog(url)) {
      alert("无法打开设置窗");
      return false;
    }
    return true;
  }

  function tip(msg, kind) {
    var el = document.getElementById("projStatus");
    if (el) {
      var text = String(msg || "").trim();
      el.hidden = !text;
      el.textContent = text;
      el.className = "proj-aside-foot" + (kind ? " " + kind : "");
      return;
    }
    if (msg) {
      try {
        alert(msg);
      } catch (e) {}
    }
  }

  function refreshProjList() {
    try {
      var btn = document.getElementById("btnProjRefresh");
      if (btn) btn.click();
    } catch (e) {}
  }

  function makeHeadBtn(id, title, svgHtml, onClick) {
    if (document.getElementById(id)) return null;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.className = "ai-settings-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = svgHtml;
    btn.onclick = onClick;
    return btn;
  }

  function openCloudTemplates() {
    if (global.GwCloudTemplates && GwCloudTemplates.open) {
      if (!GwCloudTemplates.open()) tip("无法打开云端模板窗", "err");
      return;
    }
    tip("云端模板模块未加载", "err");
  }

  function saveVersion() {
    if (!global.GwProject || !GwProject.saveActiveToVersion) {
      tip("工程模块未就绪", "err");
      return;
    }
    tip("正在存版本…", "");
    var sv;
    try {
      sv = GwProject.saveActiveToVersion();
    } catch (err) {
      tip("存版本异常：" + (err.message || err), "err");
      return;
    }
    if (!sv || !sv.ok) {
      var errMsg = (sv && sv.error) || "存版本失败";
      tip(errMsg.split("\n")[0], "err");
      try {
        alert(errMsg);
      } catch (a0) {}
      return;
    }
    refreshProjList();
    if (sv.warn) tip(sv.warn + " → " + (sv.path || ""), "warn");
    else tip("已存书签：" + (sv.path || ""), "ok");
  }

  var SVG_TPL =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8M8 9h2"/></svg>';
  var SVG_VER =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
  var SVG_SET =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

  /** 头栏：模板 | 存版本 | 设置（账号由 GwAccount 追加） */
  function initButton() {
    var actions = document.getElementById("aiHeadActions");
    if (!actions || document.getElementById("gwSettingsBtn")) return;

    var btnTpl = makeHeadBtn(
      "gwTplBtn",
      "云端模板",
      SVG_TPL,
      openCloudTemplates
    );
    var btnVer = makeHeadBtn("gwVerBtn", "存版本", SVG_VER, saveVersion);
    var btnSet = makeHeadBtn("gwSettingsBtn", "设置", SVG_SET, function () {
      open("general");
    });

    /* 插在账号钮之前；从右往左插，保证最终顺序 模板|存版本|设置|账号 */
    var anchor =
      document.getElementById("gwAccountBtn") || actions.firstChild;
    [btnSet, btnVer, btnTpl].forEach(function (b) {
      if (!b) return;
      if (anchor) actions.insertBefore(b, anchor);
      else actions.appendChild(b);
      anchor = b;
    });
  }

  global.GwSettingsUI = {
    init: initButton,
    open: open,
    close: function () {}
  };
})(window);
