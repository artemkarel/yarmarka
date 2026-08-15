# -*- coding: utf-8 -*-
"""Импорт коммерческих выставок-ярмарок с exponet.ru (Россия, предстоящие).

Берём рубрику «Ярмарки» целиком, из «Еда/HoReCa» и «Товары народного
потребления» — только близкие к продуктам/подаркам события. Повторный запуск
дубли не создаёт. Запуск: python scripts/import_exponet.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db, services  # noqa: E402

BASE = "https://www.exponet.ru"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) yarmarka-import"}

TOPICS = [
    ("fairs", None),  # ярмарки — берём все
    ("furniture", re.compile(  # «Еда, напитки, HoReCa»
        r"(?i)продукт|пищев|продовол|кондитер|сладо|мёд|мед\b|фермер|вкус|гастро|напитк")),
    ("customergoods", re.compile(r"(?i)ярмарк|подарк|подаро|новогодн|рождеств|сувенир")),
    ("agriculture", re.compile(  # «Сельское хозяйство, пищевая промышленность»
        r"(?i)продукт|пищев|продовол|кондитер|сладо|мёд|мед\b|фермер|агро|урожа"
        r"|ярмарк|гастро|напитк|сыр|органик|эко")),
    ("moda", re.compile(r"(?i)ярмарк|подарк|подаро|новогодн|рождеств|сувенир|маркет")),
    ("cultureart", re.compile(r"(?i)ярмарк|маркет|блошин|вернисаж")),
]

ROW_RE = re.compile(
    r"<td[^>]*>\s*(\d{2}\.\d{2})<br>(\d{2}\.\d{2}\.\d{4})<!-- -->.*?"
    r"<TD[^>]*>\s*(?:<A HREF=\"([^\"]+)\">)?<b>([^<]+)</b>(?:</A>)?\s*"
    r"<b>\s*\(([^)]+)\)</b>(?:<br>([^<]*))?",
    re.S,
)


def clean_city(raw):
    s = re.sub(r"(?i)^(г|пос|пгт|с|д)\.\s*", "", str(raw).strip()).strip()
    return s


def parse_topic(cli, topic):
    url = f"{BASE}/exhibitions/countries/rus/topics/{topic}/dates/future/index.ru.html"
    r = cli.get(url)
    r.raise_for_status()
    s = r.content.decode("cp1251", errors="replace")
    out = []
    for m in ROW_RE.finditer(s):
        d1, d2, href, name, city, descr = m.groups()
        dd, mm = d1.split(".")
        d2p = d2.split(".")
        date_to = f"{d2p[2]}-{d2p[1]}-{d2p[0]}"
        # начало: тот же год, а 28.12–05.01 значит прошлый
        date_from = f"{d2p[2]}-{mm}-{dd}"
        if date_from > date_to:
            date_from = f"{int(d2p[2]) - 1}-{mm}-{dd}"
        out.append({
            "name": re.sub(r"\s*-\s*\d{4}$", "", name.strip()),
            "city": clean_city(city),
            "date_from": date_from, "date_to": date_to,
            "descr": (descr or "").strip(),
            "url": (BASE + href) if href else "",
        })
    return out


def main():
    conn = db.get()
    fake_user = {"id": 0, "role": "admin"}
    added = skipped = 0
    with httpx.Client(headers=UA, timeout=30, follow_redirects=True) as cli:
        for topic, flt in TOPICS:
            for ev in parse_topic(cli, topic):
                if flt and not (flt.search(ev["name"]) or flt.search(ev["descr"])):
                    continue
                dup = conn.execute(
                    "SELECT 1 FROM events WHERE name=? AND city=? AND date_from=?",
                    (ev["name"], ev["city"], ev["date_from"])).fetchone()
                if dup:
                    skipped += 1
                    continue
                comment = " • ".join(x for x in [ev["descr"], ev["url"], "exponet.ru"] if x)
                services.event_save(conn, fake_user, None, ev["name"],
                                    "Ярмарка коммерческая", ev["city"],
                                    ev["date_from"], ev["date_to"], None, comment[:480])
                added += 1
    print(f"добавлено: {added}, дублей пропущено: {skipped}")
    print("итог по типам:", list(conn.execute(
        "SELECT etype, COUNT(*) FROM events GROUP BY etype")))


if __name__ == "__main__":
    main()
