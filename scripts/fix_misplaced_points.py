# -*- coding: utf-8 -*-
"""Разовая чистка: строки xlsx с датами, ошибочно осевшие в постоянных точках,
переезжают в мероприятия (сидер с новым парсером), сами точки удаляются.

Запуск: python scripts/fix_misplaced_points.py [путь_к_xlsx]
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import openpyxl  # noqa: E402

from app import db  # noqa: E402
import seed_places  # noqa: E402


def main():
    # 1) пересев: новый парсер добавит события, которых раньше не понял
    seed_places.main()

    # 2) точки, чьи исходные строки на самом деле содержат даты, — удаляем
    conn = db.get()
    wb = openpyxl.load_workbook(seed_places.XLSX, data_only=True)
    dated = set()
    for sheet in seed_places.EVENT_SHEETS:
        for row in wb[sheet].iter_rows(min_row=2, values_only=True):
            (region, mun, place, name, channel, etype, fmt, period, freq, cost,
             contact, phone, site, source, status, notes) = (list(row) + [None] * 16)[:16]
            if not name:
                continue
            if seed_places.parse_periods(period):
                dated.add((str(name).strip(), seed_places.short_city(mun)))
    removed = 0
    for name, city in dated:
        for r in conn.execute("SELECT id FROM points WHERE name=? AND city=?", (name, city)):
            n_bk = conn.execute(
                "SELECT COUNT(*) FROM bookings WHERE kind='point' AND ref_id=?",
                (r["id"],)).fetchone()[0]
            if n_bk:
                print(f"  ! точка {name} ({city}) с бронями — оставлена")
                continue
            conn.execute("DELETE FROM points WHERE id=?", (r["id"],))
            removed += 1
    conn.commit()
    print(f"удалено ошибочных точек: {removed}")
    print("точки по типам:", list(conn.execute(
        "SELECT ptype, COUNT(*) FROM points GROUP BY ptype")))
    print("события по типам:", list(conn.execute(
        "SELECT etype, COUNT(*) FROM events GROUP BY etype")))


if __name__ == "__main__":
    main()
