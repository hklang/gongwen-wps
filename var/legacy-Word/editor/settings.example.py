# 复制为 settings.py 后填写。settings.py 已加入 .gitignore。

# 默认提供商：minimax | deepseek
AI_PROVIDER = "minimax"

# —— MiniMax ——
MINIMAX_API_KEY = ""
MINIMAX_BASE_URL = "https://api.minimaxi.com/v1"
MINIMAX_MODEL = "MiniMax-M3"
MINIMAX_TIMEOUT = 90

# —— DeepSeek（OpenAI 兼容；勿填 …/anthropic，那是另一套协议）——
DEEPSEEK_API_KEY = ""
DEEPSEEK_BASE_URL = "https://api.deepseek.com"  # 或 https://api.deepseek.com/v1
DEEPSEEK_MODEL = "deepseek-v4-flash"  # deepseek-v4-flash | deepseek-v4-pro
DEEPSEEK_TIMEOUT = 90

# —— 云服务器模型中转（阶段 A；口令见 Word/deploy/server.local.md）——
AI_USE_RELAY = False
AI_RELAY_BASE = "http://49.233.190.103:8080/gongwen-relay"  # nginx→3000；勿用面板 15640
AI_RELAY_TOKEN = ""
