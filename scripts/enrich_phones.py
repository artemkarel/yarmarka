# -*- coding: utf-8 -*-
"""Дотягиваем телефоны организаторов в комментарии событий.

- exponet: заходим на страницу события (ссылка лежит в comment) и берём телефон
- kudago: берём телефон площадки из открытого API
События, где телефон уже есть, не трогаем. Повторный запуск безопасен.
Запуск: python scripts/enrich_phones.py
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app import db  # noqa: E402

PHONE_RE = re.compile(r"(?:\+7|8)[\s(]*\d{3}[)\s]*[\d\s\-]{7,10}")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) yarmarka-import"}


def has_phone(text):
    return bool(PHONE_RE.search(text or ""))


def add_phone(conn, eid, comment, phones):
    phones = [re.sub(r"\s+", " ", p).strip() for p in phones][:2]
    if not phones:
        return False
    new = ((comment + " • ") if comment else "") + "тел: " + ", ".join(phones)
    conn.execute("UPDATE events SET comment=? WHERE id=?", (new[:600], eid))
    return True


def enrich_exponet(conn, cli):
    n = 0
    rows = list(conn.execute(
        "SELECT id, comment FROM events WHERE comment LIKE '%exponet%'"))
    for r in rows:
        c = r["comment"] or ""
        if has_phone(c):
            continue
        m = re.search(r"https://www\.exponet\.ru\S+", c)
        if not m:
            continue
        try:
            page = cli.get(m.group(0)).content.decode("cp1251", errors="replace")
        except Exception:  # noqa: BLE001
            continue
        phones = list(dict.fromkeys(PHONE_RE.findall(page)))
        if add_phone(conn, r["id"], c, phones):
            n += 1
        time.sleep(0.3)
    conn.commit()
    return n


def enrich_kudago(conn, cli):
    # телефоны площадок по названию события
    cities = ["msk", "spb", "ekb", "nnv", "kzn"]
    cats = ["festival", "holiday", "yarmarki-razvlecheniya-yarmarki"]
    now = int(time.time())
    title_phone = {}
    for loc in cities:
        for cat in cats:
            url = ("https://kudago.com/public-api/v1.4/events/?categories=" + cat +
                   f"&location={loc}&actual_since={now - 86400 * 30}"
                   "&fields=title,place&expand=place&page_size=100")
            while url:
                try:
                    data = cli.get(url).json()
                except Exception:  # noqa: BLE001
                    break
                for ev in data.get("results", []):
                    ph = ((ev.get("place") or {}).get("phone") or "").strip()
                    if ph:
                        title_phone[ev.get("title", "").strip().lower()] = ph
                url = data.get("next")
                time.sleep(0.3)
    n = 0
    for r in list(conn.execute(
            "SELECT id, name, comment FROM events WHERE comment LIKE '%kudago%'")):
        c = r["comment"] or ""
        if has_phone(c):
            continue
        ph = title_phone.get(r["name"].strip().lower())
        if ph and add_phone(conn, r["id"], c, [ph]):
            n += 1
    conn.commit()
    return n


def main():
    conn = db.get()
    with httpx.Client(headers=UA, timeout=25, follow_redirects=True) as cli:
        a = enrich_exponet(conn, cli)
        b = enrich_kudago(conn, cli)
    total = conn.execute(
        "SELECT COUNT(*) FROM events WHERE comment LIKE '%тел%' OR comment LIKE '%8 (%'"
        " OR comment LIKE '%+7%' OR comment LIKE '%8-9%' OR comment LIKE '%8 9%'").fetchone()[0]
    print(f"exponet: +{a}, kudago: +{b}; событий с телефоном в базе: {total}")


if __name__ == "__main__":
    main()
