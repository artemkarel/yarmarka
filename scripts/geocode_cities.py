# -*- coding: utf-8 -*-
"""Геокодирование городов мероприятий и точек (Nominatim/OSM, 1 запрос/сек).

Координаты кладутся в geo_cache; ненайденные помечаются NULL, чтобы не
запрашивать повторно. Повторный запуск догеокодирует только новые города.
Запуск: python scripts/geocode_cities.py
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db  # noqa: E402

UA = {"User-Agent": "yarmarka-miniapp/1.0 (geocode cache)"}


def clean_city(city):
    """«муниципальное образование "город Екатеринбург"» → «Екатеринбург»."""
    s = str(city or "").strip()
    s = re.sub(r"[«»\"]", "", s)
    s = re.sub(r"(?i)^(муниципальн\w+\s+(образование|округ|район)|городской округ|"
               r"го|мо|г\.о\.)\s*", "", s).strip()
    s = re.sub(r"(?i)^(город|пгт|пос(ёлок|елок)?|с(ело)?|д(еревня)?|р\.п\.)[\s.]+", "", s)
    s = re.sub(r"(?i)\s*(муниципальн\w+\s+(округ|район)|городской округ|"
               r"сельское поселение|р-н|район)\s*$", "", s).strip()
    s = s.split("/")[0].split("(")[0].split(",")[0].strip()
    return s


def main():
    conn = db.get()
    cities = {r["c"] for r in conn.execute(
        "SELECT DISTINCT city c FROM events WHERE city != '' "
        "UNION SELECT DISTINCT city FROM points WHERE city != ''")}
    todo = [c for c in sorted(cities) if conn.execute(
        "SELECT 1 FROM geo_cache WHERE city=?", (c,)).fetchone() is None]
    print(f"городов всего: {len(cities)}, к геокодированию: {len(todo)}")
    found = miss = 0
    with httpx.Client(timeout=20, headers=UA) as cli:
        for i, city in enumerate(todo):
            q = clean_city(city)
            lat = lon = None
            if q:
                try:
                    r = cli.get("https://nominatim.openstreetmap.org/search",
                                params={"q": q + ", Россия", "format": "json", "limit": 1})
                    data = r.json()
                    if data:
                        lat, lon = float(data[0]["lat"]), float(data[0]["lon"])
                except Exception as e:  # noqa: BLE001
                    print("  ошибка:", city, e)
            conn.execute("INSERT OR REPLACE INTO geo_cache(city, lat, lon) VALUES(?,?,?)",
                         (city, lat, lon))
            conn.commit()
            if lat:
                found += 1
            else:
                miss += 1
            if (i + 1) % 20 == 0:
                print(f"  {i + 1}/{len(todo)}…")
            time.sleep(1.1)  # лимит Nominatim
    print(f"готово: найдено {found}, не найдено {miss}")


if __name__ == "__main__":
    main()
