# 公文 MD 扩展（B0 + B1）

嵌入现网 `Word/editor/editor.html`（Vditor + 人机双写）。  
正文权威在本地 md；AI 经扩展宿主代打云中转（模型 Key 只在服务器）。

**总体方案（当前态）**：[`../specs/2026-08-10-总体方案-当前态.md`](../specs/2026-08-10-总体方案-当前态.md)  
**商业化**：[`../specs/2026-08-11-商业化总方案.md`](../specs/2026-08-11-商业化总方案.md) · S1 接口 [`../specs/2026-08-11-S1-接口与DDL.md`](../specs/2026-08-11-S1-接口与DDL.md)

**安全红线**：云中转只收发文本，**绝不**读写服务器或用户磁盘。  
对话改稿 / 建文件 / 重命名只走本机 `vscode.workspace.fs` + 工作区沙箱（见 `localFs.js`）。

## 安装（本机调试）

```bat
Word\extension\安装到VSCode.ps1
```

或仓库根目录 F5：`Run Gongwen Extension`。

## 必配设置（设置里搜「公文」）

| 项 | 说明 |
|----|------|
| `gongwen.serverUrl` | 中转地址，如 `http://HOST:8080/gongwen-relay` |
| 登录 | 命令面板：「公文：注册账号 / 登录账号 / 查看额度」——短票进 SecretStorage |
| `gongwen.capability` | `fast`=标准 / `strong`=增强（模型由云端路由） |
| `gongwen.relayToken` | 【过渡】运维长期令牌；正式环境以账号短票为准 |
| `gongwen.defaultProvider` | 【过渡】调试用；登录后由服务端 `model_routes` 决定 |

## 用法

1. 打开 `.md` → 命令「公文：用安全编辑器打开当前 MD」
2. 顶栏：创建（另存为新建 md）、打开、保存、存版本、导出 docx、关闭、重新加载
3. 格式栏：加黑 / 下划线 / 红字 / 黑底白字 / **H1–H4·正文**（选区 DOM 改格式）
4. 右侧双写：工具栏**锁头**=授权改稿（可划选；生成中才冻 DOM）→ Keep All / Undo All
5. 顶栏**设置**→通用：登录/注册/额度；智能档在顶栏「标准/增强」（无厂商名）
6. 侧栏 Tab：**撰写 | 精修 | 校对**；校对走中转 `POST /api/proofread`
7. 自动读材料**只认当前工程 `素材/`**；可用 `@文件` 点名
8. 据实写作未读到素材正文时取消胡编落稿；Undo All 会写回原文
9. 工程记忆：`.gongwen/memory.md`；工程配置：`.gongwen/config.json`
10. 调试：「公文：显示调试日志」；工程日志在 `工程根/.gongwen/logs/`
11. 账号：「公文：登录账号」后 AI 带短票；「查看额度」看日/月剩余  
12. 官方包：「同步官方手册与模板」→ `.gongwen/official/`；「用官方模板新建稿」

导出 docx 需本机 Python 能跑 `Word/tools/md2docx.py`（可设环境变量 `GONGWEN_PYTHON`）。

## 结构

| 文件 | 作用 |
|------|------|
| `extension.js` | 激活、命令、保存快照、账号命令 |
| `accountAuth.js` | 登录短票 / refresh / SecretStorage |
| `gongwenEditor.js` | CustomTextEditor + 宿主 RPC |
| `chatToolLoop.js` | 对话工具环编排（本机读盘 + 中转多轮） |
| `materialTools.js` | list/read/search 与 catalog |
| `projectMemory.js` | `.gongwen/memory.md` |
| `chatInfer.js` | 本机补框架/整篇/续写；无素材时拦截编造 |
| `gongwenWorkspace.js` | `.gongwen/`、按打开 md 定根、文件列表 |
| `localFs.js` | 工作区沙箱 + `workspace.fs` |
| `embedHtml.js` | 嵌入 editor.html |
| `relayProxy.js` | 宿主代打中转 |
| `media/vscode-bridge.js` | 页内 fetch → 中转 / RPC |
| `snapshot.js` / `log.js` | 快照；扩展日志 + 工程 `.gongwen/logs/` |
| `test_chatInfer.js` / `test_materialTools.js` | 本地单测（`node Word/extension/test_*.js`） |
