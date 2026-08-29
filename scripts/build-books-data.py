#!/usr/bin/env python3
"""Parse a Goodreads library export CSV into src/data/books.json.

Usage: python3 scripts/build-books-data.py /path/to/goodreads_library_export.csv

Includes only shelves "read" and "currently-reading". Ratings, reviews, and
private notes are never copied to the output.
"""
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "books.json"

STATUS_MAP = {"read": "read", "currently-reading": "currently-reading"}
POSITION_RE = re.compile(r"currently-reading \(#(\d+)\)")


def to_iso(value):
    value = (value or "").strip()
    if not value:
        return None
    y, m, d = value.split("/")
    return f"{y}-{m}-{d}"


def to_int(value):
    value = (value or "").strip()
    return int(value) if value.isdigit() else None


def clean(value):
    return (value or "").strip()


def build(csv_path):
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        required = {"Book Id", "Title", "Author", "Exclusive Shelf", "Date Read",
                    "Date Added", "Year Published", "Number of Pages", "Binding",
                    "Bookshelves with positions"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            sys.exit(f"CSV is missing expected columns: {', '.join(sorted(missing))}")

        books = []
        for row in reader:
            shelf = clean(row["Exclusive Shelf"])
            status = STATUS_MAP.get(shelf)
            if not status:
                continue
            position = None
            if status == "currently-reading":
                m = POSITION_RE.search(clean(row["Bookshelves with positions"]))
                if m:
                    position = int(m.group(1))
            books.append({
                "id": clean(row["Book Id"]),
                "title": clean(row["Title"]),
                "author": clean(row["Author"]),
                "status": status,
                "readDate": to_iso(row["Date Read"]),
                "dateAdded": to_iso(row["Date Added"]),
                "publishedYear": to_int(row["Year Published"]),
                "pages": to_int(row["Number of Pages"]),
                "format": clean(row["Binding"]),
                "currentPosition": position,
            })

    if not books:
        sys.exit("no read or currently-reading books found in the export")

    dated = sorted((b for b in books if b["readDate"]),
                   key=lambda b: (b["readDate"], b["id"]), reverse=True)
    undated = sorted((b for b in books if b["status"] == "read" and not b["readDate"]),
                     key=lambda b: (b["dateAdded"] or "", b["id"]), reverse=True)
    reading = sorted((b for b in books if b["status"] == "currently-reading"),
                     key=lambda b: (b["currentPosition"] or 99, b["id"]))

    return {"generated": date.today().isoformat(), "books": reading + dated + undated}


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: build-books-data.py <goodreads_library_export.csv>")
    data = build(sys.argv[1])
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    books = data["books"]
    reading = sum(1 for b in books if b["status"] == "currently-reading")
    undated = sum(1 for b in books if b["status"] == "read" and not b["readDate"])
    print(f"wrote {OUT} ({len(books)} books: {len(books) - reading - undated} dated reads, "
          f"{undated} undated reads, {reading} currently reading)")


if __name__ == "__main__":
    main()
