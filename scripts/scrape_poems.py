#!/usr/bin/env python3
"""Deterministic scraper for the Finish Hyperion app.

Fetches Keats' `Hyperion: A Fragment` (Books I-III) and `The Fall of
Hyperion: A Dream` (Cantos I-II) from keats-poems.com, strips the site's
embedded margin line numbers, validates line counts against the canonical
totals, and writes `public/poems.json`.

Raw HTML is cached under `data/raw/` so re-runs are reproducible offline.

Usage:  uv run scripts/scrape_poems.py
"""

from __future__ import annotations

import html as htmllib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "public" / "poems.json"

PAGES = {
    "hyperion-book-i": "http://keats-poems.com/book-i/",
    "hyperion-book-ii": "http://keats-poems.com/hyperion-book-ii/",
    "hyperion-book-iii": "http://keats-poems.com/hyperion-book-iii/",
    "fall-of-hyperion": "http://keats-poems.com/the-fall-of-hyperion-a-dream/",
}

# Canonical line totals (1898 Complete Works / standard editions) used as a
# sanity check on the scrape. A small tolerance absorbs edition variance.
EXPECTED = {
    ("hyperion", "book-1"): 357,
    ("hyperion", "book-2"): 391,
    ("hyperion", "book-3"): 136,
    ("fall-of-hyperion", "canto-1"): 468,
    ("fall-of-hyperion", "canto-2"): 61,
}
TOLERANCE = 6

BR_RE = re.compile(r"<br\s*/?>", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<script\b.*?</script>", re.I | re.S)
# Trailing printed line number: run of whitespace/nbsp then digits at line end.
MARGIN_NUM_RE = re.compile(r"[\s ]{2,}\d{1,4}\s*$")
BLOCK_RE = re.compile(r"<(h[1-6]|p)\b[^>]*>(.*?)</\1>", re.I | re.S)
CANTO_RE = re.compile(r"^CANTO\s+([IVXLC]+)\s*$", re.I)
# Editorial matter appended by the site, not part of Keats' text.
EDITORIAL_RE = re.compile(r"^(THE END\.?|published \d{4}.*|written \d{4}.*)$", re.I)


def fetch(slug: str, url: str) -> str:
    path = RAW_DIR / f"{slug}.html"
    if path.exists():
        return path.read_text(encoding="utf-8")
    print(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (poem-scraper)"})
    with urllib.request.urlopen(req) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(raw, encoding="utf-8")
    return raw


def entry_content(html: str) -> str:
    """Return the inner HTML of the post's entry-content div (depth-matched)."""
    m = re.search(r'<div[^>]*class="[^"]*\bentry-content\b[^"]*"[^>]*>', html)
    if not m:
        raise ValueError("entry-content div not found")
    start = m.end()
    depth = 1
    for tag in re.finditer(r"<div\b|</div>", html[start:], re.I):
        depth += 1 if tag.group(0).lower().startswith("<div") else -1
        if depth == 0:
            return html[start : start + tag.start()]
    raise ValueError("unbalanced entry-content div")


def clean_line(fragment: str) -> str:
    text = TAG_RE.sub("", fragment)
    text = htmllib.unescape(text)
    text = text.replace(" ", " ")
    text = MARGIN_NUM_RE.sub("", text.rstrip())
    # Collapse internal runs of 3+ spaces left over from number padding.
    text = re.sub(r" {3,}", " ", text)
    return text.strip()


def parse_stanzas(content: str) -> list[list[str]]:
    """Extract stanzas (verse paragraphs) as lists of cleaned lines."""
    content = SCRIPT_RE.sub("", content)
    stanzas: list[list[str]] = []
    for m in BLOCK_RE.finditer(content):
        lines = [clean_line(part) for part in BR_RE.split(m.group(2))]
        lines = [ln for ln in lines if ln and not EDITORIAL_RE.match(ln)]
        if lines:
            stanzas.append(lines)
    return stanzas


def drop_title_blocks(stanzas: list[list[str]], title_words: tuple[str, ...]) -> list[list[str]]:
    """Remove leading one-line blocks that repeat the poem/section title."""
    while stanzas and len(stanzas[0]) == 1:
        first = stanzas[0][0].upper()
        if any(w in first for w in title_words) and len(first) < 60:
            stanzas.pop(0)
        else:
            break
    return stanzas


def split_cantos(stanzas: list[list[str]]) -> dict[str, list[list[str]]]:
    """Split the Fall of Hyperion stanza stream on CANTO heading lines."""
    roman = {"I": "canto-1", "II": "canto-2"}
    sections: dict[str, list[list[str]]] = {}
    current: str | None = None
    for stanza in stanzas:
        head = CANTO_RE.match(stanza[0])
        if head:
            current = roman[head.group(1).upper()]
            sections[current] = []
            rest = stanza[1:]
            if rest:
                sections[current].append(rest)
            continue
        if current is None:
            continue  # pre-canto front matter
        sections[current].append(stanza)
    return sections


def build() -> dict:
    print("Scraping Hyperion (Books I-III)...")
    hyperion_sections = []
    for n, slug in enumerate(["hyperion-book-i", "hyperion-book-ii", "hyperion-book-iii"], 1):
        content = entry_content(fetch(slug, PAGES[slug]))
        stanzas = drop_title_blocks(parse_stanzas(content), ("HYPERION", "BOOK"))
        hyperion_sections.append({
            "id": f"book-{n}",
            "title": f"Book {'I' * n if n < 4 else n}",
            "stanzas": stanzas,
            "lineCount": sum(len(s) for s in stanzas),
        })
    # Roman numerals done properly for the titles
    for sec, roman in zip(hyperion_sections, ("I", "II", "III")):
        sec["title"] = f"Book {roman}"

    print("Scraping The Fall of Hyperion (Cantos I-II)...")
    content = entry_content(fetch("fall-of-hyperion", PAGES["fall-of-hyperion"]))
    stanzas = drop_title_blocks(parse_stanzas(content), ("FALL OF HYPERION", "A DREAM"))
    cantos = split_cantos(stanzas)
    fall_sections = []
    for sec_id, roman in (("canto-1", "I"), ("canto-2", "II")):
        st = cantos.get(sec_id, [])
        fall_sections.append({
            "id": sec_id,
            "title": f"Canto {roman}",
            "stanzas": st,
            "lineCount": sum(len(s) for s in st),
        })

    data = {
        "source": "http://keats-poems.com/ (public domain text)",
        "poems": [
            {
                "id": "hyperion",
                "title": "Hyperion",
                "subtitle": "A Fragment",
                "author": "John Keats",
                "composed": "1818–19",
                "sections": hyperion_sections,
            },
            {
                "id": "fall-of-hyperion",
                "title": "The Fall of Hyperion",
                "subtitle": "A Dream",
                "author": "John Keats",
                "composed": "1819",
                "sections": fall_sections,
            },
        ],
    }
    return data


def validate(data: dict) -> bool:
    ok = True
    for poem in data["poems"]:
        for sec in poem["sections"]:
            expected = EXPECTED.get((poem["id"], sec["id"]))
            got = sec["lineCount"]
            status = "?"
            if expected is not None:
                status = "OK" if abs(got - expected) <= TOLERANCE else "MISMATCH"
                ok = ok and status == "OK"
            print(f"  {poem['title']} {sec['title']}: {got} lines "
                  f"(expected ~{expected}) [{status}]")
    return ok


def main() -> int:
    data = build()
    print("Validating line counts...")
    ok = validate(data)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
