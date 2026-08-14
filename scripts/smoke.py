"""Смоук-тест бизнес-логики на примере из ТЗ. Запуск: python scripts/smoke.py"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")

from app import db, services  # noqa: E402


def eq(actual, expected, label):
    assert abs(actual - expected) < 0.01, f"{label}: ожидалось {expected}, получено {actual}"
    print(f"  OK {label} = {actual}")


conn = db.get()
st = services.settings_get(conn)
eq(st["share_pct"], 50, "доля по умолчанию")
eq(st["commission_pct"], 2, "комиссия по умолчанию")

admin = services.user_create(conn, 1, "Админ", "Главный", "boss", "Europe/Moscow", {1})
seller = services.user_create(conn, 2, "Иван", "Петров", "ivan", "Europe/Moscow", {1})
assert admin["role"] == "admin" and seller["role"] == "seller"

p = services.product_create(conn, "Сыр козий", "кг", 1000, 2000)

# Приход 100 кг
services.doc_prihod(conn, admin, "2026-08-10", [{"product_id": p["id"], "qty": 100}])
rep = services.stock_report(conn)
eq(rep["rows"][0]["qty"], 100, "склад после прихода")
eq(rep["totals"]["retail_value"], 200000, "склад в рознице")

# Выдача 50 кг = 100 000 ₽ по рознице -> долг 50 000
d = services.doc_vydacha(conn, admin, seller["id"], "2026-08-11",
                         [{"product_id": p["id"], "qty_wh": 50}], 50)
eq(d["amount"], 100000, "выдача на сумму")
eq(d["money"], 50000, "начислен долг")
bal = services.seller_balance(conn, seller["id"])
eq(bal["balance"], 50000, "баланс после выдачи")
eq(services.stock_report(conn)["rows"][0]["qty"], 50, "склад после выдачи")

# Инкассация 30 000 -> зачёт 29 400 (минус 2%)
services.doc_incass(conn, admin, seller["id"], "2026-08-12", 30000, 2)
bal = services.seller_balance(conn, seller["id"])
eq(bal["terminal_credit"], 29400, "зачтено по терминалу")
eq(bal["balance"], 20600, "баланс после инкассации")

# Сдача: 10 кг на склад, 5 кг на полку, 35 кг продано
d = services.doc_sdacha(conn, admin, seller["id"], "2026-08-13",
                        [{"product_id": p["id"], "qty_to_wh": 10, "qty_to_shelf": 5,
                          "qty_sold": 35}], 50)
eq(d["amount"], 70000, "продано на сумму")
eq(d["money"], -15000, "зачтено возвратом")
bal = services.seller_balance(conn, seller["id"])
eq(bal["balance"], 5600, "баланс после сдачи")
sk = services.seller_stock(conn, seller["id"])
assert not sk["hands"], "на руках пусто"
eq(sk["shelf"][0]["qty"], 5, "на полке")
eq(services.stock_report(conn)["rows"][0]["qty"], 60, "склад после сдачи")

# Переплата терминалом: ещё 10 000 -> мы должны продавцу 4 200
services.doc_incass(conn, admin, seller["id"], "2026-08-13", 10000, 2)
bal = services.seller_balance(conn, seller["id"])
eq(bal["balance"], -4200, "переплата (мы должны продавцу)")

# Наличный расчёт: мы отдали 4 200 -> ноль
services.doc_cash(conn, admin, seller["id"], "2026-08-13", -4200)
eq(services.seller_balance(conn, seller["id"])["balance"], 0, "расчёт закрыт")

# Выдача с полки: 5 кг по 2000 -> долг 5 000
d = services.doc_vydacha(conn, admin, seller["id"], "2026-08-14",
                         [{"product_id": p["id"], "qty_wh": 2, "qty_shelf": 5}], 50)
eq(d["money"], 7000, "долг при выдаче склад+полка")
sk = services.seller_stock(conn, seller["id"])
eq(sk["hands"][0]["qty"], 7, "на руках после выдачи с полки")
assert not sk["shelf"], "полка пуста"

# Инвентаризация: факт 57 кг (учёт 58) -> недостача 1 кг по закупу
d = services.doc_initial_or_inventory(conn, admin, "2026-08-14",
                                      [{"product_id": p["id"], "qty": 57}], "inventory")
eq(d["amount"], -1000, "недостача по закупу")
eq(services.stock_report(conn)["rows"][0]["qty"], 57, "склад после инвентаризации")

# Аналитика продаж
rep = services.sales_report(conn, "2026-08-01", "2026-08-31", 50)
eq(rep["sellers"][0]["sold_value"], 70000, "продажи за период")
eq(rep["sellers"][0]["sold_kg"], 35, "продано кг")
eq(rep["sellers"][0]["our_share"], 35000, "наша доля")
eq(rep["sellers"][0]["terminal_credit"], 39200, "терминал за период")

# Напоминания
assert services.hands_nonzero(conn, seller["id"])
assert services.incass_exists(conn, seller["id"], "2026-08-13")
assert not services.incass_exists(conn, seller["id"], "2026-08-14")

# Ошибки: нельзя выдать больше, чем есть
try:
    services.doc_vydacha(conn, admin, seller["id"], "2026-08-14",
                         [{"product_id": p["id"], "qty_wh": 999}], 50)
    raise SystemExit("ОШИБКА: выдача сверх остатка прошла")
except ValueError as e:
    print(f"  OK отказ: {e}")

print("\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ")
