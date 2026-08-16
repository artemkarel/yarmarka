# -*- coding: utf-8 -*-
"""Дни городов всей России из справочника citiesdays.ru.

Обходит алфавитный указатель, с каждой городской страницы берёт дату 2026 года
и правило («второе воскресенье июня»). Импортирует только будущие даты; города,
по которым в базе уже есть день города (например, из графиков администраций),
не трогает. Повторный запуск дубли не создаёт.
Запуск: python scripts/import_citydays.py
"""
import os
import re
import sys
import time
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db, services  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Macintosh) yarmarka-import"}
MONTHS = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6, "июл": 7,
          "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}
LETTERS = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ"

DATE_RE = re.compile(r"в 2026 г\.?\s*(?:отмечают\s*)?(\d{1,2})\s+([а-яё]+)", re.I)
RULE_RE = re.compile(r"-\s*([^<>]{5,60}?),\s*в 2026", re.I)


def month_num(word):
    w = word.lower()
    for pref, num in sorted(MONTHS.items(), key=lambda x: -len(x[0])):
        if w.startswith(pref):
            return num
    return None


def main():
    conn = db.get()
    fake_user = {"id": 0, "role": "admin"}
    today = date.today().isoformat()

    def has_cityday(city):
        return conn.execute(
            "SELECT 1 FROM events WHERE etype='День города/села' AND lower(city)=lower(?)",
            (city,)).fetchone() is not None

    cities = {}
    with httpx.Client(headers=UA, timeout=25, follow_redirects=True) as cli:
        for ch in LETTERS:
            try:
                r = cli.get(f"https://citiesdays.ru/letter/{ch}")
                for m in re.finditer(
                        r'href="(https?://citiesdays\.ru/([a-z0-9-]+)/[a-z0-9-]+)"[^>]*>'
                        r'([^<]{2,40})</a>', r.text):
                    url, region, name = m.group(1), m.group(2), m.group(3).strip()
                    # только Россия: справочник содержит и ua/by
                    if region in ("ua", "by") or "/letter/" in url or \
                            name.lower() in ("сегодня", "скоро"):
                        continue
                    cities[url] = name
            except Exception as e:  # noqa: BLE001
                print("буква", ch, "ошибка:", e)
            time.sleep(0.2)
        print("городов в указателе:", len(cities))

        added = skipped = missed = 0
        for i, (url, name) in enumerate(sorted(cities.items(), key=lambda x: x[1])):
            if has_cityday(name):
                skipped += 1
                continue
            try:
                page = cli.get(url).text
            except Exception:  # noqa: BLE001
                missed += 1
                continue
            m = DATE_RE.search(page)
            if not m:
                missed += 1
                time.sleep(0.2)
                continue
            d, mw = int(m.group(1)), m.group(2)
            mn = month_num(mw)
            if not mn or not 1 <= d <= 31:
                missed += 1
                time.sleep(0.2)
                continue
            iso = f"2026-{mn:02d}-{d:02d}"
            prelim = False
            if iso < today:
                # праздник в этом году уже прошёл — заводим на следующий год той же
                # датой с пометкой (правило вроде «вторая суббота» может сдвинуть её)
                iso = f"2027-{mn:02d}-{d:02d}"
                prelim = True
            rule = ""
            rm = RULE_RE.search(page)
            if rm:
                rule = re.sub(r"\s+", " ", rm.group(1)).strip()
            comment = " • ".join(x for x in [
                rule,
                "дата предварительная — по прошлому году" if prelim else "",
                "citiesdays.ru — дату уточнить у администрации"] if x)
            services.event_save(conn, fake_user, None, f"День города {name}",
                                "День города/села", name, iso, iso, None, comment)
            added += 1
            if added % 50 == 0:
                print(f"  добавлено {added}… ({i + 1}/{len(cities)})")
            time.sleep(0.2)
    print(f"итог: добавлено {added}, пропущено (есть/прошло) {skipped}, без даты {missed}")


if __name__ == "__main__":
    main()
