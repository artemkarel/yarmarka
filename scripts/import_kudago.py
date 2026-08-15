# -*- coding: utf-8 -*-
"""Фестивали и праздники из открытого API KudaGo (Москва, СПб, Екатеринбург,
Нижний Новгород, Казань). Только будущие, повторный запуск дубли не создаёт.
Запуск: python scripts/import_kudago.py
"""
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db, services  # noqa: E402

CITIES = {"msk": "Москва", "spb": "Санкт-Петербург", "ekb": "Екатеринбург",
          "nnv": "Нижний Новгород", "kzn": "Казань"}
CATS = {"festival": "Фестиваль", "holiday": "Праздник",
        "yarmarki-razvlecheniya-yarmarki": "Ярмарка коммерческая"}
API = "https://kudago.com/public-api/v1.4/events/"


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def main():
    conn = db.get()
    fake_user = {"id": 0, "role": "admin"}
    now = int(time.time())
    added = skipped = 0
    with httpx.Client(timeout=30) as cli:
        for loc, city in CITIES.items():
            for cat, etype in CATS.items():
                url = (f"{API}?categories={cat}&location={loc}&actual_since={now}"
                       f"&fields=title,dates,place,description&expand=place&page_size=100")
                while url:
                    data = cli.get(url).json()
                    for ev in data.get("results", []):
                        # ближайший будущий диапазон дат
                        best = None
                        for d in ev.get("dates", []):
                            if (d.get("start") or 0) >= now - 86400:
                                best = d
                                break
                        if not best:
                            continue
                        def iso(tsv):
                            return datetime.fromtimestamp(
                                min(max(tsv, 0), 4102444800),
                                tz=timezone.utc).strftime("%Y-%m-%d")
                        d1 = iso(best["start"])
                        d2 = iso(best.get("end") or best["start"])
                        if d2 > "2027-12-31":
                            d2 = "2027-12-31"
                        name = strip_tags(ev.get("title", "")).capitalize()
                        if not name:
                            continue
                        dup = conn.execute(
                            "SELECT 1 FROM events WHERE name=? AND city=? AND date_from=?",
                            (name, city, d1)).fetchone()
                        if dup:
                            skipped += 1
                            continue
                        place = ev.get("place") or {}
                        comment = " • ".join(x for x in [
                            strip_tags(place.get("title", "")),
                            strip_tags(place.get("address", "")),
                            strip_tags(ev.get("description", ""))[:160],
                            "kudago.com — уточнить формат участия"] if x)
                        services.event_save(conn, fake_user, None, name, etype, city,
                                            d1, d2, None, comment[:480])
                        added += 1
                    url = data.get("next")
                    time.sleep(0.3)
    print(f"добавлено: {added}, дублей: {skipped}")


if __name__ == "__main__":
    main()
