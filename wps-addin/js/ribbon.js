function OnAddinLoad(ribbonUI) {
  if (typeof window.Application.ribbonUI != "object") {
    window.Application.ribbonUI = ribbonUI;
  }
  if (typeof window.Application.Enum != "object") {
    window.Application.Enum = WPS_Enum;
  }
  lockHostPageSize();
  hideStoredTaskPane();
  try {
    startHostMinRestoreWatcher();
  } catch (e) {}
  return true;
}

function lockHostPageSize() {
  try {
    var css =
      "margin:0!important;padding:0!important;width:0!important;height:0!important;" +
      "max-height:0!important;overflow:hidden!important;background:transparent!important;" +
      "position:fixed!important;left:-9999px!important;top:-9999px!important;";
    if (document.documentElement) document.documentElement.style.cssText = css;
    if (document.body) document.body.style.cssText = css;
  } catch (e) {}
}

function hideStoredTaskPane() {
  try {
    var id = window.Application.PluginStorage.getItem("gw_taskpane_id");
    if (id) {
      try {
        var pane = window.Application.GetTaskPane(Number(id) || id);
        if (pane) {
          try {
            pane.Visible = false;
          } catch (e1) {}
        }
      } catch (e2) {}
      window.Application.PluginStorage.removeItem("gw_taskpane_id");
    }
  } catch (e) {}
}

function httpUiUrl(relPath) {
  var url = GetUrlPath() + relPath;
  if (/^file:/i.test(url) || url.indexOf("://") < 0) {
    alert(
      "拒绝打开：当前不是 http(s) 调试地址。\n请用「wpsjs debug」启动后再点。\nurl=" +
        url
    );
    return "";
  }
  return url;
}

function assistantUrl() {
  return httpUiUrl("/ui/taskpane.html");
}

function projectUrl() {
  return httpUiUrl("/ui/projpane.html");
}

/**
 * ShowDialogEx 贴位置（屏幕像素）。
 * 有记忆坐标时用 isChildWindow=false，减少被主窗布局强行居中。
 */
function showBandDialog(url, title, dlgW, dlgH, screenLeft, screenTop, asChild) {
  var app = window.Application;
  var shown = false;
  var absL = Math.round(Number(screenLeft) || 0);
  var absT = Math.round(Number(screenTop) || 0);
  var child = asChild !== false;
  var appLeftPx = 0;
  var appTopPx = 0;
  try {
    appLeftPx = ptToPx(Number(app.Left) || 0);
    appTopPx = ptToPx(Number(app.Top) || 0);
  } catch (e0) {}
  var relL = Math.round(absL - appLeftPx);
  var relT = Math.round(absT - appTopPx);

  function callEx(fn, left, top, isChild) {
    if (typeof fn !== "function") return false;
    try {
      fn(url, title, dlgW, dlgH, false, true, 2, "", 0, !!isChild, false, false, left, top);
      return true;
    } catch (e1) {
      try {
        fn(url, title, dlgW, dlgH, false, true, 2, "", 0, !!isChild, false, true, left, top);
        return true;
      } catch (e2) {
        try {
          fn(url, title, dlgW, dlgH, false, true, true, null, null, !!isChild, null, left, top);
          return true;
        } catch (e3) {
          return false;
        }
      }
    }
  }

  var tries = [
    [absL, absT, child],
    [absL, absT, !child],
    [relL, relT, child],
    [relL, relT, !child]
  ];
  for (var i = 0; i < tries.length && !shown; i++) {
    var t = tries[i];
    if (callEx(app.ShowDialogEx, t[0], t[1], t[2])) shown = true;
    else if (typeof wps !== "undefined" && callEx(wps.ShowDialogEx, t[0], t[1], t[2])) {
      shown = true;
    }
  }

  if (!shown) {
    try {
      app.ShowDialog(url, title, dlgW, dlgH, false, true, 2, "", 0, true, false, false);
      shown = true;
    } catch (e4) {
      try {
        app.ShowDialog(url, title, dlgW, dlgH, false, true, 2);
        shown = true;
      } catch (e5) {
        try {
          app.ShowDialog(url, title, dlgW, dlgH, false);
          shown = true;
        } catch (e6) {}
      }
    }
  }
  return shown;
}

/** Windows：按标题强制挪窗（ShowDialogEx 坐标常被忽略时的兜底） */
function placeDialogByTitle(title, left, top, w, h) {
  try {
    var app = window.Application;
    if (!app || typeof app.ExecuteExcel4Macro !== "function") return false;
    var safe = String(title || "").replace(/"/g, "");
    if (!safe) return false;
    var hwnd = 0;
    try {
      hwnd = app.ExecuteExcel4Macro(
        'CALL("user32","FindWindowW","JCC",0,"' + safe + '")'
      );
    } catch (e1) {}
    if (!hwnd) {
      try {
        hwnd = app.ExecuteExcel4Macro(
          'CALL("user32","FindWindowA","JCC","Qt5QWindowIcon","' + safe + '")'
        );
      } catch (e2) {}
    }
    if (!hwnd) return false;
    app.ExecuteExcel4Macro(
      'CALL("user32","SetWindowPos","JJJJJJJ",' +
        hwnd +
        ",0," +
        Math.round(left) +
        "," +
        Math.round(top) +
        "," +
        Math.round(w) +
        "," +
        Math.round(h) +
        ",0x0040)"
    );
    return true;
  } catch (e) {
    return false;
  }
}

function placeDialogSoon(title, left, top, w, h) {
  [120, 350, 700, 1200].forEach(function (ms) {
    setTimeout(function () {
      placeDialogByTitle(title, left, top, w, h);
    }, ms);
  });
}

function resolveDialogGeom(which, fallback) {
  var saved =
    typeof GwUserPrefs !== "undefined" ? GwUserPrefs.loadGeom(which) : null;
  if (saved && isFinite(saved.left) && isFinite(saved.top)) {
    return {
      w: saved.w,
      h: saved.h,
      left: saved.left,
      top: saved.top,
      remembered: true
    };
  }
  return fallback;
}

function ptToPx(v) {
  var n = Number(v);
  if (!isFinite(n)) return 0;
  return (n * 96) / 72;
}

/**
 * 工作带：功能区标签栏下沿 → 底部状态条上沿。
 * 对话框必须落在此带内，不能盖住顶部 Tab。
 */
function getWorkBandPx() {
  var app = window.Application;
  var dpr = window.devicePixelRatio || 1;
  var statusPt = 30; // 底栏约高
  var minRibbonPt = 100; // 标题+功能区至少

  var appLeft = 0;
  var appTop = 0;
  var appW = 1280;
  var appH = 800;
  try {
    appLeft = Number(app.Left) || 0;
    appTop = Number(app.Top) || 0;
    appW = Number(app.Width) || 1280;
    appH = Number(app.Height) || 800;
  } catch (e) {}

  var usableH = 0;
  var usableW = 0;
  try {
    usableH = Number(app.UsableHeight) || 0;
    usableW = Number(app.UsableWidth) || 0;
  } catch (e2) {}
  try {
    if (!(usableH > 50) && app.ActiveWindow) {
      usableH = Number(app.ActiveWindow.UsableHeight) || 0;
      usableW = Number(app.ActiveWindow.UsableWidth) || usableW;
    }
  } catch (e3) {}

  // 优先：ActiveWindow 几何若像「正文区」则直接用
  try {
    var win = app.ActiveWindow;
    if (win) {
      var wTop = Number(win.Top);
      var wLeft = Number(win.Left);
      var wH = Number(win.Height);
      var wW = Number(win.Width);
      // ActiveWindow.Top 相对 Application 时通常 > 50（磅）
      if (isFinite(wTop) && isFinite(wH) && wH > 120) {
        var bandTopPt = appTop + Math.max(wTop, minRibbonPt);
        var bandHPt = Math.min(wH, appH - (bandTopPt - appTop) - statusPt);
        if (bandHPt > 200) {
          return {
            left: ptToPx(appLeft + (isFinite(wLeft) ? Math.max(0, wLeft) : 0)),
            top: ptToPx(bandTopPt),
            width: ptToPx(isFinite(wW) && wW > 200 ? wW : appW),
            height: ptToPx(bandHPt),
            source: "ActiveWindow"
          };
        }
      }
    }
  } catch (e4) {}

  // 次选：UsableHeight = 文档窗最大高度 → 顶栏占用 = 总高 - 可用高 - 底栏
  if (usableH > 200 && usableH < appH) {
    var topChrome = appH - usableH - statusPt;
    if (topChrome < minRibbonPt) topChrome = minRibbonPt;
    if (topChrome > appH * 0.45) topChrome = minRibbonPt + 40;
    return {
      left: ptToPx(appLeft),
      top: ptToPx(appTop + topChrome),
      width: ptToPx(usableW > 200 ? usableW : appW),
      height: ptToPx(usableH),
      source: "UsableHeight"
    };
  }

  // 兜底：按常见 UI 扣掉顶栏/底栏（逻辑像素再转）
  var ribbonPx = Math.round(168 * dpr);
  var statusPx = Math.round(36 * dpr);
  return {
    left: ptToPx(appLeft),
    top: ptToPx(appTop) + ribbonPx,
    width: ptToPx(appW),
    height: Math.max(320, ptToPx(appH) - ribbonPx - statusPx),
    source: "estimate"
  };
}

/** 主路径：单独立窗（左右分栏）。停靠 TaskPane 在 26895+ 会挡 Ribbon，暂不用。 */
function openGongwenWorkspace() {
  return openAssistantDialog();
}

/** 仅工程：独立小窗 */
function openProjectDialog() {
  lockHostPageSize();
  hideStoredTaskPane();
  var url = projectUrl();
  if (!url) return false;

  var dpr = window.devicePixelRatio || 1;
  var band = getWorkBandPx();
  var fbW = Math.round(280 * dpr);
  var fbH = Math.max(320, Math.round(band.height));
  var fbLeft = Math.round(band.left + 4 * dpr);
  var g = resolveDialogGeom("project", {
    w: fbW,
    h: fbH,
    left: fbLeft,
    top: Math.round(band.top),
    remembered: false
  });

  var shown = showBandDialog(url, "公文工程", g.w, g.h, g.left, g.top, true);
  placeDialogSoon("公文工程", g.left, g.top, g.w, g.h);
  if (typeof GwUserPrefs !== "undefined") {
    GwUserPrefs.setWantOpen("project", false);
  }
  if (!shown) alert("无法打开工程窗");
  return shown;
}

/** 单独立窗（内含左右分栏 workspace.html） */
function openAssistantDialog() {
  lockHostPageSize();
  hideStoredTaskPane();

  var url = httpUiUrl("/ui/workspace.html");
  if (!url) return false;

  var dpr = window.devicePixelRatio || 1;
  var band = getWorkBandPx();
  var fbW = Math.round(640 * dpr);
  var fbH = Math.max(320, Math.round(band.height));
  var fbLeft = Math.round(band.left + band.width - fbW - 4 * dpr);
  if (fbLeft < band.left) fbLeft = Math.round(band.left);
  var g = resolveDialogGeom("assistant", {
    w: fbW,
    h: fbH,
    left: fbLeft,
    top: Math.round(band.top),
    remembered: false
  });

  var shown = showBandDialog(url, "公文助手", g.w, g.h, g.left, g.top, true);
  placeDialogSoon("公文助手", g.left, g.top, g.w, g.h);
  if (typeof GwUserPrefs !== "undefined") {
    GwUserPrefs.setWantOpen("assistant", true);
    GwUserPrefs.setWantOpen("workspace", true);
  }
  if (!shown) alert("无法打开公文助手");
  return shown;
}

/** 主窗最小化还原后重开独立窗 */
function startHostMinRestoreWatcher() {
  var wasMin = false;
  var reopenTimer = null;
  try {
    wasMin =
      typeof GwUserPrefs !== "undefined" && GwUserPrefs.isHostMinimized
        ? GwUserPrefs.isHostMinimized()
        : false;
  } catch (e) {}
  setInterval(function () {
    var min = false;
    try {
      if (typeof GwUserPrefs !== "undefined" && GwUserPrefs.isHostMinimized) {
        min = GwUserPrefs.isHostMinimized();
      } else {
        var st = Number(Application.WindowState);
        min = st === 2 || st === -4140;
      }
    } catch (e2) {
      return;
    }
    if (wasMin && !min && typeof GwUserPrefs !== "undefined") {
      if (reopenTimer) clearTimeout(reopenTimer);
      reopenTimer = setTimeout(function () {
        var need =
          GwUserPrefs.getWantOpen("workspace") ||
          GwUserPrefs.getWantOpen("assistant");
        if (!need) return;
        openAssistantDialog();
      }, 400);
    }
    wasMin = min;
  }, 350);
}

function OnAction(control) {
  var id = control && control.Id;
  if (id === "btnShowDialog" || id === "btnShowDialogHome") {
    openGongwenWorkspace();
    return true;
  }
  if (id === "btnShowProject") {
    openProjectDialog();
    return true;
  }
  return true;
}

function GetImage(control) {
  return "images/3.svg";
}

function OnGetEnabled(control) {
  return true;
}

function OnGetVisible(control) {
  return true;
}

function OnGetLabel(control) {
  return "打开公文助手";
}
