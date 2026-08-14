"""HTTP API мини-приложения + раздача статики."""
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

import hashlib
import hmac as hmac_lib

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, bot, config, db, services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(_app):
    db.get()
    tasks = []
    if config.BOT_TOKEN:
        tasks.append(asyncio.create_task(bot.run(bot.Bot(config.BOT_TOKEN))))
    else:
        log.warning("BOT_TOKEN не задан — бот и напоминания выключены")
    if config.DEV_MODE:
        log.warning("DEV_MODE=1 — включён вход без Telegram (не для боевого сервера!)")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Ярмарка", lifespan=lifespan)


@app.exception_handler(ValueError)
async def value_error_handler(_req, exc):
    return JSONResponse({"error": str(exc)}, status_code=400)


def _err(code, msg):
    return HTTPException(code, detail={"error": msg})


def tg_identity(request: Request):
    """Личность Telegram из initData (или dev-заголовка в DEV_MODE)."""
    if config.DEV_MODE:
        dev = request.headers.get("X-Dev-User")
        if dev:
            try:
                did = int(dev)
            except ValueError:
                raise _err(401, "Некорректный X-Dev-User")
            return {"id": did, "first_name": f"Dev{did}", "username": f"dev{did}"}
    tg = auth.validate_init_data(request.headers.get("X-Tg-Init-Data", ""), config.BOT_TOKEN)
    if not tg:
        raise _err(401, "Откройте приложение через Telegram")
    return tg


def current_user(request: Request):
    tg = tg_identity(request)
    u = services.user_by_tg(db.get(), tg["id"])
    if u is None:
        raise HTTPException(401, detail={"need_registration": True})
    if not u["active"]:
        raise _err(403, "Доступ отключён. Обратитесь к администратору.")
    return u


def need_staff(u):
    if u["role"] not in ("keeper", "owner", "admin"):
        raise _err(403, "Нет доступа")


def need_admin(u):
    if u["role"] != "admin":
        raise _err(403, "Только для администратора")


def need_owner(u):
    # владельческие вещи: прибыль, расходы, наличные расчёты
    if u["role"] not in ("owner", "admin"):
        raise _err(403, "Только для владельцев")


def need_not_keeper(u):
    # точки и календарь мероприятий — для продавцов и админа
    if u["role"] == "keeper":
        raise _err(403, "Недоступно для кладовщика")


def user_tz(u):
    try:
        return ZoneInfo(u.get("tz") or config.DEFAULT_TZ)
    except Exception:
        return ZoneInfo(config.DEFAULT_TZ)


def doc_date(payload, u):
    d = (payload.get("date") or "").strip()
    return d if d else datetime.now(user_tz(u)).strftime("%Y-%m-%d")


# ---------- вход ----------

@app.post("/api/auth")
def api_auth(request: Request, payload: dict = Body(default={})):
    tg = tg_identity(request)
    conn = db.get()
    u = services.user_by_tg(conn, tg["id"])
    if u is None:
        return {"need_registration": True,
                "tg": {"first_name": tg.get("first_name", ""), "last_name": tg.get("last_name", "")}}
    if not u["active"]:
        raise _err(403, "Доступ отключён. Обратитесь к администратору.")
    services.user_touch(conn, u["id"], tg.get("username"), (payload.get("tz") or "").strip() or None)
    u = services.user_by_tg(conn, tg["id"])
    return {"user": u, "settings": services.settings_get(conn)}


@app.post("/api/register")
def api_register(request: Request, payload: dict = Body(...)):
    tg = tg_identity(request)
    conn = db.get()
    u = services.user_by_tg(conn, tg["id"])
    if u is None:
        u = services.user_create(
            conn, tg["id"], payload.get("first_name"), payload.get("last_name"),
            tg.get("username"), (payload.get("tz") or "").strip() or None, config.ADMIN_IDS,
        )
    return {"user": u, "settings": services.settings_get(conn)}


# ---------- продавец ----------

@app.get("/api/me/summary")
def api_me(request: Request):
    u = current_user(request)
    conn = db.get()
    return {
        "user": u,
        "stock": services.seller_stock(conn, u["id"]),
        "balance": services.seller_balance(conn, u["id"]),
        "docs": services.docs_list(conn, seller_id=u["id"], limit=30),
        "settings": services.settings_get(conn),
    }


# ---------- номенклатура и склад ----------

@app.get("/api/products")
def api_products(request: Request, all: int = 0):
    u = current_user(request)
    need_staff(u)
    return {"products": services.products_list(db.get(), include_archived=bool(all))}


@app.post("/api/products")
def api_product_create(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"product": services.product_create(
        db.get(), payload.get("name"), payload.get("unit", "кг"),
        payload.get("purchase_price", 0), payload.get("retail_price", 0),
        payload.get("group_name", ""))}


@app.put("/api/products/{pid}")
def api_product_update(pid: int, request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    fields = {k: payload[k] for k in ("name", "unit", "purchase_price", "retail_price",
                                      "archived", "group_name") if k in payload}
    return {"product": services.product_update(db.get(), pid, **fields)}


@app.delete("/api/products/{pid}")
def api_product_delete(pid: int, request: Request):
    u = current_user(request)
    need_staff(u)
    return services.product_delete(db.get(), pid)


@app.get("/api/suppliers")
def api_suppliers(request: Request):
    u = current_user(request)
    need_staff(u)
    return {"suppliers": services.suppliers_list(db.get())}


@app.post("/api/suppliers")
def api_supplier_create(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"supplier": services.supplier_create(db.get(), payload.get("name"))}


@app.put("/api/suppliers/{sid}")
def api_supplier_update(sid: int, request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"supplier": services.supplier_update(db.get(), sid, name=payload.get("name"),
                                                 archived=payload.get("archived"))}


@app.get("/api/stock")
def api_stock(request: Request):
    u = current_user(request)
    rep = services.stock_report(db.get())
    if u["role"] == "seller":
        # продавцам — только актуальные остатки в кг/шт, без цен и сумм
        return {
            "rows": [{"product_id": r["product_id"], "name": r["name"], "unit": r["unit"],
                      "qty": r["qty"], "group_name": ""} for r in rep["rows"]],
            "totals": {"kg": rep["totals"]["kg"], "pcs": rep["totals"]["pcs"]},
            "seller_view": True,
        }
    return rep


# ---------- продавцы (для персонала) ----------

@app.get("/api/sellers")
def api_sellers(request: Request):
    u = current_user(request)
    need_staff(u)
    return {"sellers": services.sellers_overview(db.get())}


@app.get("/api/sellers/{sid}")
def api_seller(sid: int, request: Request):
    u = current_user(request)
    need_staff(u)
    conn = db.get()
    s = services.user_by_id(conn, sid)
    if s is None:
        raise _err(404, "Продавец не найден")
    return {
        "seller": {"id": s["id"], "name": services.fio(s), "active": s["active"]},
        "stock": services.seller_stock(conn, sid),
        "balance": services.seller_balance(conn, sid),
        "docs": services.docs_list(conn, seller_id=sid, limit=30),
    }


# ---------- документы ----------

@app.post("/api/docs/prihod")
def api_prihod(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"doc": services.doc_prihod(db.get(), u, doc_date(payload, u),
                                       payload.get("lines"), payload.get("comment"),
                                       payload.get("supplier_id"))}


@app.post("/api/docs/initial")
def api_initial(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"doc": services.doc_initial_or_inventory(
        db.get(), u, doc_date(payload, u), payload.get("lines"), "initial", payload.get("comment"))}


@app.post("/api/docs/inventory")
def api_inventory(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    return {"doc": services.doc_initial_or_inventory(
        db.get(), u, doc_date(payload, u), payload.get("lines"), "inventory", payload.get("comment"))}


def _print_sig(doc_id):
    key = (config.BOT_TOKEN or "yarmarka-print").encode()
    return hmac_lib.new(key, f"print:{doc_id}".encode(), hashlib.sha256).hexdigest()[:16]


def _with_print(doc):
    if doc and doc.get("type") == "vydacha":
        doc["print_url"] = f"/print/{doc['id']}/{_print_sig(doc['id'])}"
    return doc


def _fq(x):
    return f"{round(float(x), 3):g}".replace(".", ",")


def _fm(x):
    return f"{round(float(x)):,}".replace(",", " ") + " ₽"


def _date_ru(d):
    return f"{d[8:10]}.{d[5:7]}.{d[0:4]}"


def _balance_text(bal):
    if bal > 0.005:
        return f"Итог: должен компании {_fm(bal)}"
    if bal < -0.005:
        return f"Итог: компания должна тебе {_fm(-bal)}"
    return "Итог: расчёт закрыт, долгов нет"


@app.post("/api/docs/vydacha")
def api_vydacha(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    conn = db.get()
    st = services.settings_get(conn)
    doc = _with_print(services.doc_vydacha(
        conn, u, payload.get("seller_id"), doc_date(payload, u),
        payload.get("lines"), st["share_pct"], payload.get("comment")))
    seller = services.user_by_id(conn, doc["seller_id"])
    if seller:
        lines_txt = "\n".join(
            f"{i + 1}. {ln['name']} — {_fq(ln['qty'])} {ln['unit']} × "
            f"{_fm(ln['retail_price'])} = {_fm(ln['qty'] * ln['retail_price'])}"
            for i, ln in enumerate(doc["lines"]))
        bal = services.seller_balance(conn, doc["seller_id"])["balance"]
        bot.send_sync(seller["tg_id"],
                      f"📦 Тебе выдан товар ({_date_ru(doc['date'])}):\n{lines_txt}\n\n"
                      f"Всего по ценам продажи: {_fm(doc['amount'])}\n"
                      f"Начислено за товар ({st['share_pct']:g}%): +{_fm(doc['money'])}\n"
                      f"{_balance_text(bal)}")
    return {"doc": doc}


@app.post("/api/docs/sdacha")
def api_sdacha(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    conn = db.get()
    st = services.settings_get(conn)
    doc = services.doc_sdacha(conn, u, payload.get("seller_id"), doc_date(payload, u),
                              payload.get("lines"), st["share_pct"], payload.get("comment"))
    seller = services.user_by_id(conn, doc["seller_id"])
    if seller:
        b = services.seller_balance(conn, doc["seller_id"])
        wh_val = sum(ln["qty_to_wh"] * ln["retail_price"] for ln in doc["lines"])
        shelf_val = sum(ln["qty_to_shelf"] * ln["retail_price"] for ln in doc["lines"])
        bot.send_sync(seller["tg_id"],
                      f"↩️ Товар принят ({_date_ru(doc['date'])}).\n"
                      f"Продано на {_fm(doc['amount'])}\n"
                      f"Возвращено на склад: {_fm(wh_val)}\n"
                      f"Убрано на твою полку: {_fm(shelf_val)}\n\n"
                      f"Всего взял товара на {_fm(b['taken_value'])}, "
                      f"продал на {_fm(b['sold_value'])}.\n"
                      f"Терминал: пробито {_fm(b['terminal_raw'])}, "
                      f"зачтено {_fm(b['terminal_credit'])}.\n"
                      f"{_balance_text(b['balance'])}")
    return {"doc": doc}


@app.post("/api/docs/incass")
def api_incass(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    conn = db.get()
    if u["role"] == "seller":
        seller_id = u["id"]
    else:
        seller_id = payload.get("seller_id") or u["id"]
    st = services.settings_get(conn)
    return {"doc": services.doc_incass(conn, u, seller_id, doc_date(payload, u),
                                       payload.get("amount"), st["commission_pct"],
                                       payload.get("comment"))}


@app.post("/api/docs/cash")
def api_cash(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_owner(u)
    return {"doc": services.doc_cash(db.get(), u, payload.get("seller_id"), doc_date(payload, u),
                                     payload.get("amount"), payload.get("comment"))}


@app.get("/api/docs")
def api_docs(request: Request, type: str = None, seller_id: int = None, limit: int = 100):
    u = current_user(request)
    if u["role"] == "seller":
        seller_id = u["id"]
    return {"docs": services.docs_list(db.get(), dtype=type, seller_id=seller_id, limit=limit)}


@app.get("/api/docs/{doc_id}")
def api_doc(doc_id: int, request: Request):
    u = current_user(request)
    doc = services.doc_get(db.get(), doc_id)
    if u["role"] == "seller" and doc["seller_id"] != u["id"]:
        raise _err(403, "Нет доступа")
    return {"doc": _with_print(doc)}


@app.get("/print/{doc_id}/{sig}", response_class=HTMLResponse)
def print_vydacha(doc_id: int, sig: str):
    """Печатная форма УПД по выдаче. Доступ по подписанной ссылке из приложения."""
    if not hmac_lib.compare_digest(sig, _print_sig(doc_id)):
        raise HTTPException(404)
    conn = db.get()
    doc = services.doc_get(conn, doc_id)
    if doc["type"] != "vydacha":
        raise HTTPException(404)
    st = services.settings_get(conn)

    def money(x):
        return f"{x:,.2f}".replace(",", " ").replace(".", ",")

    def qty(x):
        return f"{x:g}".replace(".", ",")

    rows = "".join(
        f"<tr><td>{i + 1}</td><td class='l'>{ln['name']}</td><td>{ln['unit']}</td>"
        f"<td>{qty(ln['qty'])}</td><td>{money(ln['retail_price'])}</td>"
        f"<td>{money(ln['qty'] * ln['retail_price'])}</td></tr>"
        for i, ln in enumerate(doc["lines"])
    )
    d = doc["date"]
    date_ru = f"{d[8:10]}.{d[5:7]}.{d[0:4]}"
    html = f"""<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>УПД №{doc['id']} от {date_ru}</title>
<style>
body{{font:14px/1.45 Arial,sans-serif;color:#000;max-width:800px;margin:24px auto;padding:0 16px}}
h1{{font-size:18px;margin:0 0 4px}} .sub{{color:#333;margin-bottom:16px}}
table{{width:100%;border-collapse:collapse;margin:14px 0}}
th,td{{border:1px solid #000;padding:6px 8px;text-align:center;font-size:13px}}
td.l{{text-align:left}} tfoot td{{font-weight:bold}}
.sig{{display:flex;justify-content:space-between;margin-top:40px;gap:30px}}
.sig div{{flex:1}} .sig .line{{border-bottom:1px solid #000;height:28px;margin-bottom:4px}}
.small{{font-size:12px;color:#333}}
.noprint{{margin:18px 0}} @media print{{.noprint{{display:none}}}}
button{{font-size:15px;padding:10px 22px;cursor:pointer}}
</style></head><body>
<div class="noprint"><button onclick="window.print()">🖨 Печать / сохранить в PDF</button></div>
<h1>Универсальный передаточный документ №{doc['id']} от {date_ru}</h1>
<div class="sub">Акт приёма-передачи товара на реализацию</div>
<p><b>Передал (кладовщик):</b> {doc['creator_name'] or ''}<br>
<b>Принял (продавец):</b> {doc['seller_name'] or ''}</p>
<table>
<thead><tr><th>№</th><th>Наименование товара</th><th>Ед.</th><th>Кол-во</th>
<th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
<tbody>{rows}</tbody>
<tfoot><tr><td colspan="5" class="l">Итого по ценам продажи</td>
<td>{money(doc['amount'])}</td></tr>
<tr><td colspan="5" class="l">К расчёту за товар ({st['share_pct']:g}%)</td>
<td>{money(doc['money'])}</td></tr></tfoot>
</table>
<p class="small">Товар передан под реализацию. Расчёт — {st['share_pct']:g}% от стоимости
проданного по ценам продажи; непроданный товар подлежит возврату.</p>
<div class="sig">
<div><div class="line"></div><div class="small">Передал: подпись, дата</div></div>
<div><div class="line"></div><div class="small">Получил: подпись, дата</div></div>
</div>
</body></html>"""
    return HTMLResponse(html)


# ---------- брони ----------

@app.get("/api/bookings")
def api_bookings(request: Request, kind: str, ref_id: int, all: int = 0):
    u = current_user(request)
    today = None if all else datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return {"bookings": services.bookings_list(db.get(), kind, ref_id, today=today)}


@app.post("/api/bookings")
def api_booking_create(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    return services.booking_create(
        db.get(), u, payload.get("kind"), payload.get("ref_id"), payload.get("user_id"),
        payload.get("date_from"), payload.get("date_to"), payload.get("comment"))


@app.delete("/api/bookings/{bid}")
def api_booking_delete(bid: int, request: Request):
    u = current_user(request)
    return services.booking_delete(db.get(), u, bid)


# ---------- аналитика ----------

@app.get("/api/analytics/sales")
def api_sales(request: Request, date_from: str = "", date_to: str = ""):
    u = current_user(request)
    need_staff(u)
    conn = db.get()
    st = services.settings_get(conn)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return services.sales_report(conn, date_from or "2000-01-01", date_to or today, st["share_pct"])


@app.get("/api/analytics/on_sellers")
def api_on_sellers(request: Request):
    u = current_user(request)
    need_staff(u)
    return {"sellers": services.on_sellers_report(db.get())}


# ---------- мероприятия и точки (доступно всем) ----------

@app.get("/api/places/meta")
def api_places_meta(request: Request):
    u = current_user(request)
    need_not_keeper(u)
    conn = db.get()
    return {"cities": services.places_cities(conn), "people": services.people_list(conn)}


@app.get("/api/events")
def api_events(request: Request, city: str = "", when: str = "upcoming"):
    u = current_user(request)
    need_not_keeper(u)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return {"events": services.events_list(db.get(), city=city or None, when=when, today=today)}


@app.post("/api/events")
def api_event_save(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_not_keeper(u)
    return {"event": services.event_save(
        db.get(), u, payload.get("id"), payload.get("name"), payload.get("etype"),
        payload.get("city"), payload.get("date_from"), payload.get("date_to"),
        payload.get("owner_user_id"), payload.get("comment"))}


@app.delete("/api/events/{eid}")
def api_event_delete(eid: int, request: Request):
    u = current_user(request)
    need_not_keeper(u)
    return services.event_delete(db.get(), u, eid)


@app.get("/api/points")
def api_points(request: Request, ptype: str = "", city: str = ""):
    u = current_user(request)
    need_not_keeper(u)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return {"points": services.points_list(db.get(), ptype=ptype or None, city=city or None,
                                           today=today)}


@app.post("/api/points")
def api_point_save(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_not_keeper(u)
    return {"point": services.point_save(
        db.get(), u, payload.get("id"), payload.get("name"), payload.get("ptype"),
        payload.get("city"), payload.get("address"), payload.get("owner_user_id"),
        payload.get("comment"), payload.get("phone"), payload.get("email"))}


@app.delete("/api/points/{pid}")
def api_point_delete(pid: int, request: Request):
    u = current_user(request)
    need_not_keeper(u)
    return services.point_delete(db.get(), u, pid)


@app.get("/api/analytics/turnover")
def api_turnover(request: Request, date_from: str = "", date_to: str = ""):
    """Обороты продавцов по розничным ценам — видно всем ролям."""
    u = current_user(request)
    conn = db.get()
    st = services.settings_get(conn)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    rep = services.sales_report(conn, date_from or "2000-01-01", date_to or today,
                                st["share_pct"])
    return {
        "sellers": [{"seller_id": s["seller_id"], "name": s["name"],
                     "sold_value": s["sold_value"], "sold_kg": s["sold_kg"]}
                    for s in rep["sellers"]],
        "total": rep["totals"]["sold_value"],
        "total_kg": rep["totals"]["sold_kg"],
    }


@app.get("/api/analytics/products")
def api_products_report(request: Request, date_from: str = "", date_to: str = ""):
    u = current_user(request)
    need_staff(u)
    conn = db.get()
    st = services.settings_get(conn)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    rep = services.products_report(conn, date_from or "2000-01-01", date_to or today,
                                   st["share_pct"])
    if u["role"] == "keeper":
        # деньги компании кладовщику не показываем
        for p in rep["products"]:
            p.pop("our_share", None)
            p.pop("profit", None)
            p.pop("cogs", None)
        rep["totals"].pop("profit", None)
    return rep


@app.get("/api/analytics/profit")
def api_profit(request: Request, date_from: str = "", date_to: str = ""):
    u = current_user(request)
    need_owner(u)
    conn = db.get()
    st = services.settings_get(conn)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return services.profit_report(conn, date_from or "2000-01-01", date_to or today,
                                  st["share_pct"])


# ---------- расходы ----------

@app.get("/api/expenses")
def api_expenses(request: Request, date_from: str = "", date_to: str = ""):
    u = current_user(request)
    need_owner(u)
    today = datetime.now(user_tz(u)).strftime("%Y-%m-%d")
    return services.expenses_list(db.get(), date_from or "2000-01-01", date_to or today)


@app.post("/api/expenses")
def api_expense_add(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_owner(u)
    return {"expense": services.expense_add(db.get(), u, doc_date(payload, u),
                                            payload.get("category"), payload.get("amount"),
                                            payload.get("comment"))}


@app.delete("/api/expenses/{eid}")
def api_expense_delete(eid: int, request: Request):
    u = current_user(request)
    need_owner(u)
    return services.expense_delete(db.get(), eid)


# ---------- администрирование ----------

@app.get("/api/users")
def api_users(request: Request):
    u = current_user(request)
    need_staff(u)
    return {"users": services.users_list(db.get())}


@app.put("/api/users/{uid}")
def api_user_update(uid: int, request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_staff(u)
    target = services.user_by_id(db.get(), uid)
    if target is None:
        raise _err(404, "Пользователь не найден")
    if u["role"] in ("keeper", "owner"):
        # кладовщик ведёт продавцов, но не трогает владельцев и не раздаёт их роли
        if target["role"] in ("admin", "owner") or payload.get("role") in ("admin", "owner"):
            raise _err(403, "Только администратор может управлять владельцами")
    if uid == u["id"] and (payload.get("role", u["role"]) != u["role"]
                          or payload.get("active", True) in (False, 0)):
        raise _err(400, "Нельзя понизить или отключить самого себя")
    return {"user": services.user_update(db.get(), uid, role=payload.get("role"),
                                         active=payload.get("active"))}


@app.get("/api/settings")
def api_settings(request: Request):
    u = current_user(request)
    need_staff(u)
    return {"settings": services.settings_get(db.get())}


@app.put("/api/settings")
def api_settings_put(request: Request, payload: dict = Body(...)):
    u = current_user(request)
    need_admin(u)
    return {"settings": services.settings_set(db.get(), payload.get("share_pct"),
                                              payload.get("commission_pct"))}


app.mount("/", StaticFiles(directory=str(config.WEBAPP_DIR), html=True), name="webapp")
