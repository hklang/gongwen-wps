const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const log = require("./log");

/** @param {vscode.Uri} dir @param {...string} parts */
function asFileUri(webview, dir, ...parts) {
  return webview.asWebviewUri(vscode.Uri.file(path.join(dir.fsPath, ...parts)));
}

/**
 * 嵌入现网 editor.html，注入 bridge / 图标 / CSP。
 * @param {vscode.Webview} webview
 * @param {vscode.TextDocument} document
 * @param {{serverUrl:string,token:string,provider:string,capability?:string,authMode?:string}} relay
 * @param {{editorDir:vscode.Uri, mediaDir:vscode.Uri}} dirs
 */
function buildEmbeddedHtml(webview, document, relay, dirs) {
  const { editorDir, mediaDir } = dirs;
  const htmlPath = path.join(editorDir.fsPath, "editor.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  const vditorCss = asFileUri(webview, editorDir, "vendor", "vditor", "index.min.css");
  const vditorJs = asFileUri(webview, editorDir, "vendor", "vditor", "index.min.js");
  const vditorCdn = asFileUri(webview, editorDir, "vendor", "vditor").toString();
  // 带版本查询，避免 webview 缓存旧皮肤（左侧工程栏等）
  const gongwenCss = asFileUri(webview, editorDir, "gongwen.css").toString() + "?v=169";
  const bridgeJs = asFileUri(webview, mediaDir, "vscode-bridge.js");
  const iconsJs = asFileUri(
    webview,
    editorDir,
    "vendor",
    "vditor",
    "dist",
    "js",
    "icons",
    "ant.js"
  );
  const overrideCss = asFileUri(webview, mediaDir, "vscode-overrides.css");

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-eval' 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `img-src ${webview.cspSource} data: blob:`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");

  html = html.replace(
    /<meta charset="UTF-8">/i,
    `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`
  );
  html = html.replace(/href="\/vditor\/index\.min\.css"/, `href="${vditorCss}"`);
  html = html.replace(
    /href="\/gongwen\.css[^"]*"/,
    `href="${gongwenCss}"\n  <link rel="stylesheet" href="${overrideCss}">`
  );
  html = html.replace(/src="\/vditor\/index\.min\.js"/, `src="${vditorJs}"`);
  html = html.replace(/cdn:\s*'\/vditor'/, `cdn: ${JSON.stringify(vditorCdn)}`);
  // 保留 editor.html 版本号，仅追加 ·VSCode（勿写死旧版号）
  html = html.replace(/>(v\d+)</, ">$1·VSCode<");

  const boot = {
    serverUrl: relay.serverUrl,
    token: relay.token,
    provider: relay.provider,
    capability: relay.capability || "fast",
    authMode: relay.authMode || "none",
    path: document.uri.fsPath,
    filename: path.basename(document.uri.fsPath),
    initialMd: document.getText(),
  };
  const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c");
  const injectHead = `
<script>window.__GONGWEN_VSCODE__ = ${bootJson};</script>
<script src="${bridgeJs}"></script>
`;
  const injectIcons = `\n<script src="${iconsJs}"></script>\n`;

  if (html.includes("<body>")) {
    html = html.replace("<body>", "<body>" + injectHead);
  }
  if (/<script src="[^"]*vditor[^"]*index\.min\.js"><\/script>/.test(html)) {
    html = html.replace(
      /<script src="[^"]*vditor[^"]*index\.min\.js"><\/script>/,
      injectIcons + "$&"
    );
  } else {
    html = injectIcons + html;
  }

  log.info("editor.html.embed", {
    htmlPath,
    bytes: html.length,
    vditorCdn,
  });
  return html;
}

module.exports = { buildEmbeddedHtml };
