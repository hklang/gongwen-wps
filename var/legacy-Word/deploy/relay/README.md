# 公文 AI 模型中转

部署在云机 LXD `mybox`：`/home/ubuntu/gongwen-relay/`，监听 **3000**。  
外网入口（已放行）：`http://49.233.190.103:8080/gongwen-relay/`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 探活（可不带 token） |
| GET | `/admin` | S4 运维单页（页面公开；API 仍要 `RELAY_TOKEN`） |
| POST | `/api/auth/register\|login\|refresh` | S1 账号短票 |
| GET | `/api/auth/me` · `/api/quota` | 需用户 access |
| GET | `/api/content/index` · `/api/content/pack` | S2/S3 官方分类/手册/模板/剧本（只读） |
| GET/POST | `/api/user/templates` | 我的模板（需登录；POST `op=create|update|delete`） |
| POST | `/api/admin/manual` · `/template` · `/playbook` | 运维改官方内容 |
| GET | `/api/ai-config` | 提供商/模型（调试；正式 C 端用 capability） |
| POST | `/api/suggest` · `/api/chat` · `/api/proofread` | 验票→配额→路由→调模 |
| GET | `/api/proofread/engines` | 引擎目录 |
| GET | `/api/admin/users?limit=` | 用户列表（legacy） |
| GET/POST | `/api/admin/routes` | 运维热切换（legacy 令牌） |
| POST | `/api/admin/user-status` · `/api/admin/kick` · `/api/admin/grant` | 禁用 / 踢下线 / 开通续期 |

**校对代码唯一定稿**：本目录 `proofread.py`。本机 `Word/editor/server.py` 离线兜底从此文件加载，**不要**再在 `editor/` 复制一份。

### 鉴权（S1）

- **用户短票**：`Authorization: Bearer <access_token>`（登录/注册获得）
- **过渡**：仍可接受长期 `RELAY_TOKEN`（`CONTROL_REQUIRE_USER=0` 时）
- **正式切流**：`CONTROL_REQUIRE_USER=1` → AI 接口只认用户短票；运维接口仍用 `RELAY_TOKEN`

细则：`Word/specs/2026-08-11-S1-接口与DDL.md`

### 环境变量（控制面）

| 变量 | 说明 |
|------|------|
| `CONTROL_ENABLED` | 默认 `1` |
| `CONTROL_REQUIRE_USER` | 默认 `0`；切流改 `1` |
| `CONTROL_DB` | 默认 `data/control.sqlite` |
| `CONTROL_SECRET` | access HMAC；务必与 `RELAY_TOKEN` 分离并保密 |
| `CONTROL_MAINTENANCE` | 非空则 AI 接口 503，文案即该值 |
| `CONTROL_REGISTER_MODE` | `open` / `invite` / `closed`（S5）；切 `invite` 后重启即可强制邀请码 |
| `RELAY_TOKEN` | 运维/过渡令牌 |

运维后台：`/admin`（令牌 + 用户/路由/内容/邀请码/组织）。

## 运维

```bash
# 在 mybox 内
cd /home/ubuntu/gongwen-relay
./start.sh          # 读 .env，写 settings.py，重启
tail -f logs/relay.log
```

本地冒烟：

```bash
python test_control_smoke.py
python test_control_http_smoke.py
```

本机编辑器：`settings.py` 中 `AI_USE_RELAY=True`，`AI_RELAY_BASE` 指向上述外网地址。

重新部署（控制面含 S1/S2）：

```powershell
cd Word\deploy
python deploy_s1_control.py
```

本地冒烟：`python test_control_*.py`（见本目录）。
