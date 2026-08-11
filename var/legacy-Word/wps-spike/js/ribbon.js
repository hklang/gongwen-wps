function OnAddinLoad(ribbonUI) {
  if (typeof window.Application.ribbonUI != "object") {
    window.Application.ribbonUI = ribbonUI;
  }
  if (typeof window.Application.Enum != "object") {
    window.Application.Enum = WPS_Enum;
  }
  lockHostPageSize();
  hideStoredTaskPane();
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

function assistantUrl() {
  var url = GetUrlPath() + "/ui/taskpane.html";
  if (/^file:/i.test(url) || url.indexOf("://") < 0) {
    alert(
      "拒绝打开：当前不是 http(s) 调试地址。\n请用「wpsjs debug」启动后再点。\nurl=" +
        url
    );
    return "";
  }
  return url;
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

/**
 * 独立窗：贴工作带最右侧；顶=标签下沿，底=状态条上沿。
 */
function openAssistantDialog() {
  lockHostPageSize();
  hideStoredTaskPane();

  var url = assistantUrl();
  if (!url) return;

  var dpr = window.devicePixelRatio || 1;
  var band = getWorkBandPx();
  var dlgW = Math.round(400 * dpr);
  var dlgH = Math.max(320, Math.round(band.height));
  var dlgLeft = Math.round(band.left + band.width - dlgW - 4 * dpr);
  if (dlgLeft < band.left) dlgLeft = Math.round(band.left);
  var dlgTop = Math.round(band.top);

  var app = window.Application;
  var shown = false;

  var tryEx = function (fn) {
    if (typeof fn !== "function") return false;
    try {
      fn(
        url,
        "公文助手",
        dlgW,
        dlgH,
        false,
        true,
        2,
        "",
        0,
        true,
        false,
        true,
        dlgLeft,
        dlgTop
      );
      return true;
    } catch (e1) {
      try {
        fn(
          url,
          "公文助手",
          dlgW,
          dlgH,
          false,
          true,
          true,
          null,
          null,
          null,
          null,
          dlgLeft,
          dlgTop
        );
        return true;
      } catch (e2) {
        return false;
      }
    }
  };

  if (tryEx(app.ShowDialogEx)) shown = true;
  if (!shown && typeof wps !== "undefined" && tryEx(wps.ShowDialogEx)) shown = true;

  if (!shown) {
    try {
      app.ShowDialog(url, "公文助手", dlgW, dlgH, false, true, 2);
      shown = true;
    } catch (e3) {
      app.ShowDialog(url, "公文助手", dlgW, dlgH, false);
      shown = true;
    }
  }

  if (!shown) alert("无法打开独立窗口");
}

function OnTabActivate(control) {
  openAssistantDialog();
  return true;
}

function OnAction(control) {
  if (control.Id === "btnShowDialog") {
    openAssistantDialog();
    return true;
  }
  return true;
}

function GetImage(control) {
  return "images/2.svg";
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
