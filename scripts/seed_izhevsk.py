# -*- coding: utf-8 -*-
"""События Ижевска и Удмуртии (visitudmurtia.org, афиши города).

Для событий без точного числа — период месяца и пометка «дата уточняется»,
как принято в базе. Повторный запуск дубли не создаёт.
Запуск: python scripts/seed_izhevsk.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import db, services  # noqa: E402

# город, название, тип, с, по, комментарий
EVENTS = [
    ("Ижевск", "Фестиваль «Музыкальная экспедиция»", "Фестиваль",
     "2026-08-21", "2026-08-23",
     "Ижевск, Воткинск, Сарапул • visitudmurtia.org"),
    ("Ижевск", "Рыжий фестиваль (дата уточняется)", "Фестиваль",
     "2026-09-01", "2026-09-30",
     "XX юбилейный, парк Космонавтов • обычно середина сентября • "
     "visitudmurtia.org — дату уточнить"),
    ("Ижевск", "Осенние сельскохозяйственные ярмарки (по выходным)",
     "Сельхозярмарка", "2026-09-05", "2026-10-31",
     "Центральная площадь и площадки районов • расписание публикует "
     "администрация Ижевска (izh.ru) — уточнить"),
    ("Ижевск", "Всемирный день пельменя (дата уточняется)", "Праздник",
     "2027-02-01", "2027-02-14",
     "Городской праздник-фестиваль еды, центр Ижевска • обычно начало февраля • "
     "дату уточнить у оргкомитета"),
]


def main():
    conn = db.get()
    fake_user = {"id": 0, "role": "admin"}
    added = skipped = 0
    for city, name, etype, d1, d2, comment in EVENTS:
        if conn.execute("SELECT 1 FROM events WHERE name=? AND city=?",
                        (name, city)).fetchone():
            skipped += 1
            continue
        services.event_save(conn, fake_user, None, name, etype, city, d1, d2,
                            None, comment)
        added += 1
    print(f"Ижевск: добавлено {added}, дублей {skipped}")


if __name__ == "__main__":
    main()
