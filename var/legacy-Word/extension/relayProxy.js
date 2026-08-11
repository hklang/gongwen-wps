const http = require("http");
const https = require("https");
const { URL } = require("url");
const log = require("./log");

/**
 * 扩展宿主代打云中转（避开 webview 直连 HTTP 被拦 / 403）
 * @param {string} base
 * @param {string} token
 * @param {string} method
 * @param {string} apiPath  e.g. /api/ai-config?provider=deepseek
 * @param {unknown} [body]
 * @returns {Promise<{status:number, json:any, text:string}>}
 */
function relayRequest(base, token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const root = String(base || "").replace(/\/$/, "");
    if (!root) {
      resolve({ status: 500, json: { error: "未配置中转地址" }, text: "" });
      return;
    }
    let url;
    try {
      url = new URL(root + (apiPath.startsWith("/") ? apiPath : "/" + apiPath));
    } catch (e) {
      resolve({ status: 500, json: { error: "中转地址无效" }, text: "" });
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const payload =
      body == null || method === "GET" || method === "HEAD"
        ? null
        : Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: method || "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + String(token || ""),
          "X-Relay-Token": String(token || ""),
          "X-Gongwen-Client": "vscode-extension",
          ...(payload
            ? {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": String(payload.length),
              }
            : {}),
        },
        timeout: 180000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text || "{}");
          } catch (_) {
            json = { error: text || ("HTTP " + res.statusCode) };
          }
          log.info("relayProxy.done", {
            path: url.pathname,
            status: res.statusCode,
          });
          resolve({ status: res.statusCode || 0, json, text });
        });
      }
    );
    req.on("error", (e) => {
      log.error("relayProxy.error", { message: String(e.message || e) });
      resolve({
        status: 502,
        json: { error: "中转连接失败：" + String(e.message || e) },
        text: "",
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 504, json: { error: "中转超时" }, text: "" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { relayRequest };
