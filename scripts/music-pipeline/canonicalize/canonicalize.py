"""Pure canonicalization of Apple Music Replay raw payloads.

Consumes raw JSON via a reader (raw_io.py) and produces the music.json
contract consumed by src/pages/music.astro. No file I/O here besides the
injected reader calls; output writing lives in the CLI entrypoint at the
bottom of this module.

Mapping rules are ported verbatim from the original scripts/build-music-data.py:

- Songs are ranked by playCount (stable sort, insertion order on ties);
  a song without an integer playCount is skipped instead of crashing.
- Artists and albums are ranked by listenTimeInMinutes (missing metrics
  default to 0, exactly as before).
- Year minutes equal the sum of the available month minutes.
- Month labels come from the month number (1-based).
- Playlist preference: exact `Replay {year}` among pl.rp-*, then the first
  pl.rp-*, then the first playlist of any kind.
- `generated` is the canonical build date (today unless overridden).
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import date

from raw_io import ManifestReader, RawInputError, open_input

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def artwork_url(template, size=200):
    if not template:
        return None
    return template.replace("{w}x{h}", f"{size}x{size}").replace("{c}", "bb")


def song_entry(resources, summary):
    """Song title/artist/album/artwork come from the resource; the play
    count lives on the period-summary entry itself."""
    if not isinstance(summary, dict):
        return None
    rel = (summary.get("relationships", {}) or {}).get("song", {}) or {}
    ids = rel.get("data") or []
    if not ids:
        return None
    song = (resources.get("songs") or {}).get((ids[0] or {}).get("id"))
    if not isinstance(song, dict):
        return None
    a = song.get("attributes", {}) or {}
    s_attrs = summary.get("attributes", {}) or {}
    plays = s_attrs.get("playCount")
    if not isinstance(plays, int) or isinstance(plays, bool):
        return None  # unrankable without a play count
    return {
        "title": a.get("name"),
        "artist": a.get("artistName"),
        "album": a.get("albumName"),
        "artwork": artwork_url((a.get("artwork") or {}).get("url")),
        "plays": plays,
    }


def artist_entry(resources, summary):
    """Artist name comes from the resource; metrics from the summary."""
    if not isinstance(summary, dict):
        return None
    rel = (summary.get("relationships", {}) or {}).get("artist", {}) or {}
    ids = rel.get("data") or []
    if not ids:
        return None
    artist = (resources.get("artists") or {}).get((ids[0] or {}).get("id"))
    if not isinstance(artist, dict):
        return None
    name = (artist.get("attributes", {}) or {}).get("name")
    if not name:
        return None
    s_attrs = summary.get("attributes", {}) or {}
    return {
        "name": name,
        "minutes": s_attrs.get("listenTimeInMinutes", 0),
        "plays": s_attrs.get("playCount", 0),
    }


def album_entry(resources, summary):
    """Album name/artist/artwork come from the resource; metrics from the summary."""
    if not isinstance(summary, dict):
        return None
    rel = (summary.get("relationships", {}) or {}).get("album", {}) or {}
    ids = rel.get("data") or []
    if not ids:
        return None
    album = (resources.get("albums") or {}).get((ids[0] or {}).get("id"))
    if not isinstance(album, dict):
        return None
    a = album.get("attributes", {}) or {}
    s_attrs = summary.get("attributes", {}) or {}
    return {
        "name": a.get("name"),
        "artist": a.get("artistName"),
        "artwork": artwork_url((a.get("artwork") or {}).get("url")),
        "minutes": s_attrs.get("listenTimeInMinutes", 0),
        "plays": s_attrs.get("playCount", 0),
    }


def _ranked(resources, summaries_key, entry_fn, metric):
    entries = []
    for summary in (resources.get(summaries_key) or {}).values():
        item = entry_fn(resources, summary)
        if item is not None:
            entries.append(item)
    entries.sort(key=lambda x: -x[metric])
    return entries


def top_songs(resources):
    return _ranked(resources, "song-period-summaries", song_entry, "plays")


def top_artists(resources):
    return _ranked(resources, "artist-period-summaries", artist_entry, "minutes")


def top_albums(resources):
    return _ranked(resources, "album-period-summaries", album_entry, "minutes")


def month_entry(month_payload, fallback_month):
    """Map one month summary payload; None means no usable summary."""
    if not isinstance(month_payload, dict):
        return None
    data = month_payload.get("data")
    if not data:
        return None  # 404 body: no summary for this month
    summary = data[0]
    mres = month_payload.get("resources") or {}
    if not isinstance(mres, dict):
        mres = {}
    res_summaries = mres.get("music-summaries") or {}
    if not isinstance(res_summaries, dict):
        res_summaries = {}
    attrs = (res_summaries.get(summary.get("id")) or summary).get("attributes", {}) or {}
    month_num = attrs.get("month") or fallback_month
    if not isinstance(month_num, int) or isinstance(month_num, bool) or not 1 <= month_num <= 12:
        return None  # invalid month marker; surfaced by output validation
    top_artists = []
    for s in (mres.get("artist-period-summaries") or {}).values():
        artist = artist_entry(mres, s)
        if artist is not None:
            top_artists.append({"name": artist["name"], "minutes": artist["minutes"]})
    top_artists.sort(key=lambda x: -x["minutes"])
    return {
        "month": month_num,
        "label": MONTH_LABELS[month_num - 1],
        "minutes": attrs.get("listenTimeInMinutes", 0),
        "artists": top_artists[:5],
    }


def pick_playlist(resources, year):
    playlists = list((resources.get("playlists") or {}).values())
    replay_playlists = [p for p in playlists if str((p or {}).get("id", "")).startswith("pl.rp-")]
    pick = next(
        (p for p in replay_playlists if (p.get("attributes", {}) or {}).get("name") == f"Replay {year}"),
        replay_playlists[0] if replay_playlists else (playlists[0] if playlists else None),
    )
    if not pick:
        return None
    a = pick.get("attributes", {}) or {}
    return {"name": a.get("name"), "url": a.get("url"), "id": pick.get("id")}


def canonicalize(reader, generated_date=None):
    """Build the canonical candidate from a raw reader.

    Returns (candidate, diagnostics). candidate is the music.json contract
    ({generated, years}); diagnostics is a list of {severity, code, path,
    message} dicts describing skipped/invalid raw data. severity "error"
    diagnostics make the CLI refuse to write output.
    """
    diagnostics = []
    years = {}
    for year in reader.year_ids():
        yd = reader.year_payload(year)
        if not isinstance(yd, dict) or not yd.get("data"):
            diagnostics.append({
                "severity": "warning",
                "code": "year-empty",
                "path": f"years.{year}",
                "message": "year payload has no replay data; year skipped",
            })
            continue
        resources = yd.get("resources")
        if not isinstance(resources, dict):
            diagnostics.append({
                "severity": "error",
                "code": "raw-missing-resources",
                "path": f"years.{year}",
                "message": "year payload has no resources map",
            })
            continue

        months = []
        for month in reader.month_ids(year):
            entry = month_entry(reader.month_payload(year, month), month)
            if entry is not None:
                months.append(entry)
        months.sort(key=lambda m: m["month"])

        years[year] = {
            "minutes": sum(m["minutes"] for m in months),
            "months": months,
            "topSongs": top_songs(resources),
            "topArtists": top_artists(resources),
            "topAlbums": top_albums(resources),
            "playlist": pick_playlist(resources, year),
        }

    candidate = {
        "generated": (generated_date or date.today()).isoformat(),
        "years": years,
    }
    return candidate, diagnostics


def _write_atomic(output_path, text):
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".music-", suffix=".json", dir=out_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_path, output_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="canonicalize.py",
        description="Canonicalize Apple Music Replay raw snapshots into src/data/music.json format.",
    )
    parser.add_argument("--input-dir", help="directory with raw snapshots (run dir or legacy flat dir)")
    parser.add_argument("--manifest", help="path to a run manifest.json (overrides --input-dir detection)")
    parser.add_argument("--output", help="output path for canonical music.json")
    parser.add_argument("--generated-date", help="ISO date for the generated field (default: today)")
    parser.add_argument("--validate-only", action="store_true", help="validate without writing output")
    args = parser.parse_args(argv)

    if args.manifest:
        reader = ManifestReader(os.path.dirname(os.path.abspath(args.manifest)))
    elif args.input_dir:
        reader = open_input(args.input_dir)
    else:
        parser.error("one of --input-dir or --manifest is required")

    generated = date.fromisoformat(args.generated_date) if args.generated_date else date.today()
    candidate, diagnostics = canonicalize(reader, generated)

    from validate import validate_music
    errors = [d for d in diagnostics if d["severity"] == "error"]
    for d in validate_music(candidate):
        diagnostics.append(d)
        if d["severity"] == "error":
            errors.append(d)

    for d in diagnostics:
        print(f"[{d['severity']}] {d['code']}: {d['message']}")
    if errors:
        print(f"FAILED: {len(errors)} error(s) — output not written", file=sys.stderr)
        return 1

    if args.validate_only:
        print("validation passed")
        return 0

    if not args.output:
        parser.error("--output is required unless --validate-only is set")
    _write_atomic(args.output, json.dumps(candidate, indent=1, ensure_ascii=False))
    print("wrote", args.output)
    for y, d in candidate["years"].items():
        print(y, "minutes:", d["minutes"], "songs:", len(d["topSongs"]), "artists:", len(d["topArtists"]),
              "months:", [(m["label"], m["minutes"]) for m in d["months"]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
