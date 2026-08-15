# -*- coding: utf-8 -*-
"""Перенос собранных событий между базами без повторного скрапинга.

Экспорт:  python scripts/export_import_events.py export out.json "%citiesdays%" "%kudago%"
Импорт:   python scripts/export_import_events.py import out.json
Дедуп при импорте — по (name, city, date_from).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import db  # noqa: E402


def main():
    mode, path = sys.argv[1], sys.argv[2]
    conn = db.get()
    if mode == "export":
        pats = sys.argv[3:] or ["%"]
        rows = []
        for pat in pats:
            for r in conn.execute(
                "SELECT name, etype, city, date_from, date_to, comment FROM events "
                "WHERE comment LIKE ?", (pat,)):
                rows.append(dict(r))
        json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        print("экспортировано:", len(rows))
    else:
        rows = json.load(open(path, encoding="utf-8"))
        added = skipped = 0
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        with conn:
            for ev in rows:
                dup = conn.execute(
                    "SELECT 1 FROM events WHERE name=? AND city=? AND date_from=?",
                    (ev["name"], ev["city"], ev["date_from"])).fetchone()
                if dup:
                    skipped += 1
                    continue
                conn.execute(
                    "INSERT INTO events(name, etype, city, date_from, date_to, comment, "
                    "created_by, created_at) VALUES(?,?,?,?,?,?,0,?)",
                    (ev["name"], ev["etype"], ev["city"], ev["date_from"], ev["date_to"],
                     ev.get("comment"), now))
                added += 1
        print(f"импортировано: {added}, дублей: {skipped}")


if __name__ == "__main__":
    main()
