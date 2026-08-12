# gongwen-wps

公文「人机双写」— **WPS 文字加载项**独立工程（与「半年工作总结」个人材料仓分离）。

## 目录

| 路径 | 说明 |
|------|------|
| `wps-addin/` | WPS JS 加载项（主力开发） |
| `specs/` | 现行规格 |
| `Code/想构思.md` | 产品构思约束 |
| `var/legacy-Word/` | **旧项目参考**（自半年工作总结 `Word/` 拷贝，只读对照） |

## 调试

```powershell
# 1）本机中转（现阶段默认；Key 读自 var/legacy-Word/editor/settings.py）
cd var\legacy-Word\deploy\relay
powershell -ExecutionPolicy Bypass -File .\start_local.ps1

# 2）WPS 加载项
cd wps-addin
npx wpsjs debug -s
```

加载项默认连 `http://127.0.0.1:3000`。功能区 **开始 → 公文**：

| 按钮 | 作用 |
|------|------|
| **打开公文助手** | 独立窗 `workspace.html`（左工程 + 右 AI） |
| 仅工程窗 | 独立小窗 `projpane.html` |

工程栏：

- 列表只认 **doc / docx**（工程根默认=当前文档目录）
- **改绑** 打开当前工程目录，选中后自动建 `素材/` `模板/` `版本/` `.gongwen/`
- **连点两次** 或右键「用 WPS 打开」→ 只读新标签
- 右键「引用」→ 抽正文给 AI；「版本」旁 **存版本** → 当前稿快照到 `版本/`

AI 侧栏：

- 右上角 **登录**（联调可自动测试模式，不限额度）
- **素材旁「刷新」**：全量重建 `.gongwen/materials-index.json`；发送前会按修改时间增量同步
- **撰写工具环**：模型可按需读本机素材（精读现抽）；界面只显示用户自己的 `@引用`，不刷自动已读列表
- **撰写**：点选 **一级/二级/三级/正文**（可多选）→ 可钉范围 → **出结论/给多份** → 卡片落稿
- **精修**：钉住 → 充填 / 润色出方案 → 预览 / 采用；钉住旁 **还原**；**再钉住会清空旧方案**
- 写回保留段末回车，避免与下一段粘连

> WPS 12.1.0.26895+ 的 `CreateTaskPane` 会挡 Ribbon，**暂放弃停靠**，改用 `ShowDialog`。改 ribbon 后请完全退出再开 WPS。

## 与旧仓关系

- 个人材料仓：`涛总个人材料/半年工作总结`（文稿）
- 本仓 `var/legacy-Word`：旧产品代码快照，**新改动不要写进 var**
- VS Code 扩展 / editor / relay 以 var 为参考，后续再正式迁入本仓模块
