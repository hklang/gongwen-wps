# 服务器上复制为 settings.py，或用环境变量覆盖（见 start.sh）

AI_PROVIDER = "deepseek"

MINIMAX_API_KEY = ""
MINIMAX_BASE_URL = "https://api.minimaxi.com/v1"
MINIMAX_MODEL = "MiniMax-M3"
MINIMAX_TIMEOUT = 90

DEEPSEEK_API_KEY = ""
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-v4-flash"
DEEPSEEK_TIMEOUT = 90

# 中转自身不走再中转
AI_USE_RELAY = False
