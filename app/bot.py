"""Телеграм-бот: /start с кнопкой мини-аппа и напоминания об инкассации в 20:00."""
import asyncio
import logging
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

from . import config, db, services

log = logging.getLogger("bot")


def send_sync(chat_id, text):
    """Уведомление из API-обработчиков: отправляем в фоне, ошибки не роняют запрос.

    Единая точка отправки: id со сдвигом MAX_UID_OFFSET уходят в мессенджер MAX,
    остальные — в Telegram."""
    if not chat_id or chat_id < 0:
        return  # отрицательные id — пользователи, заведённые вручную без мессенджера
    if chat_id >= config.MAX_UID_OFFSET:
        from . import max_bot
        max_bot.send_sync(chat_id - config.MAX_UID_OFFSET, text)
        return
    if not config.BOT_TOKEN:
        return

    def _go():
        try:
            httpx.post(
                f"https://api.telegram.org/bot{config.BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": text}, timeout=15,
            )
        except Exception as e:
            log.warning("notify %s failed: %s", chat_id, e)

    threading.Thread(target=_go, daemon=True).start()


def notify_user(u, text):
    """Уведомление объединённому пользователю: шлём в мессенджер, где он был
    последним; если там его нет — в тот, что есть."""
    if not u:
        return
    has_tg = 0 < (u.get("tg_id") or 0) < config.MAX_UID_OFFSET
    if u.get("max_id") and (u.get("last_platform") == "max" or not has_tg):
        from . import max_bot
        max_bot.send_sync(u["max_id"], text)
    elif has_tg:
        send_sync(u["tg_id"], text)

REMIND_TEXT = (
    "⏰ Не забудь про инкассацию за сегодня!\n\n"
    "Скинь чек в рабочий чат и внеси сумму терминала в приложении."
)


class Bot:
    def __init__(self, token):
        self.url = f"https://api.telegram.org/bot{token}/"
        self.client = httpx.AsyncClient(timeout=40)

    async def call(self, method, **params):
        r = await self.client.post(self.url + method, json=params)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"{method}: {data.get('description')}")
        return data["result"]

    async def send(self, chat_id, text, **kw):
        try:
            return await self.call("sendMessage", chat_id=chat_id, text=text, **kw)
        except Exception as e:
            log.warning("sendMessage to %s failed: %s", chat_id, e)


def _open_button():
    if config.BASE_URL.startswith("https://"):
        return {"inline_keyboard": [[
            {"text": "🛒 Открыть приложение", "web_app": {"url": config.BASE_URL}}
        ]]}
    return None


async def handle_update(bot, upd):
    msg = upd.get("message") or {}
    text = (msg.get("text") or "").strip()
    chat = msg.get("chat") or {}
    if chat.get("type") != "private" or not text:
        return
    chat_id = chat["id"]
    if text.startswith("/start"):
        kb = _open_button()
        await bot.send(
            chat_id,
            "Привет! Это приложение учёта товара и расчётов для торговли на ярмарках.\n\n"
            "Открой мини-приложение кнопкой ниже и зарегистрируйся (имя и фамилия).",
            reply_markup=kb,
        )
    elif text.startswith("/id"):
        await bot.send(chat_id, f"Твой Telegram ID: {chat_id}")
    else:
        # бот не должен молчать: на любой текст — подсказка и кнопка приложения
        await bot.send(chat_id, "Я понимаю команды /start и /id, а вся работа — "
                                "в приложении по кнопке ниже.",
                       reply_markup=_open_button())


async def polling_loop(bot):
    offset = None
    while True:
        try:
            updates = await bot.call("getUpdates", offset=offset, timeout=25,
                                     allowed_updates=["message"])
            for u in updates:
                offset = u["update_id"] + 1
                await handle_update(bot, u)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("polling error: %s", e)
            await asyncio.sleep(5)


async def reminders_loop(bot):
    """Каждую минуту: у кого товар на руках, время — REMIND_HOUR по его часам,
    а инкассации за сегодня нет — шлём напоминание (один раз в день)."""
    while True:
        try:
            conn = db.get()
            now = datetime.now(timezone.utc)
            for u in conn.execute(
                    "SELECT * FROM users WHERE active=1"
                    " AND (tg_id > 0 OR max_id IS NOT NULL)"):
                u = dict(u)
                try:
                    tz = ZoneInfo(u["tz"] or config.DEFAULT_TZ)
                except Exception:
                    tz = ZoneInfo(config.DEFAULT_TZ)
                local = now.astimezone(tz)
                ldate = local.strftime("%Y-%m-%d")
                if local.hour != config.REMIND_HOUR or local.minute >= 15:
                    continue
                if u["last_reminded"] == ldate:
                    continue
                if not services.hands_nonzero(conn, u["id"]):
                    continue
                if services.incass_exists(conn, u["id"], ldate):
                    services.mark_reminded(conn, u["id"], ldate)
                    continue
                has_tg = 0 < u["tg_id"] < config.MAX_UID_OFFSET
                if u["max_id"] and (u["last_platform"] == "max" or not has_tg):
                    from . import max_bot
                    await max_bot.send(u["max_id"], REMIND_TEXT)
                elif has_tg:
                    await bot.send(u["tg_id"], REMIND_TEXT, reply_markup=_open_button())
                else:
                    continue
                services.mark_reminded(conn, u["id"], ldate)
                log.info("reminder sent to %s", u["tg_id"])
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("reminders error: %s", e)
        await asyncio.sleep(60)


async def setup(bot):
    me = await bot.call("getMe")
    log.info("bot @%s online", me.get("username"))
    if config.BASE_URL.startswith("https://"):
        try:
            await bot.call("setChatMenuButton", menu_button={
                "type": "web_app", "text": "Приложение",
                "web_app": {"url": config.BASE_URL},
            })
        except Exception as e:
            log.warning("setChatMenuButton: %s", e)


async def run(bot):
    try:
        await setup(bot)
    except Exception as e:
        log.error("bot setup failed: %s", e)
    await asyncio.gather(polling_loop(bot), reminders_loop(bot))
