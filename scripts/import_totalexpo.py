# -*- coding: utf-8 -*-
"""Выставки-продажи с totalexpo.ru — посетительские тематики по всей России.

Цветы, дача-сад, зоовыставки, ремёсла, национальные ярмарки, подарки, мода,
детские, гастрономия, универсальные — всё, где можно встать с торговлей.
Только Россия и только будущие. Повторный запуск дубли не создаёт.
Запуск: python scripts/import_totalexpo.py
"""
import os
import re
import sys
import time
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db, services  # noqa: E402

BASE = "http://www.totalexpo.ru"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) yarmarka-import"}

# посетительские тематики (B2B-промышленность не берём)
THEMES = {
    3: "зоовыставка", 7: "дом и интерьер", 8: "досуг и увлечения",
    11: "культура и ремёсла", 16: "универсальная", 17: "национальная ярмарка",
    20: "семья и образ жизни", 21: "одежда и обувь", 24: "продукты и напитки",
    26: "потребительские товары и подарки", 29: "дача, сад, огород",
    45: "красота", 48: "сельское хозяйство", 49: "мир детства",
    51: "гастрономия",
}

TITLE_RE = re.compile(
    r"<title>\s*(.+?)\s*\(([^,()]+),\s*(\d{2})\.(\d{2})\.(\d{4})\s*-\s*"
    r"(\d{2})\.(\d{2})\.(\d{4})\)", re.S)
RUS_RE = re.compile(r"Страна.{0,300}?Россия", re.S)


def main():
    conn = db.get()
    fake_user = {"id": 0, "role": "admin"}
    today = date.today().isoformat()
    ids = {}  # expo_id -> тематика
    with httpx.Client(headers=UA, timeout=25, follow_redirects=True) as cli:
        for tid, tname in THEMES.items():
            try:
                page = cli.get(f"{BASE}/theme/{tid}.aspx").text
            except Exception as e:  # noqa: BLE001
                print("тема", tid, "ошибка:", e)
                continue
            for m in re.finditer(r'href="/expo/(\d+)\.aspx"', page):
                ids.setdefault(m.group(1), tname)
            time.sleep(0.3)
        print("карточек к разбору:", len(ids))

        added = skipped = foreign = 0
        for i, (eid, tname) in enumerate(sorted(ids.items())):
            try:
                page = cli.get(f"{BASE}/expo/{eid}.aspx").text
            except Exception:  # noqa: BLE001
                continue
            m = TITLE_RE.search(page)
            if not m or not RUS_RE.search(page):
                foreign += 1
                time.sleep(0.3)
                continue
            name = re.sub(r"\s+", " ", m.group(1)).strip()
            name = re.sub(r"\s*[-–]?\s*20\d\d$", "", name)
            city = m.group(2).strip()
            d1 = f"{m.group(5)}-{m.group(4)}-{m.group(3)}"
            d2 = f"{m.group(8)}-{m.group(7)}-{m.group(6)}"
            if d2 < today or d2 > "2027-12-31" or not name:
                skipped += 1
                time.sleep(0.3)
                continue
            if conn.execute(
                    "SELECT 1 FROM events WHERE name=? AND city=? AND date_from=?",
                    (name, city, d1)).fetchone():
                skipped += 1
                time.sleep(0.3)
                continue
            comment = " • ".join([
                tname, f"{BASE}/expo/{eid}.aspx",
                "totalexpo.ru — уточнить условия участия"])
            services.event_save(conn, fake_user, None, name, "Ярмарка коммерческая",
                                city, d1, d2, None, comment[:480])
            added += 1
            if added % 25 == 0:
                print(f"  добавлено {added}… ({i + 1}/{len(ids)})")
            time.sleep(0.3)
    print(f"итог: добавлено {added}, пропущено/дубли {skipped}, не Россия/без даты {foreign}")


if __name__ == "__main__":
    main()
