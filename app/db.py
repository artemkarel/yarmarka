"""SQLite: соединение и схема."""
import sqlite3
import threading

from . import config

_conn = None
_conn_lock = threading.Lock()

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


def get():
    global _conn
    with _conn_lock:
        if _conn is None:
            config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.executescript(SCHEMA)
            _migrate(_conn)
            _conn.commit()
    return _conn


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
    """)
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
