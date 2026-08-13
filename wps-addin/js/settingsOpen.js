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

  /** 兼容旧调用：不再在助手内盖大模态 */
  function initButton() {
    var actions = document.getElementById("aiHeadActions");
    if (!actions || document.getElementById("gwSettingsBtn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "gwSettingsBtn";
    btn.className = "ai-settings-btn";
    btn.title = "设置";
    btn.setAttribute("aria-label", "设置");
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
    actions.insertBefore(btn, actions.firstChild);
    btn.onclick = function () {
      open("general");
    };
  }

  global.GwSettingsUI = {
    init: initButton,
    open: open,
    close: function () {}
  };
})(window);
