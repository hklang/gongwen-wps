/**
 * 工程栏「☁ 云端」→ 独立 ShowDialog 云端模板窗
 */
(function (global) {
  var TITLE = "公文助手 · 云端模板";
  var DLG_W = 960;
  var DLG_H = 720;

  function pageUrl() {
    try {
      if (typeof GetUrlPath === "function") {
        var base = GetUrlPath();
        if (base && /^https?:/i.test(base)) {
          return base.replace(/\/+$/, "") + "/cloud-templates.html";
        }
      }
    } catch (e) {}
    try {
      var href = String(location.href || "").split("?")[0].split("#")[0];
      var slash = href.lastIndexOf("/");
      if (slash > 0) return href.slice(0, slash) + "/cloud-templates.html";
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
        var g = GwUserPrefs.loadGeom("cloudTemplates");
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

  function open() {
    var url = pageUrl();
    if (!url) {
      alert("无法解析云端模板页地址，请用 wpsjs debug 的 http 模式打开助手。");
      return false;
    }
    if (!showDialog(url)) {
      alert("无法打开云端模板窗");
      return false;
    }
    return true;
  }

  global.GwCloudTemplates = { open: open };
})(window);
