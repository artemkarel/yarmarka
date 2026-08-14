import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
BASE_URL = os.getenv("BASE_URL", "").strip().rstrip("/")
ADMIN_IDS = {int(x) for x in os.getenv("ADMIN_IDS", "").replace(" ", "").split(",") if x}
DEV_MODE = os.getenv("DEV_MODE", "0") == "1"
DEFAULT_TZ = os.getenv("DEFAULT_TZ", "Europe/Moscow")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8077"))
DB_PATH = Path(os.getenv("DB_PATH", str(ROOT / "data" / "yarmarka.db")))
REMIND_HOUR = int(os.getenv("REMIND_HOUR", "20"))
WEBAPP_DIR = ROOT / "webapp"
