import os

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

ROOT_DIR = os.path.dirname(os.path.dirname(CURRENT_DIR))

if os.environ.get("MIOBOT_MANAGED_CLOUD_PLUGINS") == "1":
    from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path
    TEMP_DIR = os.path.join(get_astrbot_plugin_data_path(), "astrbot_sowing_discord", "cache")
else:
    TEMP_DIR = os.path.join(ROOT_DIR, "sowing_discord_cache")

os.makedirs(TEMP_DIR, exist_ok=True)
WAITING_TIME = 600
