"""Бот в мессенджере MAX: /start с кнопкой приложения и уведомления.

Пользователи MAX живут в общей таблице users со сдвигом id (MAX_UID_OFFSET),
поэтому роли, остатки и расчёты общие с Telegram — приложение одно и то же.
Без MAX_BOT_TOKEN в .env ничего не запускается.
"""
import asyncio
import logging
import threading

import httpx

from . import config, db

log = logging.getLogger("maxbot")

COMMANDS = [
    {"name": "start", "description": "Что умеет бот"},
    {"name": "id", "description": "Мой ID"},
]

START_TEXT = (
    "Привет! Это приложение учёта товара и расчётов для торговли на ярмарках.\n\n"
    "Открой мини-приложение кнопкой ниже и зарегистрируйся (имя и фамилия)."
)


def _kb():
    if config.BASE_URL.startswith("https://"):
        return [{"type": "inline_keyboard", "payload": {"buttons": [[
            {"type": "link", "text": "🛒 Открыть приложение", "url": config.BASE_URL},
        ]]}}]
    return None


def send_sync(max_user_id, text):
    """Уведомление из API-обработчиков: в фоне, ошибки не роняют запрос."""
    if not config.MAX_BOT_TOKEN or not max_user_id:
        return

    def _go():
        try:
            body = {"text": text[:3900]}
            kb = _kb()
            if kb:
                body["attachments"] = kb
            httpx.post(config.MAX_API_BASE + "/messages",
                       params={"user_id": max_user_id}, json=body,
                       headers={"Authorization": config.MAX_BOT_TOKEN}, timeout=15)
        except Exception as e:
            log.warning("max notify %s failed: %s", max_user_id, e)

    threading.Thread(target=_go, daemon=True).start()


async def _api(client, method, path, params=None, body=None):
    r = await client.request(method, path, params=params, json=body)
    try:
        data = r.json()
    except Exception:
        data = {}
    if r.status_code >= 400:
        raise RuntimeError(f"{method} {path}: HTTP {r.status_code} {str(data)[:200]}")
    return data


async def _send(client, text, user_id=None, chat_id=None):
    params = {"chat_id": chat_id} if chat_id is not None else {"user_id": user_id}
    body = {"text": text[:3900]}
    kb = _kb()
    if kb:
        body["attachments"] = kb
    try:
        return await _api(client, "POST", "/messages", params=params, body=body)
    except Exception as e:
        log.warning("max send %s failed: %s", params, e)


async def send(max_user_id, text):
    """Асинхронная отправка для напоминаний (bot.reminders_loop)."""
    async with httpx.AsyncClient(
            base_url=config.MAX_API_BASE,
            headers={"Authorization": config.MAX_BOT_TOKEN}, timeout=30) as client:
        await _send(client, text, user_id=max_user_id)


# маркер long polling переживает рестарты — старые апдейты не обрабатываются дважды
def _marker_load():
    r = db.get().execute("SELECT v FROM settings WHERE k='max_marker'").fetchone()
    try:
        return int(r["v"]) if r else None
    except (TypeError, ValueError):
        return None


def _marker_save(m):
    conn = db.get()
    conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('max_marker', ?)", (str(m),))
    conn.commit()


async def _handle_update(client, u):
    t = u.get("update_type")
    if t == "bot_started":
        chat_id = u.get("chat_id")
        if chat_id is not None:
            await _send(client, START_TEXT, chat_id=chat_id)
        return
    if t != "message_created":
        return
    msg = u.get("message") or {}
    sender = msg.get("sender") or {}
    if sender.get("is_bot"):
        return
    chat_id = (msg.get("recipient") or {}).get("chat_id")
    text = ((msg.get("body") or {}).get("text") or "").strip()
    if chat_id is None or not text:
        return
    if text.startswith("/start") or text.startswith("/help"):
        await _send(client, START_TEXT, chat_id=chat_id)
    elif text.startswith("/id"):
        await _send(client, f"Твой MAX ID: {sender.get('user_id')}", chat_id=chat_id)
    else:
        # бот не должен молчать: на любой текст — подсказка и кнопка приложения
        await _send(client, "Я понимаю команды /start и /id, а вся работа — "
                            "в приложении по кнопке ниже.", chat_id=chat_id)


async def run():
    if not config.MAX_BOT_TOKEN:
        return
    client = httpx.AsyncClient(base_url=config.MAX_API_BASE,
                               headers={"Authorization": config.MAX_BOT_TOKEN}, timeout=45)
    try:
        me = await _api(client, "GET", "/me")
        log.info("MAX-бот online: %s", me.get("username") or me.get("name") or me)
    except Exception as e:
        log.error("MAX-бот не запустился: %s", e)
    try:
        await _api(client, "PATCH", "/me", body={"commands": COMMANDS})
    except Exception as e:
        log.warning("MAX set commands: %s", e)
    marker = _marker_load()
    while True:
        try:
            params = {"timeout": 30, "limit": 50}
            if marker is not None:
                params["marker"] = marker
            data = await _api(client, "GET", "/updates", params=params)
            for u in data.get("updates") or []:
                try:
                    await _handle_update(client, u)
                except Exception as e:
                    log.warning("max update failed: %s", e)
            if data.get("marker") is not None:
                marker = data["marker"]
                _marker_save(marker)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("max polling error: %s", e)
            await asyncio.sleep(5)
