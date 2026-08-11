/** 账号短票：SecretStorage 存 refresh；access 内存+落盘密钥。 */
const vscode = require("vscode");
const { relayRequest } = require("./relayProxy");
const log = require("./log");

const K_ACCESS = "gongwen.accessToken";
const K_REFRESH = "gongwen.refreshToken";
const K_EMAIL = "gongwen.accountEmail";
const K_ACCESS_EXP = "gongwen.accessExp";

/** @type {vscode.ExtensionContext | null} */
let _ctx = null;

function init(context) {
  _ctx = context;
}

function serverUrl() {
  const cfg = vscode.workspace.getConfiguration("gongwen");
  return String(cfg.get("serverUrl") || "").trim().replace(/\/$/, "");
}

function legacyToken() {
  const cfg = vscode.workspace.getConfiguration("gongwen");
  return String(cfg.get("relayToken") || "").trim();
}

async function getSecrets() {
  if (!_ctx) return { access: "", refresh: "", email: "", exp: 0 };
  const secrets = _ctx.secrets;
  const access = (await secrets.get(K_ACCESS)) || "";
  const refresh = (await secrets.get(K_REFRESH)) || "";
  const email = (await secrets.get(K_EMAIL)) || "";
  const expRaw = (await secrets.get(K_ACCESS_EXP)) || "0";
  return { access, refresh, email, exp: Number(expRaw) || 0 };
}

async function saveSession(data) {
  if (!_ctx) return;
  const secrets = _ctx.secrets;
  const access = data.access_token || "";
  const refresh = data.refresh_token || "";
  const email = (data.user && data.user.email) || "";
  const exp = Math.floor(Date.now() / 1000) + Number(data.expires_in || 1800) - 60;
  await secrets.store(K_ACCESS, access);
  await secrets.store(K_REFRESH, refresh);
  await secrets.store(K_EMAIL, email);
  await secrets.store(K_ACCESS_EXP, String(exp));
}

async function clearSession() {
  if (!_ctx) return;
  const secrets = _ctx.secrets;
  await secrets.delete(K_ACCESS);
  await secrets.delete(K_REFRESH);
  await secrets.delete(K_EMAIL);
  await secrets.delete(K_ACCESS_EXP);
}

/**
 * 优先 access 短票；过期则 refresh；都没有则回落 legacy relayToken（过渡）。
 */
async function resolveAuthToken() {
  const base = serverUrl();
  const { access, refresh, exp } = await getSecrets();
  const now = Math.floor(Date.now() / 1000);
  if (access && exp > now + 5) {
    return { token: access, mode: "user" };
  }
  if (refresh && base) {
    try {
      const r = await relayRequest(base, "", "POST", "/api/auth/refresh", {
        refresh_token: refresh,
      });
      if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
        await saveSession(r.json);
        return { token: r.json.access_token, mode: "user" };
      }
      log.warn("auth.refresh.fail", { status: r.status, err: r.json && r.json.error });
      await clearSession();
    } catch (e) {
      log.error("auth.refresh.error", { message: String(e.message || e) });
    }
  }
  const legacy = legacyToken();
  if (legacy) return { token: legacy, mode: "legacy" };
  return { token: "", mode: "none" };
}

async function loginInteractive() {
  const base = serverUrl();
  if (!base) {
    vscode.window.showErrorMessage("请先在设置里填写 gongwen.serverUrl");
    return false;
  }
  const email = await vscode.window.showInputBox({
    prompt: "登录邮箱",
    placeHolder: "you@example.com",
    ignoreFocusOut: true,
  });
  if (!email) return false;
  const password = await vscode.window.showInputBox({
    prompt: "密码",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return false;
  const r = await relayRequest(base, "", "POST", "/api/auth/login", {
    email,
    password,
  });
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.access_token) {
    vscode.window.showErrorMessage(
      "登录失败：" + ((r.json && r.json.error) || ("HTTP " + r.status))
    );
    return false;
  }
  await saveSession(r.json);
  const plan = r.json.plan && r.json.plan.code ? r.json.plan.code : "";
  vscode.window.showInformationMessage(
    "已登录 " + email + (plan ? " · 套餐 " + plan : "")
  );
  await refreshStatusBar();
  return true;
}

async function registerInteractive() {
  const base = serverUrl();
  if (!base) {
    vscode.window.showErrorMessage("请先在设置里填写 gongwen.serverUrl");
    return false;
  }
  const email = await vscode.window.showInputBox({
    prompt: "注册邮箱",
    placeHolder: "you@example.com",
    ignoreFocusOut: true,
  });
  if (!email) return false;
  const password = await vscode.window.showInputBox({
    prompt: "密码（至少 8 位）",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return false;
  let regMode = "open";
  try {
    const h = await relayRequest(base, "", "GET", "/api/health");
    if (h.json && h.json.register_mode) regMode = String(h.json.register_mode);
  } catch (_) { /* ignore */ }
  const invite = await vscode.window.showInputBox({
    prompt:
      regMode === "invite"
        ? "邀请码（必填）"
        : regMode === "closed"
          ? "当前未开放注册"
          : "邀请码（可选，有码按码开通套餐）",
    placeHolder: "例如 AB12CD34",
    ignoreFocusOut: true,
  });
  if (invite === undefined) return false;
  if (regMode === "closed") {
    vscode.window.showErrorMessage("当前未开放注册，请联系运营开通");
    return false;
  }
  if (regMode === "invite" && !String(invite || "").trim()) {
    vscode.window.showErrorMessage("需要邀请码才能注册");
    return false;
  }
  const r = await relayRequest(base, "", "POST", "/api/auth/register", {
    email,
    password,
    invite_code: String(invite || "").trim(),
  });
  if (r.status < 200 || r.status >= 300 || !r.json || !r.json.access_token) {
    vscode.window.showErrorMessage(
      "注册失败：" + ((r.json && r.json.error) || ("HTTP " + r.status))
    );
    return false;
  }
  await saveSession(r.json);
  const plan = r.json.plan && r.json.plan.code ? r.json.plan.code : "";
  vscode.window.showInformationMessage(
    "注册成功并已登录：" + email + (plan ? " · 套餐 " + plan : "")
  );
  await refreshStatusBar();
  return true;
}

async function logoutInteractive() {
  await clearSession();
  vscode.window.showInformationMessage("已退出登录");
  await refreshStatusBar();
}

async function showAccountStatus() {
  const base = serverUrl();
  const auth = await resolveAuthToken();
  if (auth.mode !== "user") {
    const { email } = await getSecrets();
    vscode.window.showInformationMessage(
      email
        ? "登录已失效，请重新登录"
        : auth.mode === "legacy"
          ? "当前使用运维中转令牌（过渡模式），建议改用账号登录"
          : "未登录"
    );
    return;
  }
  const r = await relayRequest(base, auth.token, "GET", "/api/quota");
  if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
    const p = r.json.plan || {};
    vscode.window.showInformationMessage(
      `额度：今日剩余 ${r.json.remain_day}/${p.daily_requests} · 本月 ${r.json.remain_month}/${p.monthly_requests}` +
        (p.name ? " · " + p.name : "")
    );
  } else {
    vscode.window.showWarningMessage(
      "无法读取额度：" + ((r.json && r.json.error) || ("HTTP " + r.status))
    );
  }
}

/** @type {vscode.StatusBarItem | null} */
let _status = null;

function ensureStatusBar() {
  if (_status || !_ctx) return _status;
  _status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  _status.command = "gongwen.account.status";
  _ctx.subscriptions.push(_status);
  _status.show();
  return _status;
}

async function refreshStatusBar() {
  const bar = ensureStatusBar();
  if (!bar) return;
  const { email } = await getSecrets();
  const auth = await resolveAuthToken();
  const base = serverUrl();
  if (auth.mode === "user" && base) {
    try {
      const r = await relayRequest(base, auth.token, "GET", "/api/quota");
      if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
        const remain = r.json.remain_day;
        const plan =
          (r.json.plan && (r.json.plan.code || r.json.plan.name)) || "";
        bar.text =
          "公文·今日剩" +
          (remain != null ? remain : "?") +
          (plan ? "·" + plan : "");
        bar.tooltip =
          (email || "已登录") +
          " · 今日剩余 " +
          (remain != null ? remain : "?") +
          "/" +
          ((r.json.plan && r.json.plan.daily_requests) || "?") +
          " · 点击详情";
        return;
      }
    } catch (_) {
      /* fall through */
    }
    bar.text = "公文·已登录";
    bar.tooltip = (email || "已登录") + " · 点击查看额度";
  } else if (auth.mode === "legacy") {
    bar.text = "公文·运维票";
    bar.tooltip = "过渡：使用 relayToken；建议登录账号";
  } else {
    bar.text = "公文·未登录";
    bar.tooltip = "点击查看；命令面板可登录/注册（邀请码）";
  }
}

module.exports = {
  init,
  resolveAuthToken,
  loginInteractive,
  registerInteractive,
  logoutInteractive,
  showAccountStatus,
  getSecrets,
  clearSession,
  refreshStatusBar,
  serverUrl,
};
