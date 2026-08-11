const vscode = require("vscode");
const path = require("path");
const log = require("./log");
const { GongwenMdEditorProvider } = require("./gongwenEditor");
const { revealSnapDir, writeSnapshot } = require("./snapshot");
const accountAuth = require("./accountAuth");
const officialSync = require("./officialSync");

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const ch = log.init(context);
  context.subscriptions.push(ch);
  accountAuth.init(context);
  accountAuth.refreshStatusBar().catch(() => {});

  context.subscriptions.push(GongwenMdEditorProvider.register(context));
  log.info("provider.registered", { viewType: GongwenMdEditorProvider.viewType });

  context.subscriptions.push(
    vscode.commands.registerCommand("gongwen.account.login", async () => {
      await accountAuth.loginInteractive();
    }),
    vscode.commands.registerCommand("gongwen.account.register", async () => {
      await accountAuth.registerInteractive();
    }),
    vscode.commands.registerCommand("gongwen.account.logout", async () => {
      await accountAuth.logoutInteractive();
    }),
    vscode.commands.registerCommand("gongwen.account.status", async () => {
      await accountAuth.showAccountStatus();
      await accountAuth.refreshStatusBar();
    }),
    vscode.commands.registerCommand("gongwen.official.sync", () =>
      officialSync.syncInteractive()
    ),
    vscode.commands.registerCommand("gongwen.official.applyTemplate", () =>
      officialSync.applyTemplateInteractive()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gongwen.openMdEditor", async () => {
      log.info("cmd.openMdEditor.start");
      try {
        const ed = vscode.window.activeTextEditor;
        let uri = ed && ed.document.uri;
        if (!uri || uri.scheme !== "file" || !uri.fsPath.toLowerCase().endsWith(".md")) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { Markdown: ["md"] },
          });
          if (!picked || !picked[0]) {
            log.info("cmd.openMdEditor.cancel");
            return;
          }
          uri = picked[0];
        }
        log.info("cmd.openMdEditor.openWith", { path: uri.fsPath });
        await vscode.commands.executeCommand(
          "vscode.openWith",
          uri,
          GongwenMdEditorProvider.viewType
        );
        log.info("cmd.openMdEditor.done");
      } catch (e) {
        log.error("cmd.openMdEditor.fail", { message: String(e && e.message ? e.message : e) });
        vscode.window.showErrorMessage("打开公文编辑器失败：" + String(e && e.message ? e.message : e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gongwen.revealSnapDir", async () => {
      log.info("cmd.revealSnapDir.start");
      let mdPath =
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.uri.fsPath;
      if (!mdPath || !mdPath.toLowerCase().endsWith(".md")) {
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input = tab.input;
            if (input && input.uri && String(input.uri.fsPath).toLowerCase().endsWith(".md")) {
              mdPath = input.uri.fsPath;
              break;
            }
          }
          if (mdPath) break;
        }
      }
      if (!mdPath) {
        log.warn("cmd.revealSnapDir.noMd");
        vscode.window.showInformationMessage("请先打开一个 .md 文件");
        return;
      }
      await revealSnapDir(mdPath);
      log.info("cmd.revealSnapDir.done", { path: mdPath });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gongwen.showLog", () => {
      log.show();
      const f = log.getLogFile();
      const proj = log.getProjectLogFile && log.getProjectLogFile();
      if (proj || f) {
        vscode.window.setStatusBarMessage(
          "公文日志：" + (proj || f),
          8000
        );
      }
      log.info("cmd.showLog", { file: f || "", projectLog: proj || "" });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== "file" || !doc.uri.fsPath.toLowerCase().endsWith(".md")) {
        return;
      }
      if (!GongwenMdEditorProvider.tracked.has(doc.uri.toString())) {
        log.debug("save.skip.untracked", { path: doc.uri.fsPath });
        return;
      }
      const cfg = vscode.workspace.getConfiguration("gongwen");
      if (!cfg.get("snapshotOnSave", true)) {
        log.info("save.snapshot.disabled", { path: doc.uri.fsPath });
        return;
      }
      const keep = cfg.get("snapshotKeep", 20) || 20;
      const t0 = Date.now();
      const snap = await writeSnapshot(doc.uri.fsPath, keep);
      if (snap) {
        log.info("save.snapshot.ok", {
          path: doc.uri.fsPath,
          snap,
          ms: Date.now() - t0,
          bytes: doc.getText().length,
        });
        vscode.window.setStatusBarMessage(
          "公文快照已保存 · " + path.basename(snap),
          4000
        );
      } else {
        log.error("save.snapshot.fail", { path: doc.uri.fsPath });
      }
    })
  );

  log.info("activate.done");
}

function deactivate() {
  log.info("deactivate");
}

module.exports = { activate, deactivate };
