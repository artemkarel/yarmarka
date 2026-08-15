"""Проверка подписи initData мини-приложений: Telegram и MAX (алгоритм одинаковый)."""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

MAX_AGE = 3 * 86400  # initData не старше 3 суток


def validate_init_data(init_data, bot_token, max_age=MAX_AGE):
    """Возвращает dict пользователя Telegram или None, если подпись неверна."""
    if not init_data or not bot_token:
        return None
    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
    except ValueError:
        return None
    got_hash = data.pop("hash", None)
    if not got_hash:
        return None
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got_hash):
        return None
    if max_age:
        try:
            if time.time() - int(data.get("auth_date", 0)) > max_age:
                return None
        except ValueError:
            return None
    try:
        user = json.loads(data.get("user", "{}"))
    except json.JSONDecodeError:
        return None
    if not isinstance(user, dict) or not user.get("id"):
        return None
    return user


def validate_max_init_data(init_data, bot_token):
    """WebAppData мини-приложения MAX: HMAC-SHA256, secret = HMAC('WebAppData', токен)."""
    if not init_data or not bot_token:
        return None
    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
    except ValueError:
        return None
    got_hash = data.pop("hash", None)
    if not got_hash:
        return None
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got_hash):
        return None
    try:
        user = json.loads(data.get("user", "{}") or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(user, dict) or not user.get("id"):
        return None
    return user
