/**
 * 用户本机习惯：窗口几何。
 * PluginStorage 为主，localStorage 兜底。
 * 主窗最小化：存几何并关闭本窗；由宿主还原后按记忆重新打开（避免 Visible/moveTo 居中）。
 */
(function (global) {
  var PREFIX = "gongwen.ui.";

  function pluginStore() {
    try {
      return global.Application && global.Application.PluginStorage;
    } catch (e) {
      return null;
    }
  }

  function get(k) {
    var key = PREFIX + k;
    var s = pluginStore();
    if (s) {
      try {
        var v = s.getItem(key);
        if (v != null && v !== "") return String(v);
      } catch (e) {}
    }
    try {
      return localStorage.getItem(key) || "";
    } catch (e2) {
      return "";
    }
  }

  function set(k, v) {
    var key = PREFIX + k;
    var s = pluginStore();
    if (s) {
      try {
        s.setItem(key, String(v == null ? "" : v));
      } catch (e) {}
    }
    try {
      localStorage.setItem(key, String(v == null ? "" : v));
    } catch (e2) {}
  }

  function ptToPx(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return (n * 96) / 72;
  }

  function appOriginPx() {
    var left = 0;
    var top = 0;
    try {
      left = ptToPx(Number(global.Application.Left) || 0);
      top = ptToPx(Number(global.Application.Top) || 0);
    } catch (e) {}
    return { left: left, top: top };
  }

  function clampGeom(g) {
    if (!g || typeof g !== "object") return null;
    var w = Math.round(Number(g.w));
    var h = Math.round(Number(g.h));
    var left = Math.round(Number(g.left));
    var top = Math.round(Number(g.top));
    if (!(w >= 200 && w <= 2400)) return null;
    if (!(h >= 240 && h <= 2000)) return null;
    if (!isFinite(left) || !isFinite(top)) return null;
    if (left < -2000 || top < -2000) return null;
    var origin = appOriginPx();
    return {
      w: w,
      h: h,
      left: left,
      top: top,
      relLeft: left - origin.left,
      relTop: top - origin.top,
      t: Date.now()
    };
  }

  function loadGeom(which) {
    try {
      var raw = get("geom." + which);
      if (!raw) return null;
      return clampGeom(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function saveGeom(which, geom) {
    var g = clampGeom(geom);
    if (!g) return false;
    set("geom." + which, JSON.stringify(g));
    return true;
  }

  function readWindowGeom() {
    var left = Number(global.screenX);
    var top = Number(global.screenY);
    var w = Number(global.outerWidth) || Number(global.innerWidth) || 0;
    var h = Number(global.outerHeight) || Number(global.innerHeight) || 0;
    if (!(w >= 200) || !isFinite(left)) return null;
    return clampGeom({ w: w, h: h, left: left, top: top });
  }

  function setWantOpen(which, on) {
    set("want." + which, on ? "1" : "");
  }

  function getWantOpen(which) {
    return get("want." + which) === "1";
  }

  function isHostMinimized() {
    try {
      var app = global.Application;
      if (!app) return false;
      var st = Number(app.WindowState);
      if (st === 2 || st === -4140) return true;
      try {
        if (app.Visible === false) return true;
      } catch (e1) {}
      return false;
    } catch (e) {
      return false;
    }
  }

  /** 独立窗：持续记位置；主窗最小化则关门并打「待重开」标记。
   * opts.docked=true：TaskPane 停靠，只记宽不关窗（原生跟主窗）。
   */
  function watchWindow(which, opts) {
    opts = opts || {};
    var docked = !!opts.docked;
    var last = "";
    var lastMin = null;
    var closing = false;

    function persist() {
      if (closing || (!docked && isHostMinimized())) return;
      var g = readWindowGeom();
      if (!g) return;
      var sig = g.w + "," + g.h + "," + g.left + "," + g.top;
      if (sig === last) return;
      last = sig;
      saveGeom(which, g);
    }

    function onHostState() {
      if (docked) return;
      var min = isHostMinimized();
      if (min === lastMin) return;
      lastMin = min;
      if (!min) return;
      persist();
      setWantOpen(which, true);
      setWantOpen("workspace", true);
      closing = true;
      setTimeout(function () {
        try {
          global.close();
        } catch (e) {
          try {
            window.close();
          } catch (e2) {}
        }
      }, 80);
    }

    setInterval(persist, 600);
    if (!docked) setInterval(onHostState, 280);
    global.addEventListener("beforeunload", function () {
      if (!closing) persist();
    });
    global.addEventListener("pagehide", function () {
      if (!closing) persist();
    });
    setTimeout(persist, 350);
    if (!docked) setTimeout(onHostState, 100);
  }

  global.GwUserPrefs = {
    get: get,
    set: set,
    loadGeom: loadGeom,
    saveGeom: saveGeom,
    readWindowGeom: readWindowGeom,
    watchWindow: watchWindow,
    setWantOpen: setWantOpen,
    getWantOpen: getWantOpen,
    appOriginPx: appOriginPx,
    isHostMinimized: isHostMinimized
  };
})(window);
