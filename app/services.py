"""Бизнес-логика: номенклатура, склад, выдача/сдача товара, деньги, аналитика.

Денежная модель (docs.money — влияние на долг продавца, со знаком):
  выдача:       +доля% × розничная стоимость выданного (со склада и с полки)
  сдача:        −доля% × розничная стоимость возвращённого (на склад и на полку)
  инкассация:   −(сумма терминала × (1 − комиссия%))
  наличные:     −сумма (плюсовая сумма = продавец отдал нам)
Баланс продавца = Σ money. Больше нуля — должен нам, меньше — мы ему.
"""
import threading
from datetime import datetime, timezone

from . import config, db

EPS = 1e-6
ROLES = ("seller", "keeper", "owner", "admin")
UNITS = ("кг", "шт")

_lock = threading.RLock()


def r2(x):
    return round(float(x) + 1e-9, 2)


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _num(v, name, allow_zero=False, allow_negative=False):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"Некорректное число: {name}")
    if x != x or abs(x) > 1e9:
        raise ValueError(f"Некорректное число: {name}")
    if not allow_negative and x < -EPS:
        raise ValueError(f"{name}: не может быть отрицательным")
    if not allow_zero and abs(x) < EPS:
        raise ValueError(f"{name}: укажите значение больше нуля")
    return x


# ---------- настройки ----------

def settings_get(conn):
    s = {r["k"]: r["v"] for r in conn.execute("SELECT k, v FROM settings")}
    return {
        "share_pct": float(s.get("share_pct", 50)),
        "commission_pct": float(s.get("commission_pct", 2)),
    }


def settings_set(conn, share_pct, commission_pct):
    share = _num(share_pct, "Доля, %", allow_zero=True)
    comm = _num(commission_pct, "Комиссия, %", allow_zero=True)
    if share > 100 or comm > 100:
        raise ValueError("Процент не может быть больше 100")
    with _lock, conn:
        conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('share_pct', ?)", (str(share),))
        conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('commission_pct', ?)", (str(comm),))
    return settings_get(conn)


# ---------- пользователи ----------

def user_by_tg(conn, tg_id):
    r = conn.execute("SELECT * FROM users WHERE tg_id=?", (tg_id,)).fetchone()
    return dict(r) if r else None


def user_by_id(conn, uid):
    r = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return dict(r) if r else None


def user_create(conn, tg_id, first_name, last_name, username, tz, admin_ids):
    first_name = (first_name or "").strip()
    last_name = (last_name or "").strip()
    if not first_name or not last_name:
        raise ValueError("Укажите имя и фамилию")
    if len(first_name) > 50 or len(last_name) > 50:
        raise ValueError("Слишком длинное имя")
    with _lock, conn:
        count = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
        role = "admin" if (tg_id in admin_ids or count == 0) else "seller"
        conn.execute(
            "INSERT INTO users(tg_id, username, first_name, last_name, role, tz, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (tg_id, username, first_name, last_name, role, tz, now_utc()),
        )
    return user_by_tg(conn, tg_id)


def user_touch(conn, uid, username, tz):
    seen = datetime.now(timezone.utc).isoformat()
    with _lock, conn:
        if tz:
            conn.execute("UPDATE users SET username=?, tz=?, last_seen=? WHERE id=?",
                         (username, tz, seen, uid))
        else:
            conn.execute("UPDATE users SET username=?, last_seen=? WHERE id=?",
                         (username, seen, uid))


def users_list(conn):
    rows = [dict(r) for r in conn.execute("SELECT * FROM users ORDER BY role, first_name")]
    for r in rows:
        r["platform"] = ("MAX" if r["tg_id"] >= config.MAX_UID_OFFSET
                         else "TG" if r["tg_id"] > 0 else "")
    return rows


def adopt_manual(conn, tg_user):
    """Привязка реального Telegram-аккаунта к заранее заведённому по нику."""
    uname = (tg_user.get("username") or "").strip().lstrip("@")
    if not uname:
        return None
    r = conn.execute(
        "SELECT id FROM users WHERE tg_id < 0 AND lower(username)=lower(?)", (uname,)
    ).fetchone()
    if r is None:
        return None
    with _lock, conn:
        conn.execute("UPDATE users SET tg_id=?, username=? WHERE id=?",
                     (tg_user["id"], tg_user.get("username"), r["id"]))
    return user_by_id(conn, r["id"])


def user_create_manual(conn, first_name, last_name, role, tg_id=None, username=None):
    """Ручное создание пользователя админом/кладовщиком.

    Если Telegram ID известен — человек при первом входе сразу попадёт в свой
    аккаунт без регистрации. Без ID создаётся внутренний аккаунт (отрицательный
    tg_id): выдачи и балансы работают, уведомления — нет.
    """
    first_name = (first_name or "").strip()
    last_name = (last_name or "").strip()
    if not first_name or not last_name:
        raise ValueError("Укажите имя и фамилию")
    if role not in ROLES:
        raise ValueError("Неизвестная роль")
    if tg_id not in (None, ""):
        try:
            tg_id = int(str(tg_id).strip())
        except ValueError:
            raise ValueError("Telegram ID — это число (команда /id у бота)")
        if tg_id <= 0:
            raise ValueError("Telegram ID должен быть положительным числом")
    else:
        tg_id = -int(datetime.now(timezone.utc).timestamp() * 1000)
    username = (username or "").strip().lstrip("@") or None
    with _lock, conn:
        if conn.execute("SELECT 1 FROM users WHERE tg_id=?", (tg_id,)).fetchone():
            raise ValueError("Пользователь с таким Telegram ID уже есть")
        if username and conn.execute(
                "SELECT 1 FROM users WHERE lower(username)=lower(?)", (username,)).fetchone():
            raise ValueError("Пользователь с таким ником уже есть")
        conn.execute(
            "INSERT INTO users(tg_id, username, first_name, last_name, role, tz, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (tg_id, username, first_name, last_name, role, None, now_utc()),
        )
    return user_by_tg(conn, tg_id)


def user_update(conn, uid, role=None, active=None):
    if user_by_id(conn, uid) is None:
        raise ValueError("Пользователь не найден")
    with _lock, conn:
        if role is not None:
            if role not in ROLES:
                raise ValueError("Неизвестная роль")
            conn.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
        if active is not None:
            conn.execute("UPDATE users SET active=? WHERE id=?", (1 if active else 0, uid))
    return user_by_id(conn, uid)


def fio(u):
    return f"{u['first_name']} {u['last_name']}".strip()


# ---------- номенклатура ----------

def _product(conn, pid):
    r = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
    if r is None:
        raise ValueError("Товар не найден")
    return dict(r)


def _norm_group(g):
    g = (g or "").strip()
    return (g[:1].upper() + g[1:].lower()) if g else ""


def _ensure_group(conn, g):
    """Новая группа попадает в конец списка порядка."""
    if not g:
        return
    if conn.execute("SELECT 1 FROM product_groups WHERE name=?", (g,)).fetchone() is None:
        mx = conn.execute("SELECT COALESCE(MAX(sort), -1) m FROM product_groups").fetchone()["m"]
        conn.execute("INSERT INTO product_groups(name, sort) VALUES(?,?)", (g, mx + 1))


GROUP_ORDER_SQL = (" ORDER BY CASE WHEN p.group_name='' THEN 1 ELSE 0 END, "
                   "COALESCE(g.sort, 9999), p.group_name, p.name")


def groups_list(conn):
    return [{"name": r["name"], "sort": r["sort"]} for r in conn.execute(
        "SELECT name, sort FROM product_groups ORDER BY sort, name")]


def groups_set_order(conn, names):
    """Полный список имён в новом порядке."""
    with _lock, conn:
        for i, n in enumerate(names):
            conn.execute("UPDATE product_groups SET sort=? WHERE name=?", (i, str(n)))
    return groups_list(conn)


def products_list(conn, include_archived=False):
    q = ("SELECT p.*, COALESCE(s.qty, 0) AS stock_qty FROM products p "
         "LEFT JOIN stock s ON s.product_id = p.id "
         "LEFT JOIN product_groups g ON g.name = p.group_name")
    if not include_archived:
        q += " WHERE p.archived = 0"
    q += GROUP_ORDER_SQL
    return [dict(r) for r in conn.execute(q)]


def product_create(conn, name, unit, purchase_price, retail_price, group_name=""):
    name = (name or "").strip()
    if not name:
        raise ValueError("Укажите название товара")
    if unit not in UNITS:
        raise ValueError("Единица измерения: кг или шт")
    pp = _num(purchase_price, "Закупочная цена", allow_zero=True)
    rp = _num(retail_price, "Розничная цена", allow_zero=True)
    with _lock, conn:
        dup = conn.execute("SELECT id FROM products WHERE lower(name)=lower(?)", (name,)).fetchone()
        if dup:
            raise ValueError("Товар с таким названием уже есть")
        grp = _norm_group(group_name)
        _ensure_group(conn, grp)
        cur = conn.execute(
            "INSERT INTO products(name, group_name, unit, purchase_price, retail_price) VALUES(?,?,?,?,?)",
            (name, grp, unit, pp, rp),
        )
        conn.execute("INSERT OR IGNORE INTO stock(product_id, qty) VALUES(?, 0)", (cur.lastrowid,))
    return _product(conn, cur.lastrowid)


def product_delete(conn, pid):
    """Полное удаление, только если товар нигде не использовался."""
    p = _product(conn, pid)
    used = conn.execute("SELECT 1 FROM doc_lines WHERE product_id=? LIMIT 1", (pid,)).fetchone()
    has_qty = (_stock_qty(conn, pid) > EPS or conn.execute(
        "SELECT 1 FROM seller_stock WHERE product_id=? AND (qty_hands > ? OR qty_shelf > ?) LIMIT 1",
        (pid, EPS, EPS)).fetchone())
    if used or has_qty:
        raise ValueError(f"«{p['name']}» уже участвует в документах или есть остаток — "
                         "такой товар можно только архивировать")
    with _lock, conn:
        conn.execute("DELETE FROM products WHERE id=?", (pid,))
        conn.execute("DELETE FROM stock WHERE product_id=?", (pid,))
        conn.execute("DELETE FROM seller_stock WHERE product_id=?", (pid,))
    return {"deleted": True}


def product_update(conn, pid, name=None, unit=None, purchase_price=None, retail_price=None,
                   archived=None, group_name=None):
    _product(conn, pid)
    with _lock, conn:
        if name is not None:
            name = name.strip()
            if not name:
                raise ValueError("Укажите название товара")
            dup = conn.execute(
                "SELECT id FROM products WHERE lower(name)=lower(?) AND id<>?", (name, pid)
            ).fetchone()
            if dup:
                raise ValueError("Товар с таким названием уже есть")
            conn.execute("UPDATE products SET name=? WHERE id=?", (name, pid))
        if unit is not None:
            if unit not in UNITS:
                raise ValueError("Единица измерения: кг или шт")
            conn.execute("UPDATE products SET unit=? WHERE id=?", (unit, pid))
        if purchase_price is not None:
            conn.execute("UPDATE products SET purchase_price=? WHERE id=?",
                         (_num(purchase_price, "Закупочная цена", allow_zero=True), pid))
        if retail_price is not None:
            conn.execute("UPDATE products SET retail_price=? WHERE id=?",
                         (_num(retail_price, "Розничная цена", allow_zero=True), pid))
        if archived is not None:
            conn.execute("UPDATE products SET archived=? WHERE id=?", (1 if archived else 0, pid))
        if group_name is not None:
            grp = _norm_group(group_name)
            _ensure_group(conn, grp)
            conn.execute("UPDATE products SET group_name=? WHERE id=?", (grp, pid))
    return _product(conn, pid)


# ---------- поставщики ----------

def suppliers_list(conn, include_archived=False):
    q = "SELECT * FROM suppliers"
    if not include_archived:
        q += " WHERE archived=0"
    return [dict(r) for r in conn.execute(q + " ORDER BY name")]


def supplier_create(conn, name):
    name = (name or "").strip()
    if not name:
        raise ValueError("Укажите название поставщика")
    with _lock, conn:
        dup = conn.execute("SELECT id FROM suppliers WHERE lower(name)=lower(?)", (name,)).fetchone()
        if dup:
            raise ValueError("Такой поставщик уже есть")
        cur = conn.execute("INSERT INTO suppliers(name) VALUES(?)", (name,))
    return {"id": cur.lastrowid, "name": name, "archived": 0}


def supplier_update(conn, sid, name=None, archived=None):
    r = conn.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone()
    if r is None:
        raise ValueError("Поставщик не найден")
    with _lock, conn:
        if name is not None:
            name = name.strip()
            if not name:
                raise ValueError("Укажите название поставщика")
            conn.execute("UPDATE suppliers SET name=? WHERE id=?", (name, sid))
        if archived is not None:
            conn.execute("UPDATE suppliers SET archived=? WHERE id=?", (1 if archived else 0, sid))
    return dict(conn.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone())


# ---------- остатки ----------

def _stock_qty(conn, pid):
    r = conn.execute("SELECT qty FROM stock WHERE product_id=?", (pid,)).fetchone()
    return float(r["qty"]) if r else 0.0


def _stock_set(conn, pid, qty):
    if qty < -EPS:
        raise ValueError("Остаток на складе не может стать отрицательным")
    conn.execute(
        "INSERT INTO stock(product_id, qty) VALUES(?,?) "
        "ON CONFLICT(product_id) DO UPDATE SET qty=excluded.qty",
        (pid, max(qty, 0.0)),
    )


def _sstock(conn, seller_id, pid):
    r = conn.execute(
        "SELECT qty_hands, qty_shelf FROM seller_stock WHERE seller_id=? AND product_id=?",
        (seller_id, pid),
    ).fetchone()
    return (float(r["qty_hands"]), float(r["qty_shelf"])) if r else (0.0, 0.0)


def _sstock_set(conn, seller_id, pid, hands, shelf):
    if hands < -EPS or shelf < -EPS:
        raise ValueError("Остаток у продавца не может стать отрицательным")
    conn.execute(
        "INSERT INTO seller_stock(seller_id, product_id, qty_hands, qty_shelf) VALUES(?,?,?,?) "
        "ON CONFLICT(seller_id, product_id) DO UPDATE SET qty_hands=excluded.qty_hands, "
        "qty_shelf=excluded.qty_shelf",
        (seller_id, pid, max(hands, 0.0), max(shelf, 0.0)),
    )


def seller_stock(conn, seller_id):
    """Товар у продавца: на руках и на полке, с ценами."""
    rows = conn.execute(
        "SELECT ss.product_id, ss.qty_hands, ss.qty_shelf, p.name, p.unit, p.retail_price "
        "FROM seller_stock ss JOIN products p ON p.id = ss.product_id "
        "WHERE ss.seller_id=? AND (ss.qty_hands > ? OR ss.qty_shelf > ?) ORDER BY p.name",
        (seller_id, EPS, EPS),
    ).fetchall()
    hands, shelf = [], []
    for r in rows:
        base = {"product_id": r["product_id"], "name": r["name"], "unit": r["unit"],
                "retail_price": r["retail_price"]}
        if r["qty_hands"] > EPS:
            hands.append({**base, "qty": r["qty_hands"], "value": r2(r["qty_hands"] * r["retail_price"])})
        if r["qty_shelf"] > EPS:
            shelf.append({**base, "qty": r["qty_shelf"], "value": r2(r["qty_shelf"] * r["retail_price"])})
    return {
        "hands": hands,
        "shelf": shelf,
        "hands_value": r2(sum(x["value"] for x in hands)),
        "shelf_value": r2(sum(x["value"] for x in shelf)),
    }


# ---------- документы ----------

def _date_ok(date):
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except (TypeError, ValueError):
        raise ValueError("Некорректная дата")
    return date


def _doc_insert(conn, dtype, date, created_by, seller_id=None, amount=0.0, money=0.0,
                comment=None, supplier_id=None, status="draft", parent_id=None):
    cur = conn.execute(
        "INSERT INTO docs(type, ts, date, seller_id, supplier_id, created_by, amount, money, "
        "comment, status, parent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (dtype, now_utc(), date, seller_id, supplier_id, created_by, r2(amount), r2(money),
         comment or None, status, parent_id),
    )
    return cur.lastrowid


def _line_insert(conn, doc_id, p, **f):
    conn.execute(
        "INSERT INTO doc_lines(doc_id, product_id, qty, qty_shelf, qty_to_wh, qty_to_shelf, "
        "qty_sold, qty_before, purchase_price, retail_price) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (doc_id, p["id"], f.get("qty", 0), f.get("qty_shelf", 0), f.get("qty_to_wh", 0),
         f.get("qty_to_shelf", 0), f.get("qty_sold", 0), f.get("qty_before"),
         f.get("purchase_price", p["purchase_price"]), p["retail_price"]),
    )


def _need_lines(lines):
    if not lines or not isinstance(lines, list):
        raise ValueError("Добавьте хотя бы одну позицию")


def _seller_checked(conn, seller_id):
    u = user_by_id(conn, seller_id)
    if u is None or not u["active"]:
        raise ValueError("Продавец не найден")
    return u


# ---------- FIFO-партии ----------

def _fifo_out(conn, doc_id, pid, qty, name):
    """Списывает qty со склада по FIFO. Возвращает полную себестоимость списанного."""
    need = qty
    cost = 0.0
    for lot in conn.execute(
        "SELECT id, qty_left, unit_cost FROM lots WHERE product_id=? AND qty_left > ? "
        "ORDER BY id", (pid, EPS),
    ).fetchall():
        if need <= EPS:
            break
        take = min(need, lot["qty_left"])
        conn.execute("UPDATE lots SET qty_left = qty_left - ? WHERE id=?", (take, lot["id"]))
        conn.execute(
            "INSERT INTO lot_moves(doc_id, lot_id, product_id, qty, unit_cost) VALUES(?,?,?,?,?)",
            (doc_id, lot["id"], pid, take, lot["unit_cost"]))
        cost += take * lot["unit_cost"]
        need -= take
    if need > EPS:
        raise ValueError(f"{name}: в партиях не хватает {need:g} — проверьте остатки")
    return cost


def _fifo_in(conn, doc_id, pid, qty, unit_cost):
    """Создаёт новую партию (поступление, возврат, оприходование)."""
    cur = conn.execute(
        "INSERT INTO lots(product_id, qty_left, unit_cost, src_doc_id, created_at) "
        "VALUES(?,?,?,?,?)", (pid, qty, unit_cost, doc_id, now_utc()))
    return cur.lastrowid


def _last_cost(conn, pid, fallback):
    r = conn.execute(
        "SELECT unit_cost FROM lots WHERE product_id=? ORDER BY id DESC LIMIT 1", (pid,)
    ).fetchone()
    return float(r["unit_cost"]) if r else fallback


def _fifo_reverse(conn, doc_id):
    """Сторно партионных движений документа: списания возвращаются в те же партии,
    созданные документом партии удаляются (если их ещё не расходовали)."""
    for m in conn.execute("SELECT * FROM lot_moves WHERE doc_id=?", (doc_id,)).fetchall():
        conn.execute("UPDATE lots SET qty_left = qty_left + ? WHERE id=?",
                     (m["qty"], m["lot_id"]))
    conn.execute("DELETE FROM lot_moves WHERE doc_id=?", (doc_id,))
    for lot in conn.execute("SELECT * FROM lots WHERE src_doc_id=?", (doc_id,)).fetchall():
        used = conn.execute(
            "SELECT COALESCE(SUM(qty),0) q FROM lot_moves WHERE lot_id=?", (lot["id"],)
        ).fetchone()["q"]
        if used > EPS:
            raise ValueError("Нельзя отменить: товар из этого документа уже расходовался дальше")
        conn.execute("DELETE FROM lots WHERE id=?", (lot["id"],))


def _seller_avg(conn, seller_id, pid):
    r = conn.execute(
        "SELECT avg_cost FROM seller_stock WHERE seller_id=? AND product_id=?",
        (seller_id, pid)).fetchone()
    return float(r["avg_cost"]) if r else 0.0


def _seller_avg_set(conn, seller_id, pid, avg):
    conn.execute("UPDATE seller_stock SET avg_cost=? WHERE seller_id=? AND product_id=?",
                 (max(avg, 0.0), seller_id, pid))


# ---------- создание документов (по умолчанию черновик не проводится сам) ----------

def doc_prihod(conn, user, date, lines, comment=None, supplier_id=None, post=True):
    """Поступление товара на склад: каждая строка при проведении станет FIFO-партией."""
    _date_ok(date)
    _need_lines(lines)
    if supplier_id:
        if conn.execute("SELECT 1 FROM suppliers WHERE id=?", (supplier_id,)).fetchone() is None:
            raise ValueError("Поставщик не найден")
    else:
        supplier_id = None
    with _lock, conn:
        total = 0.0
        doc_id = _doc_insert(conn, "prihod", date, user["id"], comment=comment,
                             supplier_id=supplier_id)
        for ln in lines:
            p = _product(conn, ln.get("product_id"))
            qty = _num(ln.get("qty"), p["name"])
            pp = p["purchase_price"]
            if ln.get("purchase_price") is not None:
                pp = _num(ln.get("purchase_price"), f"Себестоимость: {p['name']}",
                          allow_zero=True)
            _line_insert(conn, doc_id, p, qty=qty, purchase_price=pp)
            total += qty * p["retail_price"]
        conn.execute("UPDATE docs SET amount=? WHERE id=?", (r2(total), doc_id))
    if post:
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def doc_initial_or_inventory(conn, user, date, lines, kind, comment=None):
    """initial — начальные остатки (проводятся сразу).
    inventory — инвентаризационная ведомость (черновик; проведение создаст
    списание и оприходование)."""
    if kind not in ("initial", "inventory"):
        raise ValueError("Неизвестный тип документа")
    _date_ok(date)
    with _lock, conn:
        doc_id = _doc_insert(conn, kind, date, user["id"], comment=comment)
        for ln in (lines or []):
            p = _product(conn, ln.get("product_id"))
            fact = _num(ln.get("qty"), p["name"], allow_zero=True)
            _line_insert(conn, doc_id, p, qty=fact, qty_before=_stock_qty(conn, p["id"]))
    if kind == "initial":
        _need_lines(lines)
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def inventory_set_lines(conn, user, doc_id, lines):
    """Подсчёт по ведомости: сохраняем/обновляем фактические количества (черновик)."""
    d = doc_get(conn, doc_id)
    if d["type"] != "inventory" or d["status"] != "draft":
        raise ValueError("Подсчёт можно вносить только в черновик ведомости")
    with _lock, conn:
        for ln in (lines or []):
            p = _product(conn, ln.get("product_id"))
            fact = _num(ln.get("qty"), p["name"], allow_zero=True)
            row = conn.execute(
                "SELECT id FROM doc_lines WHERE doc_id=? AND product_id=?",
                (doc_id, p["id"])).fetchone()
            if row:
                conn.execute("UPDATE doc_lines SET qty=? WHERE id=?", (fact, row["id"]))
            else:
                _line_insert(conn, doc_id, p, qty=fact, qty_before=_stock_qty(conn, p["id"]))
    return doc_get(conn, doc_id)


def doc_vydacha(conn, user, seller_id, date, lines, share_pct, comment=None, post=True):
    """Выдача товара продавцу под реализацию (со склада и/или с его полки)."""
    _date_ok(date)
    _need_lines(lines)
    _seller_checked(conn, seller_id)
    with _lock, conn:
        doc_id = _doc_insert(conn, "vydacha", date, user["id"], seller_id=seller_id,
                             comment=comment)
        total = 0.0
        for ln in lines:
            p = _product(conn, ln.get("product_id"))
            q_wh = _num(ln.get("qty_wh", 0), p["name"], allow_zero=True)
            q_shelf = _num(ln.get("qty_shelf", 0), p["name"], allow_zero=True)
            qty = q_wh + q_shelf
            if qty < EPS:
                raise ValueError(f"{p['name']}: укажите количество")
            if p["retail_price"] < EPS:
                raise ValueError(f"{p['name']}: не задана цена продажи — "
                                 "заполните её в номенклатуре перед выдачей")
            _line_insert(conn, doc_id, p, qty=qty, qty_shelf=q_shelf)
            total += qty * p["retail_price"]
        money = total * share_pct / 100.0
        conn.execute("UPDATE docs SET amount=?, money=? WHERE id=?",
                     (r2(total), r2(money), doc_id))
    if post:
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def doc_sdacha(conn, user, seller_id, date, lines, share_pct, comment=None, post=True):
    """Сдача (приём) товара продавцом: на склад / на полку; остальное — продано."""
    _date_ok(date)
    _need_lines(lines)
    _seller_checked(conn, seller_id)
    with _lock, conn:
        doc_id = _doc_insert(conn, "sdacha", date, user["id"], seller_id=seller_id,
                             comment=comment)
        sold_total = 0.0
        returned_total = 0.0
        for ln in lines:
            p = _product(conn, ln.get("product_id"))
            to_wh = _num(ln.get("qty_to_wh", 0), p["name"], allow_zero=True)
            to_shelf = _num(ln.get("qty_to_shelf", 0), p["name"], allow_zero=True)
            sold = _num(ln.get("qty_sold", 0), p["name"], allow_zero=True)
            qty = to_wh + to_shelf + sold
            if qty < EPS:
                continue
            _line_insert(conn, doc_id, p, qty=qty, qty_to_wh=to_wh, qty_to_shelf=to_shelf,
                         qty_sold=sold)
            sold_total += sold * p["retail_price"]
            returned_total += (to_wh + to_shelf) * p["retail_price"]
        money = -returned_total * share_pct / 100.0
        conn.execute("UPDATE docs SET amount=?, money=? WHERE id=?",
                     (r2(sold_total), r2(money), doc_id))
    if post:
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def doc_incass(conn, user, seller_id, date, amount, commission_pct, comment=None, post=True):
    """Инкассация: сумма терминала за день, к зачёту минус комиссия."""
    _date_ok(date)
    _seller_checked(conn, seller_id)
    amt = _num(amount, "Сумма терминала")
    credited = r2(amt * (100.0 - commission_pct) / 100.0)
    with _lock, conn:
        doc_id = _doc_insert(conn, "incass", date, user["id"], seller_id=seller_id,
                             amount=amt, money=-credited, comment=comment)
    if post:
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def doc_cash(conn, user, seller_id, date, amount, comment=None, post=True):
    """Наличный расчёт: amount > 0 — продавец отдал нам, < 0 — мы отдали продавцу."""
    _date_ok(date)
    _seller_checked(conn, seller_id)
    amt = _num(amount, "Сумма", allow_negative=True)
    with _lock, conn:
        doc_id = _doc_insert(conn, "cash", date, user["id"], seller_id=seller_id,
                             amount=amt, money=-amt, comment=comment)
    if post:
        post_doc(conn, user, doc_id)
    return doc_get(conn, doc_id)


def doc_transfer(conn, user, from_id, to_id, date, lines, share_pct, comment=None):
    """Передача товара между сотрудниками: пара связанных документов «отдал/принял».
    Долг за товар переезжает вместе с товаром, себестоимость — по средней отправителя."""
    _date_ok(date)
    _need_lines(lines)
    if int(from_id or 0) == int(to_id or 0):
        raise ValueError("Выберите двух разных сотрудников")
    _seller_checked(conn, from_id)
    _seller_checked(conn, to_id)
    with _lock, conn:
        out_id = _doc_insert(conn, "transfer_out", date, user["id"], seller_id=from_id,
                             comment=comment, status="posted")
        in_id = _doc_insert(conn, "transfer_in", date, user["id"], seller_id=to_id,
                            comment=comment, status="posted", parent_id=out_id)
        total = 0.0
        for ln in lines:
            p = _product(conn, ln.get("product_id"))
            qty = _num(ln.get("qty"), p["name"])
            hands_f, shelf_f = _sstock(conn, from_id, p["id"])
            if qty > hands_f + EPS:
                raise ValueError(f"{p['name']}: у отправителя на руках только {hands_f:g} "
                                 f"{p['unit']}")
            avg_f = _seller_avg(conn, from_id, p["id"])
            hands_t, shelf_t = _sstock(conn, to_id, p["id"])
            avg_t = _seller_avg(conn, to_id, p["id"])
            base_t = hands_t + shelf_t
            new_avg_t = ((base_t * avg_t + qty * avg_f) / (base_t + qty)
                         if (base_t + qty) > EPS else avg_f)
            _sstock_set(conn, from_id, p["id"], hands_f - qty, shelf_f)
            _sstock_set(conn, to_id, p["id"], hands_t + qty, shelf_t)
            _seller_avg_set(conn, to_id, p["id"], new_avg_t)
            _line_insert(conn, out_id, p, qty=qty, purchase_price=r2(avg_f))
            _line_insert(conn, in_id, p, qty=qty, purchase_price=r2(avg_f))
            total += qty * p["retail_price"]
        money = r2(total * share_pct / 100.0)
        conn.execute("UPDATE docs SET amount=?, money=? WHERE id=?",
                     (r2(total), -money, out_id))
        conn.execute("UPDATE docs SET amount=?, money=? WHERE id=?",
                     (r2(total), money, in_id))
    return doc_get(conn, out_id)


def doc_price_change(conn, user, changes):
    """Журнальный документ смены цен продажи (создаётся автоматически, сразу проведён)."""
    if not changes:
        return None
    with _lock, conn:
        doc_id = _doc_insert(conn, "price_change", now_utc()[:10], user["id"], status="posted")
        for ch in changes:
            p = _product(conn, ch["product_id"])
            _line_insert(conn, doc_id, p, qty_before=ch["old"], purchase_price=ch["old"])
    return doc_id


# ---------- проведение / сторно ----------

def post_doc(conn, user, doc_id):
    """Проведение: черновик начинает влиять на остатки, партии и балансы."""
    d = doc_get(conn, doc_id)
    if d["status"] != "draft":
        raise ValueError("Документ уже проведён или отменён")
    t = d["type"]
    with _lock, conn:
        if t == "prihod":
            for l in d["lines"]:
                _stock_set(conn, l["product_id"],
                           _stock_qty(conn, l["product_id"]) + l["qty"])
                _fifo_in(conn, doc_id, l["product_id"], l["qty"], l["purchase_price"])
                cur = conn.execute(
                    "SELECT purchase_price FROM products WHERE id=?",
                    (l["product_id"],)).fetchone()
                if abs(cur["purchase_price"] - l["purchase_price"]) > EPS:
                    conn.execute("UPDATE products SET purchase_price=? WHERE id=?",
                                 (l["purchase_price"], l["product_id"]))
        elif t == "initial":
            for l in d["lines"]:
                conn.execute("UPDATE lots SET qty_left=0 WHERE product_id=? AND qty_left>0",
                             (l["product_id"],))
                _stock_set(conn, l["product_id"], l["qty"])
                if l["qty"] > EPS:
                    _fifo_in(conn, doc_id, l["product_id"], l["qty"], l["purchase_price"])
        elif t == "vydacha":
            sid = d["seller_id"]
            for l in d["lines"]:
                pid = l["product_id"]
                q_shelf = l["qty_shelf"]
                q_wh = l["qty"] - q_shelf
                cost = 0.0
                if q_wh > EPS:
                    have = _stock_qty(conn, pid)
                    if q_wh > have + EPS:
                        raise ValueError(f"{l['name']}: на складе только {have:g} {l['unit']}")
                    _stock_set(conn, pid, have - q_wh)
                    cost += _fifo_out(conn, doc_id, pid, q_wh, l["name"])
                hands, shelf = _sstock(conn, sid, pid)
                if q_shelf > shelf + EPS:
                    raise ValueError(f"{l['name']}: на полке только {shelf:g} {l['unit']}")
                avg = _seller_avg(conn, sid, pid)
                cost_wh = cost              # FIFO-себестоимость части со склада
                cost += q_shelf * avg       # полочная часть — по средней продавца
                unit_cost = cost / l["qty"] if l["qty"] > EPS else 0.0
                # средняя себестоимость всей массы продавца (руки + полка):
                # полочная часть уже в базе, новой массой считается только склад
                base_mass = hands + shelf
                new_avg = ((base_mass * avg + cost_wh) / (base_mass + q_wh)
                           if (base_mass + q_wh) > EPS else unit_cost)
                _sstock_set(conn, sid, pid, hands + l["qty"], shelf - q_shelf)
                _seller_avg_set(conn, sid, pid, new_avg)
                conn.execute("UPDATE doc_lines SET purchase_price=? WHERE id=?",
                             (r2(unit_cost), l["id"]))
        elif t == "sdacha":
            sid = d["seller_id"]
            for l in d["lines"]:
                pid = l["product_id"]
                hands, shelf = _sstock(conn, sid, pid)
                if l["qty"] > hands + EPS:
                    raise ValueError(f"{l['name']}: у продавца на руках только {hands:g} "
                                     f"{l['unit']}")
                avg = _seller_avg(conn, sid, pid)
                _sstock_set(conn, sid, pid, hands - l["qty"], shelf + l["qty_to_shelf"])
                if l["qty_to_wh"] > EPS:
                    _stock_set(conn, pid, _stock_qty(conn, pid) + l["qty_to_wh"])
                    _fifo_in(conn, doc_id, pid, l["qty_to_wh"], avg)
                conn.execute("UPDATE doc_lines SET purchase_price=? WHERE id=?",
                             (r2(avg), l["id"]))
        elif t == "inventory":
            # ведомость: проведение рождает списание (недостачи) и оприходование (излишки)
            wo_lines, sp_lines = [], []
            for l in d["lines"]:
                current = _stock_qty(conn, l["product_id"])
                diff = l["qty"] - current
                conn.execute("UPDATE doc_lines SET qty_before=? WHERE id=?",
                             (current, l["id"]))
                if diff < -EPS:
                    wo_lines.append((l, -diff))
                elif diff > EPS:
                    sp_lines.append((l, diff))
            total = 0.0
            if wo_lines:
                wo_id = _doc_insert(conn, "writeoff", d["date"], user["id"],
                                    parent_id=doc_id, status="draft",
                                    comment="Недостача по инвентаризации")
                wo_total = 0.0
                for l, q in wo_lines:
                    pid = l["product_id"]
                    cost = _fifo_out(conn, wo_id, pid, q, l["name"])
                    _stock_set(conn, pid, _stock_qty(conn, pid) - q)
                    p = _product(conn, pid)
                    _line_insert(conn, wo_id, p, qty=q,
                                 purchase_price=r2(cost / q if q > EPS else 0))
                    conn.execute("UPDATE doc_lines SET purchase_price=? WHERE doc_id=? AND "
                                 "product_id=?", (r2(cost / q if q > EPS else 0), doc_id, pid))
                    wo_total += cost
                conn.execute("UPDATE docs SET amount=?, status='posted' WHERE id=?",
                             (r2(-wo_total), wo_id))
                total -= wo_total
            if sp_lines:
                sp_id = _doc_insert(conn, "surplus", d["date"], user["id"],
                                    parent_id=doc_id, status="draft",
                                    comment="Излишки по инвентаризации")
                sp_total = 0.0
                for l, q in sp_lines:
                    pid = l["product_id"]
                    p = _product(conn, pid)
                    cost_u = _last_cost(conn, pid, p["purchase_price"])
                    _fifo_in(conn, sp_id, pid, q, cost_u)
                    _stock_set(conn, pid, _stock_qty(conn, pid) + q)
                    _line_insert(conn, sp_id, p, qty=q, purchase_price=r2(cost_u))
                    conn.execute("UPDATE doc_lines SET purchase_price=? WHERE doc_id=? AND "
                                 "product_id=?", (r2(cost_u), doc_id, pid))
                    sp_total += cost_u * q
                conn.execute("UPDATE docs SET amount=?, status='posted' WHERE id=?",
                             (r2(sp_total), sp_id))
                total += sp_total
            conn.execute("UPDATE docs SET amount=? WHERE id=?", (r2(total), doc_id))
        elif t in ("incass", "cash"):
            pass  # только денежный эффект, он включается статусом
        else:
            raise ValueError("Этот документ нельзя провести")
        conn.execute("UPDATE docs SET status='posted' WHERE id=?", (doc_id,))
    return doc_get(conn, doc_id)


def void_doc(conn, user, doc_id):
    """Сторно: документ остаётся в истории со статусом «Отменён», его влияние снимается."""
    d = doc_get(conn, doc_id)
    if d["status"] != "posted":
        raise ValueError("Отменить можно только проведённый документ")
    t = d["type"]
    with _lock, conn:
        if t == "prihod":
            for l in d["lines"]:
                have = _stock_qty(conn, l["product_id"])
                if l["qty"] > have + EPS:
                    raise ValueError(f"{l['name']}: нельзя отменить — товар уже израсходован "
                                     "со склада")
                _stock_set(conn, l["product_id"], have - l["qty"])
            _fifo_reverse(conn, doc_id)
        elif t == "vydacha":
            sid = d["seller_id"]
            for l in d["lines"]:
                pid = l["product_id"]
                hands, shelf = _sstock(conn, sid, pid)
                if l["qty"] > hands + EPS:
                    raise ValueError(f"{l['name']}: нельзя отменить — продавец уже сдал или "
                                     "продал этот товар")
                q_shelf = l["qty_shelf"]
                _sstock_set(conn, sid, pid, hands - l["qty"], shelf + q_shelf)
                q_wh = l["qty"] - q_shelf
                if q_wh > EPS:
                    _stock_set(conn, pid, _stock_qty(conn, pid) + q_wh)
            _fifo_reverse(conn, doc_id)
        elif t == "sdacha":
            sid = d["seller_id"]
            _fifo_reverse(conn, doc_id)  # упадёт, если возвращённый товар уже ушёл
            for l in d["lines"]:
                pid = l["product_id"]
                hands, shelf = _sstock(conn, sid, pid)
                if l["qty_to_shelf"] > shelf + EPS:
                    raise ValueError(f"{l['name']}: нельзя отменить — товар с полки уже выдан")
                if l["qty_to_wh"] > EPS:
                    _stock_set(conn, pid, _stock_qty(conn, pid) - l["qty_to_wh"])
                _sstock_set(conn, sid, pid, hands + l["qty"], shelf - l["qty_to_shelf"])
        elif t == "inventory":
            for ch in conn.execute(
                "SELECT id, status FROM docs WHERE parent_id=?", (doc_id,)
            ).fetchall():
                if ch["status"] == "posted":
                    void_doc(conn, user, ch["id"])
        elif t == "writeoff":
            _fifo_reverse(conn, doc_id)
            for l in d["lines"]:
                _stock_set(conn, l["product_id"],
                           _stock_qty(conn, l["product_id"]) + l["qty"])
        elif t == "surplus":
            _fifo_reverse(conn, doc_id)
            for l in d["lines"]:
                have = _stock_qty(conn, l["product_id"])
                if l["qty"] > have + EPS:
                    raise ValueError(f"{l['name']}: нельзя отменить — излишек уже израсходован")
                _stock_set(conn, l["product_id"], have - l["qty"])
        elif t in ("incass", "cash"):
            pass
        elif t == "transfer_in":
            # отменяем всегда пару целиком — через документ отправителя
            return void_doc(conn, user, d["parent_id"])
        elif t == "transfer_out":
            to_doc = conn.execute(
                "SELECT id, seller_id FROM docs WHERE parent_id=? AND type='transfer_in'",
                (doc_id,)).fetchone()
            for l in d["lines"]:
                pid = l["product_id"]
                hands_t, shelf_t = _sstock(conn, to_doc["seller_id"], pid)
                if l["qty"] > hands_t + EPS:
                    raise ValueError(f"{l['name']}: нельзя отменить — получатель уже сдал "
                                     "или продал этот товар")
                hands_f, shelf_f = _sstock(conn, d["seller_id"], pid)
                _sstock_set(conn, to_doc["seller_id"], pid, hands_t - l["qty"], shelf_t)
                _sstock_set(conn, d["seller_id"], pid, hands_f + l["qty"], shelf_f)
            conn.execute("UPDATE docs SET status='void' WHERE id=?", (to_doc["id"],))
        elif t == "initial":
            raise ValueError("Начальные остатки нельзя отменить — исправьте инвентаризацией")
        else:
            raise ValueError("Этот документ нельзя отменить")
        conn.execute("UPDATE docs SET status='void' WHERE id=?", (doc_id,))
    return doc_get(conn, doc_id)


def doc_get(conn, doc_id):
    d = conn.execute(
        "SELECT d.*, u.first_name || ' ' || u.last_name AS creator_name, "
        "s.first_name || ' ' || s.last_name AS seller_name, sup.name AS supplier_name "
        "FROM docs d JOIN users u ON u.id = d.created_by "
        "LEFT JOIN users s ON s.id = d.seller_id "
        "LEFT JOIN suppliers sup ON sup.id = d.supplier_id WHERE d.id=?",
        (doc_id,),
    ).fetchone()
    if d is None:
        raise ValueError("Документ не найден")
    lines = [dict(r) for r in conn.execute(
        "SELECT l.*, p.name, p.unit FROM doc_lines l JOIN products p ON p.id = l.product_id "
        "WHERE l.doc_id=? ORDER BY p.name", (doc_id,),
    )]
    out = {**dict(d), "lines": lines}
    # цепочка: родитель и дети
    chain = []
    if d["parent_id"]:
        pr = conn.execute("SELECT id, type, date, ts, status, amount FROM docs WHERE id=?",
                          (d["parent_id"],)).fetchone()
        if pr:
            chain.append({**dict(pr), "rel": "parent"})
    for ch in conn.execute(
        "SELECT id, type, date, ts, status, amount FROM docs WHERE parent_id=? ORDER BY id",
        (doc_id,),
    ):
        chain.append({**dict(ch), "rel": "child"})
    out["chain"] = chain
    return out


def docs_list(conn, dtype=None, seller_id=None, limit=100, types=None):
    q = ("SELECT d.*, u.first_name || ' ' || u.last_name AS creator_name, "
         "s.first_name || ' ' || s.last_name AS seller_name "
         "FROM docs d JOIN users u ON u.id = d.created_by "
         "LEFT JOIN users s ON s.id = d.seller_id WHERE 1=1")
    args = []
    if dtype:
        q += " AND d.type=?"
        args.append(dtype)
    if types:
        q += " AND d.type IN (%s)" % ",".join("?" * len(types))
        args.extend(types)
    if seller_id:
        q += " AND d.seller_id=?"
        args.append(seller_id)
    q += " ORDER BY d.id DESC LIMIT ?"
    args.append(min(int(limit), 500))
    return [dict(r) for r in conn.execute(q, args)]


def doc_delete(conn, user, doc_id):
    """Физическое удаление — только для черновиков. Проведённые отменяются (сторно)."""
    d = doc_get(conn, doc_id)
    if d["status"] == "posted":
        raise ValueError("Проведённый документ не удаляется — его можно только отменить")
    with _lock, conn:
        conn.execute("DELETE FROM doc_lines WHERE doc_id=?", (doc_id,))
        conn.execute("DELETE FROM docs WHERE id=?", (doc_id,))
    return {"deleted": True}


# ---------- деньги ----------

def seller_balance(conn, seller_id):
    rows = conn.execute(
        "SELECT type, COALESCE(SUM(money),0) m, COALESCE(SUM(amount),0) a, COUNT(*) n "
        "FROM docs WHERE seller_id=? AND status='posted' GROUP BY type", (seller_id,),
    ).fetchall()
    by = {r["type"]: r for r in rows}

    def m(t):
        return float(by[t]["m"]) if t in by else 0.0

    def a(t):
        return float(by[t]["a"]) if t in by else 0.0

    return {
        "taken_value": r2(a("vydacha")),          # взял товара на сумму (розница)
        "charged": r2(m("vydacha")),              # начислено (доля)
        "returned_credit": r2(-m("sdacha")),      # зачтено возвратами товара
        "sold_value": r2(a("sdacha")),            # продал на сумму (по сдачам)
        "terminal_raw": r2(a("incass")),          # пробил по терминалу
        "terminal_credit": r2(-m("incass")),      # зачтено по терминалу (минус комиссия)
        "cash_total": r2(a("cash")),              # наличными (+ нам, − мы ему)
        "balance": r2(sum(float(r["m"]) for r in rows)),
    }


def sellers_overview(conn):
    out = []
    for u in conn.execute(
        "SELECT * FROM users WHERE role='seller' AND active=1 ORDER BY first_name"
    ):
        u = dict(u)
        st = seller_stock(conn, u["id"])
        bal = seller_balance(conn, u["id"])
        out.append({
            "id": u["id"], "name": fio(u), "balance": bal["balance"],
            "hands_value": st["hands_value"], "shelf_value": st["shelf_value"],
        })
    return out


# ---------- аналитика ----------

def stock_report(conn):
    rows = []
    t_kg = t_pcs = t_purch = t_retail = 0.0
    for p in conn.execute(
        "SELECT p.*, COALESCE(s.qty,0) qty FROM products p "
        "LEFT JOIN stock s ON s.product_id = p.id "
        "LEFT JOIN product_groups g ON g.name = p.group_name "
        "WHERE COALESCE(s.qty,0) > ?" + GROUP_ORDER_SQL, (EPS,),
    ):
        qty = float(p["qty"])
        pv, rv = r2(qty * p["purchase_price"]), r2(qty * p["retail_price"])
        rows.append({"product_id": p["id"], "name": p["name"], "unit": p["unit"], "qty": qty,
                     "group_name": p["group_name"],
                     "purchase_price": p["purchase_price"], "retail_price": p["retail_price"],
                     "purchase_value": pv, "retail_value": rv})
        if p["unit"] == "кг":
            t_kg += qty
        else:
            t_pcs += qty
        t_purch += pv
        t_retail += rv
    shelf = [dict(r) for r in conn.execute(
        "SELECT p.name, p.unit, SUM(ss.qty_shelf) qty, SUM(ss.qty_shelf * p.retail_price) value "
        "FROM seller_stock ss JOIN products p ON p.id = ss.product_id "
        "WHERE ss.qty_shelf > ? GROUP BY p.id ORDER BY p.name", (EPS,),
    )]
    return {
        "rows": rows,
        "totals": {"kg": r2(t_kg), "pcs": r2(t_pcs), "purchase_value": r2(t_purch),
                   "retail_value": r2(t_retail)},
        "shelf_rows": [{**s, "value": r2(s["value"])} for s in shelf],
    }


def on_sellers_report(conn):
    out = []
    for u in conn.execute("SELECT * FROM users WHERE role='seller' AND active=1 ORDER BY first_name"):
        st = seller_stock(conn, u["id"])
        if st["hands"] or st["shelf"]:
            out.append({"seller_id": u["id"], "name": fio(dict(u)), **st})
    return out


def sales_report(conn, date_from, date_to, share_pct):
    _date_ok(date_from)
    _date_ok(date_to)
    sellers = {}

    def cell(sid, name):
        if sid not in sellers:
            sellers[sid] = {"seller_id": sid, "name": name, "sold_value": 0.0, "sold_kg": 0.0,
                            "sold_pcs": 0.0, "our_share": 0.0, "terminal_raw": 0.0,
                            "terminal_credit": 0.0, "cash": 0.0, "products": {}}
        return sellers[sid]

    for r in conn.execute(
        "SELECT d.seller_id, s.first_name || ' ' || s.last_name AS name, l.qty_sold, "
        "l.retail_price, p.name pname, p.unit "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "JOIN products p ON p.id = l.product_id JOIN users s ON s.id = d.seller_id "
        "WHERE d.type='sdacha' AND d.status='posted' AND d.date BETWEEN ? AND ? AND l.qty_sold > ?",
        (date_from, date_to, EPS),
    ):
        c = cell(r["seller_id"], r["name"])
        val = r["qty_sold"] * r["retail_price"]
        c["sold_value"] += val
        if r["unit"] == "кг":
            c["sold_kg"] += r["qty_sold"]
        else:
            c["sold_pcs"] += r["qty_sold"]
        pr = c["products"].setdefault(r["pname"], {"name": r["pname"], "unit": r["unit"],
                                                   "qty": 0.0, "value": 0.0})
        pr["qty"] += r["qty_sold"]
        pr["value"] += val

    for r in conn.execute(
        "SELECT d.seller_id, s.first_name || ' ' || s.last_name AS name, d.type, "
        "SUM(d.amount) a, SUM(d.money) m FROM docs d JOIN users s ON s.id = d.seller_id "
        "WHERE d.type IN ('incass','cash') AND d.status='posted' AND d.date BETWEEN ? AND ? GROUP BY d.seller_id, d.type",
        (date_from, date_to),
    ):
        c = cell(r["seller_id"], r["name"])
        if r["type"] == "incass":
            c["terminal_raw"] = float(r["a"])
            c["terminal_credit"] = -float(r["m"])
        else:
            c["cash"] = float(r["a"])

    out = []
    for c in sellers.values():
        c["our_share"] = r2(c["sold_value"] * share_pct / 100.0)
        for k in ("sold_value", "sold_kg", "sold_pcs", "terminal_raw", "terminal_credit", "cash"):
            c[k] = r2(c[k])
        c["products"] = sorted(
            [{**p, "qty": r2(p["qty"]), "value": r2(p["value"])} for p in c["products"].values()],
            key=lambda x: -x["value"])
        c["balance"] = seller_balance(conn, c["seller_id"])["balance"]
        out.append(c)
    out.sort(key=lambda x: -x["sold_value"])
    totals = {
        "sold_value": r2(sum(c["sold_value"] for c in out)),
        "sold_kg": r2(sum(c["sold_kg"] for c in out)),
        "our_share": r2(sum(c["our_share"] for c in out)),
        "terminal_credit": r2(sum(c["terminal_credit"] for c in out)),
        "cash": r2(sum(c["cash"] for c in out)),
    }
    return {"sellers": out, "totals": totals}


# ---------- мероприятия и точки ----------

def people_list(conn):
    """Короткий список активных пользователей с ролью — фронт сам решает, кого показывать
    (фильтр «кто едет» скрывает админа и кладовщика, бронь — нет)."""
    return [{"id": r["id"], "name": f"{r['first_name']} {r['last_name']}".strip(),
             "role": r["role"]}
            for r in conn.execute(
                "SELECT id, first_name, last_name, role FROM users"
                " WHERE active=1 ORDER BY first_name")]


def _owner_ok(conn, owner_user_id):
    if owner_user_id in (None, 0, ""):
        return None
    if conn.execute("SELECT 1 FROM users WHERE id=?", (owner_user_id,)).fetchone() is None:
        raise ValueError("Пользователь не найден")
    return owner_user_id


_PLACE_SELECT = (
    "SELECT t.*, o.first_name || ' ' || o.last_name AS owner_name, "
    "c.first_name || ' ' || c.last_name AS creator_name "
    "FROM {table} t LEFT JOIN users o ON o.id = t.owner_user_id "
    "LEFT JOIN users c ON c.id = t.created_by"
)

# списки гоняются на телефон целиком — отдаём только используемые фронтом поля
_PLACE_LIST_SELECT = (
    "SELECT {cols}, o.first_name || ' ' || o.last_name AS owner_name "
    "FROM {table} t LEFT JOIN users o ON o.id = t.owner_user_id"
)
_EVENT_COLS = ("t.id, t.name, t.etype, t.city, t.date_from, t.date_to, "
               "t.owner_user_id, t.comment, t.created_by")
_POINT_COLS = ("t.id, t.name, t.ptype, t.city, t.address, t.phone, t.email, "
               "t.owner_user_id, t.comment, t.created_by")


def events_list(conn, city=None, when="upcoming", today=None):
    q = _PLACE_LIST_SELECT.format(cols=_EVENT_COLS, table="events") + " WHERE 1=1"
    args = []
    if city:
        q += " AND t.city = ?"
        args.append(city)
    if when == "upcoming" and today:
        q += " AND COALESCE(t.date_to, t.date_from) >= ?"
        args.append(today)
    elif when == "past" and today:
        q += " AND COALESCE(t.date_to, t.date_from) < ?"
        args.append(today)
    order = " ORDER BY t.date_from" + (" DESC" if when == "past" else "")
    rows = [dict(r) for r in conn.execute(q + order + " LIMIT 2000", args)]
    return _attach_bookings(conn, "event", rows, today or "2000-01-01")


def event_save(conn, user, event_id, name, etype, city, date_from, date_to,
               owner_user_id, comment):
    name = (name or "").strip()
    if not name:
        raise ValueError("Укажите название мероприятия")
    _date_ok(date_from)
    date_to = (date_to or "").strip() or None
    if date_to:
        _date_ok(date_to)
        if date_to < date_from:
            raise ValueError("Дата окончания раньше даты начала")
    owner = _owner_ok(conn, owner_user_id)
    vals = (name, (etype or "").strip(), (city or "").strip(), date_from, date_to,
            owner, (comment or "").strip() or None)
    with _lock, conn:
        if event_id:
            if conn.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone() is None:
                raise ValueError("Мероприятие не найдено")
            conn.execute(
                "UPDATE events SET name=?, etype=?, city=?, date_from=?, date_to=?, "
                "owner_user_id=?, comment=? WHERE id=?", vals + (event_id,))
        else:
            cur = conn.execute(
                "INSERT INTO events(name, etype, city, date_from, date_to, owner_user_id, "
                "comment, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                vals + (user["id"], now_utc()))
            event_id = cur.lastrowid
    r = conn.execute(_PLACE_SELECT.format(table="events") + " WHERE t.id=?", (event_id,)).fetchone()
    return dict(r)


def event_delete(conn, user, event_id):
    r = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if r is None:
        raise ValueError("Мероприятие не найдено")
    if user["role"] != "admin" and r["created_by"] != user["id"]:
        raise ValueError("Удалить может админ или тот, кто добавил")
    with _lock, conn:
        conn.execute("DELETE FROM events WHERE id=?", (event_id,))
    return {"deleted": True}


def points_list(conn, ptype=None, city=None, today=None):
    q = _PLACE_LIST_SELECT.format(cols=_POINT_COLS, table="points") + " WHERE 1=1"
    args = []
    if ptype:
        q += " AND t.ptype = ?"
        args.append(ptype)
    if city:
        q += " AND t.city = ?"
        args.append(city)
    rows = [dict(r) for r in conn.execute(q + " ORDER BY t.city, t.name LIMIT 1000", args)]
    return _attach_bookings(conn, "point", rows, today or "2000-01-01")


def point_save(conn, user, point_id, name, ptype, city, address, owner_user_id, comment,
               phone=None, email=None):
    name = (name or "").strip()
    if not name:
        raise ValueError("Укажите название точки")
    owner = _owner_ok(conn, owner_user_id)
    vals = (name, (ptype or "").strip(), (city or "").strip(),
            (address or "").strip() or None, (phone or "").strip() or None,
            (email or "").strip() or None, owner, (comment or "").strip() or None)
    with _lock, conn:
        if point_id:
            if conn.execute("SELECT 1 FROM points WHERE id=?", (point_id,)).fetchone() is None:
                raise ValueError("Точка не найдена")
            conn.execute(
                "UPDATE points SET name=?, ptype=?, city=?, address=?, phone=?, email=?, "
                "owner_user_id=?, comment=? WHERE id=?", vals + (point_id,))
        else:
            cur = conn.execute(
                "INSERT INTO points(name, ptype, city, address, phone, email, owner_user_id, "
                "comment, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                vals + (user["id"], now_utc()))
            point_id = cur.lastrowid
    r = conn.execute(_PLACE_SELECT.format(table="points") + " WHERE t.id=?", (point_id,)).fetchone()
    return dict(r)


def point_delete(conn, user, point_id):
    r = conn.execute("SELECT * FROM points WHERE id=?", (point_id,)).fetchone()
    if r is None:
        raise ValueError("Точка не найдена")
    if user["role"] != "admin" and r["created_by"] != user["id"]:
        raise ValueError("Удалить может админ или тот, кто добавил")
    with _lock, conn:
        conn.execute("DELETE FROM points WHERE id=?", (point_id,))
    return {"deleted": True}


def bookings_list(conn, kind, ref_id, today=None):
    if kind not in ("point", "event"):
        raise ValueError("Неизвестный тип брони")
    q = ("SELECT b.*, u.first_name || ' ' || u.last_name AS user_name "
         "FROM bookings b JOIN users u ON u.id = b.user_id "
         "WHERE b.kind=? AND b.ref_id=?")
    args = [kind, ref_id]
    if today:
        q += " AND b.date_to >= ?"
        args.append(today)
    return [dict(r) for r in conn.execute(q + " ORDER BY b.date_from", args)]


def booking_create(conn, user, kind, ref_id, user_id, date_from, date_to, comment=None):
    if kind not in ("point", "event"):
        raise ValueError("Неизвестный тип брони")
    table = "points" if kind == "point" else "events"
    if conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (ref_id,)).fetchone() is None:
        raise ValueError("Точка или мероприятие не найдены")
    u = user_by_id(conn, user_id or user["id"])
    if u is None:
        raise ValueError("Пользователь не найден")
    _date_ok(date_from)
    date_to = (date_to or "").strip() or date_from
    _date_ok(date_to)
    if date_to < date_from:
        raise ValueError("Дата окончания раньше даты начала")
    clash = conn.execute(
        "SELECT b.*, x.first_name || ' ' || x.last_name AS user_name FROM bookings b "
        "JOIN users x ON x.id = b.user_id "
        "WHERE b.kind=? AND b.ref_id=? AND b.date_from <= ? AND b.date_to >= ? LIMIT 1",
        (kind, ref_id, date_to, date_from),
    ).fetchone()
    if clash:
        raise ValueError(f"Уже забронировано: {clash['user_name']} "
                         f"({clash['date_from']} – {clash['date_to']})")
    with _lock, conn:
        cur = conn.execute(
            "INSERT INTO bookings(kind, ref_id, user_id, date_from, date_to, comment, "
            "created_by, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (kind, ref_id, u["id"], date_from, date_to, (comment or "").strip() or None,
             user["id"], now_utc()),
        )
    return {"id": cur.lastrowid}


def booking_delete(conn, user, booking_id):
    r = conn.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone()
    if r is None:
        raise ValueError("Бронь не найдена")
    if user["role"] != "admin" and r["created_by"] != user["id"] and r["user_id"] != user["id"]:
        raise ValueError("Снять бронь может админ, кто бронировал или на кого бронь")
    with _lock, conn:
        conn.execute("DELETE FROM bookings WHERE id=?", (booking_id,))
    return {"deleted": True}


def _attach_bookings(conn, kind, rows, today):
    """Дописывает каждой точке/мероприятию ближайшие активные брони."""
    if not rows:
        return rows
    ids = [r["id"] for r in rows]
    marks = ",".join("?" * len(ids))
    by_ref = {}
    for b in conn.execute(
        "SELECT b.id, b.ref_id, b.user_id, b.created_by, b.date_from, b.date_to, "
        "u.first_name || ' ' || u.last_name AS user_name "
        f"FROM bookings b JOIN users u ON u.id = b.user_id "
        f"WHERE b.kind=? AND b.ref_id IN ({marks}) AND b.date_to >= ? ORDER BY b.date_from",
        [kind] + ids + [today],
    ):
        by_ref.setdefault(b["ref_id"], []).append(dict(b))
    for r in rows:
        r["bookings"] = by_ref.get(r["id"], [])
    return rows


def places_cities(conn):
    cities = set()
    for r in conn.execute("SELECT DISTINCT city FROM events WHERE city<>''"):
        cities.add(r["city"])
    for r in conn.execute("SELECT DISTINCT city FROM points WHERE city<>''"):
        cities.add(r["city"])
    return sorted(cities)


# ---------- расходы и прибыль ----------

def expense_add(conn, user, date, category, amount, comment=None):
    _date_ok(date)
    amt = _num(amount, "Сумма расхода")
    category = (category or "").strip() or "Прочее"
    with _lock, conn:
        cur = conn.execute(
            "INSERT INTO expenses(ts, date, category, amount, comment, created_by) "
            "VALUES(?,?,?,?,?,?)",
            (now_utc(), date, category, r2(amt), (comment or "").strip() or None, user["id"]),
        )
    r = conn.execute("SELECT * FROM expenses WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(r)


def expenses_list(conn, date_from, date_to):
    _date_ok(date_from)
    _date_ok(date_to)
    rows = [dict(r) for r in conn.execute(
        "SELECT e.*, u.first_name || ' ' || u.last_name AS creator_name FROM expenses e "
        "JOIN users u ON u.id = e.created_by "
        "WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC",
        (date_from, date_to),
    )]
    by_cat = {}
    for r in rows:
        by_cat[r["category"]] = by_cat.get(r["category"], 0.0) + r["amount"]
    return {
        "expenses": rows,
        "total": r2(sum(r["amount"] for r in rows)),
        "by_category": [{"category": k, "amount": r2(v)}
                        for k, v in sorted(by_cat.items(), key=lambda x: -x[1])],
    }


def expense_delete(conn, eid):
    if conn.execute("SELECT 1 FROM expenses WHERE id=?", (eid,)).fetchone() is None:
        raise ValueError("Расход не найден")
    with _lock, conn:
        conn.execute("DELETE FROM expenses WHERE id=?", (eid,))
    return {"deleted": True}


def profit_report(conn, date_from, date_to, share_pct):
    """Чистая прибыль за период.

    Оборот = продано по рознице (по сдачам). Наша выручка = доля от оборота.
    Себестоимость проданного — по закупочным ценам на момент выдачи (снимок в строках сдачи).
    Плюс результат инвентаризаций (недостачи/излишки по закупу), минус прочие расходы.
    Комиссия терминала прибыль не трогает — её несёт продавец.
    """
    _date_ok(date_from)
    _date_ok(date_to)
    r = conn.execute(
        "SELECT COALESCE(SUM(l.qty_sold * l.retail_price),0) sold, "
        "COALESCE(SUM(l.qty_sold * l.purchase_price),0) cogs "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "WHERE d.type='sdacha' AND d.status='posted' AND d.date BETWEEN ? AND ?",
        (date_from, date_to),
    ).fetchone()
    turnover = float(r["sold"])
    cogs = float(r["cogs"])
    revenue = turnover * share_pct / 100.0
    inv = conn.execute(
        "SELECT COALESCE(SUM(amount),0) a FROM docs "
        "WHERE type IN ('writeoff','surplus') AND status='posted' "
        "AND date BETWEEN ? AND ?",
        (date_from, date_to),
    ).fetchone()
    inventory_delta = float(inv["a"])
    term = conn.execute(
        "SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(money),0) m FROM docs "
        "WHERE type='incass' AND status='posted' AND date BETWEEN ? AND ?",
        (date_from, date_to),
    ).fetchone()
    exp = expenses_list(conn, date_from, date_to)
    profit = revenue - cogs + inventory_delta - exp["total"]
    return {
        "turnover": r2(turnover),
        "revenue": r2(revenue),
        "cogs": r2(cogs),
        "gross_profit": r2(revenue - cogs),
        "inventory_delta": r2(inventory_delta),
        "terminal_raw": r2(float(term["a"])),
        "terminal_credit": r2(-float(term["m"])),
        "expenses_total": exp["total"],
        "expenses_by_category": exp["by_category"],
        "net_profit": r2(profit),
        "margin_pct": r2(profit / turnover * 100.0) if turnover > EPS else 0.0,
        "margin_of_revenue_pct": r2(profit / revenue * 100.0) if revenue > EPS else 0.0,
    }


def products_report(conn, date_from, date_to, share_pct):
    """Управленческая аналитика по товарам: продано, оборот, наша доля, заработок."""
    _date_ok(date_from)
    _date_ok(date_to)
    rows = []
    t_qty_kg = t_val = t_profit = 0.0
    for r in conn.execute(
        "SELECT p.id, p.name, p.unit, COALESCE(SUM(l.qty_sold),0) qty, "
        "COALESCE(SUM(l.qty_sold * l.retail_price),0) val, "
        "COALESCE(SUM(l.qty_sold * l.purchase_price),0) cogs "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "JOIN products p ON p.id = l.product_id "
        "WHERE d.type='sdacha' AND d.status='posted' AND d.date BETWEEN ? AND ? "
        "AND l.qty_sold > ? GROUP BY p.id ORDER BY val DESC",
        (date_from, date_to, EPS),
    ):
        share = float(r["val"]) * share_pct / 100.0
        profit = share - float(r["cogs"])
        rows.append({
            "product_id": r["id"], "name": r["name"], "unit": r["unit"],
            "qty": r2(r["qty"]), "sold_value": r2(r["val"]), "cogs": r2(r["cogs"]),
            "our_share": r2(share), "profit": r2(profit),
        })
        if r["unit"] == "кг":
            t_qty_kg += r["qty"]
        t_val += r["val"]
        t_profit += profit
    return {
        "products": rows,
        "totals": {"kg": r2(t_qty_kg), "sold_value": r2(t_val), "profit": r2(t_profit)},
    }


def sales_by_period(conn, date_from, date_to, share_pct, gran):
    """Продажи по дням / неделям / месяцам: кг, оборот, наша доля."""
    _date_ok(date_from)
    _date_ok(date_to)
    fmt = {"day": "%Y-%m-%d", "week": "%Y-%W", "month": "%Y-%m"}.get(gran)
    if not fmt:
        raise ValueError("Неизвестный период группировки")
    rows = []
    t_kg = t_val = 0.0
    for r in conn.execute(
        "SELECT strftime(?, d.date) per, MIN(d.date) d1, MAX(d.date) d2, "
        "COALESCE(SUM(CASE WHEN p.unit='кг' THEN l.qty_sold ELSE 0 END),0) kg, "
        "COALESCE(SUM(l.qty_sold * l.retail_price),0) val "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "JOIN products p ON p.id = l.product_id "
        "WHERE d.type='sdacha' AND d.status='posted' AND d.date BETWEEN ? AND ? "
        "AND l.qty_sold > ? GROUP BY per ORDER BY per DESC",
        (fmt, date_from, date_to, EPS),
    ):
        rows.append({"period": r["per"], "date_from": r["d1"], "date_to": r["d2"],
                     "kg": r2(r["kg"]), "sold_value": r2(r["val"]),
                     "our_share": r2(float(r["val"]) * share_pct / 100.0)})
        t_kg += r["kg"]
        t_val += r["val"]
    return {"rows": rows,
            "totals": {"kg": r2(t_kg), "sold_value": r2(t_val),
                       "our_share": r2(t_val * share_pct / 100.0)}}


def sales_by_group(conn, date_from, date_to, share_pct):
    """Продажи по категориям (группам товаров): кг, оборот, заработок."""
    _date_ok(date_from)
    _date_ok(date_to)
    rows = []
    t_kg = t_val = t_profit = 0.0
    for r in conn.execute(
        "SELECT COALESCE(NULLIF(p.group_name,''),'Без группы') grp, "
        "COALESCE(SUM(CASE WHEN p.unit='кг' THEN l.qty_sold ELSE 0 END),0) kg, "
        "COALESCE(SUM(l.qty_sold * l.retail_price),0) val, "
        "COALESCE(SUM(l.qty_sold * l.purchase_price),0) cogs "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "JOIN products p ON p.id = l.product_id "
        "WHERE d.type='sdacha' AND d.status='posted' AND d.date BETWEEN ? AND ? "
        "AND l.qty_sold > ? GROUP BY grp ORDER BY val DESC",
        (date_from, date_to, EPS),
    ):
        share = float(r["val"]) * share_pct / 100.0
        profit = share - float(r["cogs"])
        rows.append({"group": r["grp"], "kg": r2(r["kg"]), "sold_value": r2(r["val"]),
                     "our_share": r2(share), "profit": r2(profit)})
        t_kg += r["kg"]
        t_val += r["val"]
        t_profit += profit
    return {"rows": rows,
            "totals": {"kg": r2(t_kg), "sold_value": r2(t_val), "profit": r2(t_profit)}}


def movement_report(conn, date_from, date_to):
    """Движение товара по складу за период: поступления, возвраты, выдачи, списания."""
    _date_ok(date_from)
    _date_ok(date_to)
    data = {}

    def bucket(r):
        return data.setdefault(r["pid"], {
            "name": r["name"], "unit": r["unit"], "prihod": 0.0, "vozvrat": 0.0,
            "surplus": 0.0, "vydacha": 0.0, "writeoff": 0.0, "sold": 0.0,
        })

    base = ("FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
            "JOIN products p ON p.id = l.product_id "
            "WHERE d.type=? AND d.status='posted' AND d.date BETWEEN ? AND ? "
            "GROUP BY l.product_id")
    sel = "SELECT l.product_id pid, p.name, p.unit, "
    for dtype, key, expr in (
        ("prihod", "prihod", "SUM(l.qty)"),
        ("surplus", "surplus", "SUM(l.qty)"),
        ("writeoff", "writeoff", "SUM(l.qty)"),
        ("vydacha", "vydacha", "SUM(l.qty - l.qty_shelf)"),  # только складская часть
    ):
        for r in conn.execute(sel + expr + " q " + base, (dtype, date_from, date_to)):
            bucket(r)[key] += float(r["q"] or 0)
    for r in conn.execute(
        sel + "SUM(l.qty_to_wh) w, SUM(l.qty_sold) s " + base,
        ("sdacha", date_from, date_to),
    ):
        b = bucket(r)
        b["vozvrat"] += float(r["w"] or 0)
        b["sold"] += float(r["s"] or 0)
    rows = []
    for pid, b in data.items():
        inn = b["prihod"] + b["vozvrat"] + b["surplus"]
        out = b["vydacha"] + b["writeoff"]
        if inn < EPS and out < EPS and b["sold"] < EPS:
            continue
        rows.append({"product_id": pid, "name": b["name"], "unit": b["unit"],
                     "prihod": r2(b["prihod"]), "vozvrat": r2(b["vozvrat"]),
                     "surplus": r2(b["surplus"]), "vydacha": r2(b["vydacha"]),
                     "writeoff": r2(b["writeoff"]), "sold": r2(b["sold"]),
                     "net": r2(inn - out)})
    rows.sort(key=lambda x: x["name"])
    return {"rows": rows}


def suppliers_report(conn, date_from, date_to):
    """Поступления по поставщикам за период: поставок, кг, себестоимость."""
    _date_ok(date_from)
    _date_ok(date_to)
    rows = []
    t_kg = t_cost = 0.0
    for r in conn.execute(
        "SELECT COALESCE(s.name,'Без поставщика') name, COUNT(DISTINCT d.id) n, "
        "COALESCE(SUM(CASE WHEN p.unit='кг' THEN l.qty ELSE 0 END),0) kg, "
        "COALESCE(SUM(l.qty * l.purchase_price),0) cost "
        "FROM docs d JOIN doc_lines l ON l.doc_id = d.id "
        "JOIN products p ON p.id = l.product_id "
        "LEFT JOIN suppliers s ON s.id = d.supplier_id "
        "WHERE d.type='prihod' AND d.status='posted' AND d.date BETWEEN ? AND ? "
        "GROUP BY d.supplier_id ORDER BY cost DESC",
        (date_from, date_to),
    ):
        rows.append({"name": r["name"], "docs": r["n"], "kg": r2(r["kg"]),
                     "cost": r2(r["cost"])})
        t_kg += r["kg"]
        t_cost += r["cost"]
    return {"rows": rows, "totals": {"kg": r2(t_kg), "cost": r2(t_cost)}}


# ---------- ИИ-помощник ----------

_AM = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6, "июл": 7,
       "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}


def _asst_month(word):
    w = word.lower()
    for pref, num in sorted(_AM.items(), key=lambda x: -len(x[0])):
        if w.startswith(pref):
            return num
    return None


def _asst_parse(conn, text, today):
    """Из вопроса достаём период, город и тип события."""
    import re as _re
    from datetime import date as _date, timedelta as _td
    low = " " + text.lower().replace("ё", "е") + " "
    t = _date.fromisoformat(today)
    d1 = d2 = None
    label = ""
    if "послезавтра" in low:
        d1 = d2 = t + _td(days=2)
        label = "послезавтра"
    elif "завтра" in low:
        d1 = d2 = t + _td(days=1)
        label = "завтра"
    elif "сегодня" in low:
        d1 = d2 = t
        label = "сегодня"
    elif "выходн" in low or "субботу" in low or "воскресень" in low:
        sat = t + _td(days=(5 - t.weekday()) % 7)
        d1, d2 = sat, sat + _td(days=1)
        label = "в ближайшие выходные"
    elif "месяц" in low:
        d1, d2 = t, t + _td(days=30)
        label = "в ближайший месяц"
    elif "недел" in low:
        d1, d2 = t, t + _td(days=7)
        label = "на этой неделе"
    m = _re.search(r"(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?", low)
    if m and not d1:
        y = int(m.group(3) or t.year)
        if y < 100:
            y += 2000
        try:
            d1 = d2 = _date(y, int(m.group(2)), int(m.group(1)))
            label = d1.strftime("%d.%m")
        except ValueError:
            pass
    m = _re.search(r"(\d{1,2})\s+([а-я]+)", low)
    if m and not d1:
        mn = _asst_month(m.group(2))
        if mn:
            try:
                d1 = d2 = _date(t.year, mn, int(m.group(1)))
                label = d1.strftime("%d.%m")
            except ValueError:
                pass
    def month_word(w):
        """Строгое распознавание месяца: «магазин»/«магадан» — не май."""
        if w in ("май", "мае", "мая"):
            return 5
        strict = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "июн": 6, "июл": 7,
                  "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}
        for pref, num in strict.items():
            if w.startswith(pref) and len(w) <= len(pref) + 2:
                return num
        return None

    if not d1:
        # месяц без числа: «в сентябре» — весь месяц
        import calendar as _cal
        for w in _re.findall(r"[а-я]{3,}", low):
            mn = month_word(w)
            if mn:
                y = t.year if mn >= t.month else t.year + 1
                d1 = _date(y, mn, 1)
                d2 = _date(y, mn, _cal.monthrange(y, mn)[1])
                label = "в " + ["январе", "феврале", "марте", "апреле", "мае", "июне",
                                "июле", "августе", "сентябре", "октябре", "ноябре",
                                "декабре"][mn - 1]
                break
    if not d1:
        d1, d2 = t, t + _td(days=14)
        label = "в ближайшие две недели"

    # город: слова вопроса против списка городов из базы
    cities = [r["c"] for r in conn.execute(
        "SELECT DISTINCT city c FROM events WHERE city != '' "
        "UNION SELECT DISTINCT city FROM points WHERE city != ''")]
    city = None
    words = _re.findall(r"[а-яе-]{4,}", low)
    stop = {"ярмарк", "ярмарка", "ярмарки", "город", "города", "мероприят", "поехать",
            "можно", "куда", "какие", "есть", "недел", "выходные", "сельхоз", "фестивал"}
    for w in sorted(words, key=len, reverse=True):
        if any(w.startswith(s) for s in stop) or month_word(w):
            continue
        # пробуем самое длинное совпадение: «казани» → «казан» → Казань, не Казаково
        for cut in (0, 1, 2, 3):
            base = w[:len(w) - cut]
            if len(base) < 4:
                break
            hits = [c for c in cities
                    if c.lower().replace("ё", "е").startswith(base)]
            if hits:
                city = min(hits, key=len)  # самое короткое имя = самое точное
                break
        if city:
            break

    etypes = None
    tlabel = ""
    if "коммерч" in low or "выстав" in low:
        etypes, tlabel = ["Ярмарка коммерческая"], "коммерческие ярмарки"
    elif "сельхоз" in low:
        etypes, tlabel = ["Сельхозярмарка"], "сельхозярмарки"
    elif "фестивал" in low:
        etypes, tlabel = ["Фестиваль"], "фестивали"
    elif "день города" in low or "дни городов" in low or "деревн" in low or "села" in low:
        etypes, tlabel = ["День города/села"], "дни городов"
    elif "праздник" in low:
        etypes, tlabel = ["Праздник"], "праздники"
    elif "ярмарк" in low:
        etypes, tlabel = ["Сельхозярмарка", "Ярмарка коммерческая"], "ярмарки"
    return d1.isoformat(), d2.isoformat(), city, etypes, label, tlabel


def _asst_events(conn, d1, d2, city, etypes, limit=15):
    q = ("SELECT e.*, u.first_name || ' ' || u.last_name owner_name "
         "FROM events e LEFT JOIN users u ON u.id = e.owner_user_id "
         "WHERE e.date_from <= ? AND COALESCE(e.date_to, e.date_from) >= ?")
    args = [d2, d1]
    if city:
        q += " AND e.city = ?"
        args.append(city)
    if etypes:
        q += " AND e.etype IN (%s)" % ",".join("?" * len(etypes))
        args.extend(etypes)
    # события с точными датами интереснее «годовых» площадок — они выше
    q += (" ORDER BY CASE WHEN julianday(COALESCE(e.date_to, e.date_from)) - "
          "julianday(e.date_from) > 45 THEN 1 ELSE 0 END, e.date_from LIMIT ?")
    args.append(limit)
    out = []
    for e in conn.execute(q, args):
        booked = conn.execute(
            "SELECT u.first_name || ' ' || u.last_name n FROM bookings b "
            "JOIN users u ON u.id = b.user_id "
            "WHERE b.kind='event' AND b.ref_id=? LIMIT 1", (e["id"],)).fetchone()
        out.append({**dict(e), "busy": (booked["n"] if booked else e["owner_name"])})
    return out


def _asst_format(events, label, city, tlabel):
    where = f" (город: {city})" if city else ""
    what = tlabel or "мероприятия"
    if not events:
        return (f"{label[:1].upper()}{label[1:]}{where} — {what} в базе не нашлись. "
                "Попробуй другой период или город, например: «куда поехать в выходные?»")

    def fd(s):
        return f"{s[8:10]}.{s[5:7]}"

    lines = []
    for e in events:
        dts = fd(e["date_from"])
        if e["date_to"] and e["date_to"] != e["date_from"]:
            dts += "–" + fd(e["date_to"])
        status = f"занято: {e['busy']}" if e["busy"] else "свободно"
        lines.append(f"• {dts} · {e['name']} ({e['city']}) — {status}")
    head = f"Вот {what} {label}{where}:"
    tail = "\n\nОткрыть детали и забронировать можно во вкладке «Точки», карта — кнопкой «Карта»."
    return head + "\n" + "\n".join(lines) + tail


def _asst_llm(messages, ctx_text, today):
    import httpx as _httpx
    from app import config as _cfg
    sys_prompt = (
        "Ты — помощник команды выездной розничной торговли Yoggu (драже, вяленые ягоды, "
        f"сладости). Сегодня {today}. Команда ездит по ярмаркам, фестивалям и праздникам "
        "и продаёт товар с точек. Отвечай кратко, по-русски, дружелюбно. Ниже — данные из "
        "базы мероприятий приложения, найденные по вопросу. Отвечай ТОЛЬКО по этим данным, "
        "не выдумывай события; если данных мало — скажи прямо и предложи, как "
        "переформулировать. Даты пиши как дд.мм.\n\nДанные:\n" + ctx_text)
    msgs = [{"role": m["role"], "content": str(m.get("content", ""))[:2000]}
            for m in messages[-12:] if m.get("role") in ("user", "assistant")]
    r = _httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": _cfg.ANTHROPIC_API_KEY,
                 "anthropic-version": "2023-06-01"},
        json={"model": _cfg.ASSISTANT_MODEL, "max_tokens": 700,
              "system": sys_prompt, "messages": msgs},
        timeout=30)
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json().get("content", []))


def assistant_reply(conn, user, messages, today):
    from app import config as _cfg
    question = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            question = str(m.get("content", ""))
            break
    d1, d2, city, etypes, label, tlabel = _asst_parse(conn, question, today)
    events = _asst_events(conn, d1, d2, city, etypes)
    base = _asst_format(events, label, city, tlabel)
    if _cfg.ANTHROPIC_API_KEY:
        try:
            ctx = "\n".join(
                f"{e['date_from']}..{e['date_to'] or e['date_from']} | {e['etype']} | "
                f"{e['name']} | {e['city']} | "
                f"{'занято: ' + e['busy'] if e['busy'] else 'свободно'}"
                for e in events) or "(по запросу ничего не найдено)"
            return _asst_llm(messages, ctx, today)
        except Exception:  # noqa: BLE001 — LLM недоступен, отвечаем данными
            return base
    return base


# ---------- напоминания ----------

def hands_nonzero(conn, seller_id):
    r = conn.execute(
        "SELECT COALESCE(SUM(qty_hands),0) q FROM seller_stock WHERE seller_id=?", (seller_id,)
    ).fetchone()
    return float(r["q"]) > EPS


def incass_exists(conn, seller_id, date):
    r = conn.execute(
        "SELECT 1 FROM docs WHERE type='incass' AND status='posted' AND seller_id=? AND date=? LIMIT 1",
        (seller_id, date),
    ).fetchone()
    return r is not None


def mark_reminded(conn, uid, local_date):
    with _lock, conn:
        conn.execute("UPDATE users SET last_reminded=? WHERE id=?", (local_date, uid))
