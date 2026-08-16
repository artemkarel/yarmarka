"""SQLite: соединения и схема.

Соединение — на каждый поток своё (threading.local): одно общее соединение
между потоками сегфолтит CPython при параллельных чтениях. WAL даёт
многопоточное чтение без блокировок, записи сериализует services._lock.
"""
import sqlite3
import threading

from . import config

_local = threading.local()
_init_lock = threading.Lock()
_schema_ready = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'seller',      -- seller | keeper | admin
  tz TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_reminded TEXT,                       -- локальная дата последнего напоминания
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',      -- группа (ДРАЖЕ, ХАЛВА, ...)
  unit TEXT NOT NULL DEFAULT 'кг',          -- кг | шт
  purchase_price REAL NOT NULL DEFAULT 0,   -- закупочная
  retail_price REAL NOT NULL DEFAULT 0,     -- розничная
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suppliers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,        -- prihod|initial|inventory|vydacha|sdacha|incass|cash
  ts TEXT NOT NULL,          -- момент создания, UTC ISO
  date TEXT NOT NULL,        -- дата документа YYYY-MM-DD (локальная)
  seller_id INTEGER,
  supplier_id INTEGER,       -- для прихода
  created_by INTEGER NOT NULL,
  amount REAL NOT NULL DEFAULT 0,  -- сумма документа (розница / терминал / наличные)
  money REAL NOT NULL DEFAULT 0,   -- влияние на долг продавца со знаком (+ должен больше)
  comment TEXT
);
CREATE TABLE IF NOT EXISTS doc_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 0,          -- приход/выдача(итого)/факт при инвентаризации
  qty_shelf REAL NOT NULL DEFAULT 0,    -- выдача: сколько из qty взято с полки
  qty_to_wh REAL NOT NULL DEFAULT 0,    -- сдача: вернул на склад
  qty_to_shelf REAL NOT NULL DEFAULT 0, -- сдача: убрал на свою полку
  qty_sold REAL NOT NULL DEFAULT 0,     -- сдача: продано
  qty_before REAL,                      -- инвентаризация/остатки: учётное до
  purchase_price REAL NOT NULL DEFAULT 0,
  retail_price REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docs_seller ON docs(seller_id, type, date);
CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type, date);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON doc_lines(doc_id);
CREATE TABLE IF NOT EXISTS stock(
  product_id INTEGER PRIMARY KEY,
  qty REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seller_stock(
  seller_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_hands REAL NOT NULL DEFAULT 0,    -- на руках (уехал торговать)
  qty_shelf REAL NOT NULL DEFAULT 0,    -- на личной полке на складе
  PRIMARY KEY(seller_id, product_id)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  etype TEXT NOT NULL DEFAULT '',      -- праздник / ярмарка / фестиваль / ...
  city TEXT NOT NULL DEFAULT '',
  date_from TEXT NOT NULL,
  date_to TEXT,
  owner_user_id INTEGER,               -- кто туда ездит
  comment TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_dates ON events(date_from, date_to);
CREATE TABLE IF NOT EXISTS points(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ptype TEXT NOT NULL DEFAULT '',      -- рынок / ТЦ / сеть / магазин / ...
  city TEXT NOT NULL DEFAULT '',
  address TEXT,
  phone TEXT,
  email TEXT,
  owner_user_id INTEGER,               -- кто туда ездит (владелец точки)
  comment TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- point | event
  ref_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,            -- кто едет (бронь на него)
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  comment TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_ref ON bookings(kind, ref_id, date_from);
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Прочее',
  amount REAL NOT NULL,
  comment TEXT,
  created_by INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def _connect():
    conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    # PRAGMA-настройки действуют на соединение — ставим каждому
    conn.execute("PRAGMA foreign_keys=ON")
    # WAL позволяет ослабить fsync без риска потери целостности
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA cache_size=-8000")   # 8 МБ страничного кэша
    conn.execute("PRAGMA temp_store=MEMORY")
    # mmap не включаем: при смене процессов (деплой) он даёт ложные
    # «database disk image is malformed» на чтении, а выгоды при базе
    # в несколько МБ нет — страничный кэш и так держит её целиком
    return conn


def get():
    global _schema_ready
    conn = getattr(_local, "conn", None)
    if conn is None:
        with _init_lock:
            config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            conn = _connect()
            if not _schema_ready:
                conn.executescript(SCHEMA)
                _migrate(conn)
                conn.commit()
                _schema_ready = True
        _local.conn = conn
    return conn


def _migrate(conn):
    """Лёгкие миграции для баз, созданных прежними версиями схемы."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(points)")}
    if "phone" not in cols:
        conn.execute("ALTER TABLE points ADD COLUMN phone TEXT")
    if "email" not in cols:
        conn.execute("ALTER TABLE points ADD COLUMN email TEXT")

    dcols = {r["name"] for r in conn.execute("PRAGMA table_info(docs)")}
    if "status" not in dcols:
        # статусы документов: draft (черновик, остатки не трогает) | posted | void (сторно)
        conn.execute("ALTER TABLE docs ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'")
    if "parent_id" not in dcols:
        conn.execute("ALTER TABLE docs ADD COLUMN parent_id INTEGER")

    scols = {r["name"] for r in conn.execute("PRAGMA table_info(seller_stock)")}
    if "avg_cost" not in scols:
        conn.execute("ALTER TABLE seller_stock ADD COLUMN avg_cost REAL NOT NULL DEFAULT 0")
    if "avg_retail" not in scols:
        # цена продажи фиксируется при выдаче: смена цен не пересчитывает
        # товар, который уже на руках у продавцов
        conn.execute("ALTER TABLE seller_stock ADD COLUMN avg_retail REAL NOT NULL DEFAULT 0")
        conn.execute("UPDATE seller_stock SET avg_retail = COALESCE("
                     "(SELECT retail_price FROM products p WHERE p.id = product_id), 0)")

    ucols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "last_seen" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN last_seen TEXT")
    if "trades" not in ucols:
        # совладелец/админ «выезжает торговать»: попадает в выдачу-приём товара
        # и получает переключатель интерфейса продавца в «Ещё»
        conn.execute("ALTER TABLE users ADD COLUMN trades INTEGER NOT NULL DEFAULT 0")
    if "max_id" not in ucols:
        # один человек — один аккаунт: id в MAX живёт рядом с Telegram-id
        conn.execute("ALTER TABLE users ADD COLUMN max_id INTEGER")
        conn.execute("ALTER TABLE users ADD COLUMN last_platform TEXT NOT NULL DEFAULT ''")
        conn.execute("UPDATE users SET max_id = tg_id - ?, last_platform='max'"
                     " WHERE tg_id >= ?", (config.MAX_UID_OFFSET, config.MAX_UID_OFFSET))
        conn.execute("UPDATE users SET last_platform='tg' WHERE tg_id > 0 AND tg_id < ?",
                     (config.MAX_UID_OFFSET,))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_max ON users(max_id)"
                 " WHERE max_id IS NOT NULL")
    _merge_cross_platform_dupes(conn)

    conn.executescript("""
    CREATE TABLE IF NOT EXISTS lots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      qty_left REAL NOT NULL,
      unit_cost REAL NOT NULL,
      src_doc_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lots_product ON lots(product_id, id);
    CREATE TABLE IF NOT EXISTS lot_moves(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty REAL NOT NULL,
      unit_cost REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lotmoves_doc ON lot_moves(doc_id);
    CREATE TABLE IF NOT EXISTS product_groups(
      name TEXT PRIMARY KEY,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS geo_cache(
      city TEXT PRIMARY KEY,
      lat REAL,
      lon REAL
    );
    """)
    # группы товаров: нормализуем регистр («ДРАЖЕ» → «Драже») и заводим порядок
    if not conn.execute("SELECT 1 FROM product_groups LIMIT 1").fetchone():
        raw = [r["g"] for r in conn.execute(
            "SELECT DISTINCT group_name g FROM products WHERE group_name != '' "
            "ORDER BY group_name")]
        seen = []
        for g in raw:
            norm = g.strip()
            norm = (norm[:1].upper() + norm[1:].lower()) if norm else norm
            conn.execute("UPDATE products SET group_name=? WHERE group_name=?", (norm, g))
            if norm not in seen:
                conn.execute("INSERT OR IGNORE INTO product_groups(name, sort) VALUES(?,?)",
                             (norm, len(seen)))
                seen.append(norm)
    _fifo_start(conn)


def _merge_cross_platform_dupes(conn):
    """Один человек — один аккаунт: пары «тот же ФИО в Telegram и в MAX»
    сливаются в Telegram-аккаунт (роль и история сохраняются у него)."""
    max_only = conn.execute(
        "SELECT * FROM users WHERE tg_id >= ?", (config.MAX_UID_OFFSET,)).fetchall()
    if not max_only:
        return
    # сравнение ФИО — в Python: lower() в SQLite не понимает кириллицу
    tg_users = conn.execute(
        "SELECT * FROM users WHERE tg_id > 0 AND tg_id < ? AND max_id IS NULL",
        (config.MAX_UID_OFFSET,)).fetchall()
    key = lambda r: (r["first_name"].strip().lower(), r["last_name"].strip().lower())
    by_name = {key(t): t for t in tg_users}
    for m in max_only:
        t = by_name.pop(key(m), None)
        if t:
            merge_users(conn, t["id"], m["id"], m["max_id"])


def merge_users(conn, keep_id, drop_id, max_id):
    """Переносит всю историю drop-аккаунта на keep и удаляет дубль."""
    for tbl, col in (("docs", "seller_id"), ("docs", "created_by"),
                     ("bookings", "user_id"), ("bookings", "created_by"),
                     ("events", "owner_user_id"), ("events", "created_by"),
                     ("points", "owner_user_id"), ("points", "created_by"),
                     ("expenses", "created_by")):
        conn.execute(f"UPDATE {tbl} SET {col}=? WHERE {col}=?", (keep_id, drop_id))
    # товар на руках/полке: количества складываем, себестоимость — взвешенно
    for r in conn.execute("SELECT * FROM seller_stock WHERE seller_id=?",
                          (drop_id,)).fetchall():
        ex = conn.execute(
            "SELECT * FROM seller_stock WHERE seller_id=? AND product_id=?",
            (keep_id, r["product_id"])).fetchone()
        if ex:
            hands = ex["qty_hands"] + r["qty_hands"]
            cost = ((ex["qty_hands"] * ex["avg_cost"] + r["qty_hands"] * r["avg_cost"])
                    / hands) if hands > 0.0001 else ex["avg_cost"]
            conn.execute(
                "UPDATE seller_stock SET qty_hands=?, qty_shelf=?, avg_cost=?"
                " WHERE seller_id=? AND product_id=?",
                (hands, ex["qty_shelf"] + r["qty_shelf"], cost, keep_id, r["product_id"]))
            conn.execute("DELETE FROM seller_stock WHERE seller_id=? AND product_id=?",
                         (drop_id, r["product_id"]))
        else:
            conn.execute("UPDATE seller_stock SET seller_id=? WHERE seller_id=?"
                         " AND product_id=?", (keep_id, drop_id, r["product_id"]))
    conn.execute("UPDATE users SET max_id=NULL WHERE id=?", (drop_id,))
    conn.execute("DELETE FROM users WHERE id=?", (drop_id,))
    conn.execute("UPDATE users SET max_id=?, last_platform='max' WHERE id=?",
                 (max_id, keep_id))


def _fifo_start(conn):
    # FIFO-старт для баз, живших без партий: остатки склада превращаем в стартовые партии
    has_lots = conn.execute("SELECT 1 FROM lots LIMIT 1").fetchone()
    if not has_lots:
        for r in conn.execute(
            "SELECT s.product_id, s.qty, p.purchase_price FROM stock s "
            "JOIN products p ON p.id = s.product_id WHERE s.qty > 0.001"
        ).fetchall():
            conn.execute(
                "INSERT INTO lots(product_id, qty_left, unit_cost, src_doc_id, created_at) "
                "VALUES(?,?,?,NULL, datetime('now'))",
                (r["product_id"], r["qty"], r["purchase_price"]),
            )
