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

Month state boundary: every month is exactly one of three states.

- Explicitly absent: not enumerated by reader.month_ids() (a 404 is recorded
  as a pathless manifest entry by snapshots/store.mjs; a legacy flat layout
  has no file), so it is safely omitted with no diagnostics.
- Present and usable: canonicalized normally.
- Present but malformed/unusable: one or more severity=error diagnostics
  naming the year, month, and reason. canonicalize() still returns its
  candidate, but the CLI refuses to write output while any error exists, so
  malformed data can never silently shrink a year total. A stored payload
  with no Replay data is malformed, not absent: acquisition records 404s as
  absent and aborts the run on a 200 without data, so empty data in a stored
  payload contradicts the acquisition contract.
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


def month_entry(month_payload, year, fallback_month):
    """Map one present month payload to (entry, errors).

    The state is explicit in the result, never an ambiguous None:

    - (entry, [])      present and usable;
    - (None, errors)   present but malformed: every error has
      severity="error" and names the year, month, and reason, so callers
      block publication instead of silently dropping the month. Absent
      snapshots never reach this function (readers enumerate only present
      months), so None here always means malformed, not missing.

    Structural shape errors (payload, data, resources containers) are all
    reported before dependent checks stop, so one bad payload can surface
    several reasons; once attributes cannot be resolved, the dependent
    marker/minutes checks cannot run and are skipped.
    """
    errors = []
    path = f"years.{year}.months.{fallback_month:02d}"

    def error(code, message):
        errors.append({"severity": "error", "code": code, "path": path, "message": message})

    def fail(code, message):
        error(code, message)
        return None, errors

    if not isinstance(month_payload, dict):
        return fail("month-shape", f"month payload is {type(month_payload).__name__}, expected an object")
    data = month_payload.get("data")
    if not data:
        return fail(
            "month-empty",
            "present month payload has no replay data (data missing or empty); "
            "it should have been recorded absent by acquisition",
        )
    if not isinstance(data, list):
        return fail("month-data-shape", f"month payload data is {type(data).__name__}, expected a list")
    summary = data[0]
    if not isinstance(summary, dict) or not isinstance(summary.get("id"), str) or not summary["id"]:
        return fail("month-data-shape", "month summary entry is not an object with a nonempty string id")

    mres = month_payload.get("resources")
    if not isinstance(mres, dict):
        # Missing resources stay tolerated (attributes may resolve from the
        # summary itself); present-but-wrong-typed resources are malformed.
        if mres is not None:
            error("month-resources-shape", f"month payload resources is {type(mres).__name__}, expected an object")
        mres = {}
    res_summaries = mres.get("music-summaries")
    if not isinstance(res_summaries, dict):
        if res_summaries is not None:
            error("month-resources-shape", f"resources.music-summaries is {type(res_summaries).__name__}, expected an object")
        res_summaries = {}
    resolved = res_summaries.get(summary["id"]) or summary
    if not isinstance(resolved, dict):
        error("month-resources-shape", f"resources.music-summaries[{summary['id']!r}] is not an object")
        resolved = summary
    attrs = resolved.get("attributes")
    if not isinstance(attrs, dict):
        return fail(
            "month-summary-unresolved",
            f"month summary attributes unresolved: neither data[0] nor "
            f"resources.music-summaries[{summary['id']!r}] carries an attributes object",
        )

    marker = attrs.get("month")
    if marker is not None and (not isinstance(marker, int) or isinstance(marker, bool) or not 1 <= marker <= 12):
        return fail("month-marker-invalid", f"month marker {marker!r} is not an integer 1-12")
    if not 1 <= fallback_month <= 12:
        return fail("month-marker-invalid", f"snapshot month {fallback_month} is outside 1-12")
    if marker is not None and marker != fallback_month:
        return fail(
            "month-marker-mismatch",
            f"payload month marker {marker} contradicts snapshot month {fallback_month}",
        )
    month_num = marker if marker is not None else fallback_month

    minutes = attrs.get("listenTimeInMinutes", 0)
    if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes < 0:
        return fail("month-minutes-invalid", f"listenTimeInMinutes {minutes!r} is not a nonnegative integer")

    month_artists = mres.get("artist-period-summaries")
    if not isinstance(month_artists, dict):
        if month_artists is not None:
            error("month-resources-shape", f"resources.artist-period-summaries is {type(month_artists).__name__}, expected an object")
        month_artists = {}
    top_artists = []
    for s in month_artists.values():
        artist = artist_entry(mres, s)
        if artist is not None:
            top_artists.append({"name": artist["name"], "minutes": artist["minutes"]})
    top_artists.sort(key=lambda x: -x["minutes"])

    entry = {
        "month": month_num,
        "label": MONTH_LABELS[month_num - 1],
        "minutes": minutes,
        "artists": top_artists[:5],
    }
    return (None, errors) if errors else (entry, errors)


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

    Month handling follows the module state boundary: months not enumerated
    by reader.month_ids() are explicitly absent and safely omitted; every
    enumerated month payload is present, so a payload that month_entry
    rejects is malformed input and surfaces as error diagnostics here.
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
            entry, month_errors = month_entry(reader.month_payload(year, month), year, month)
            diagnostics.extend(month_errors)
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
    # Transactional ordering: every error (raw-side and output-side) is
    # collected and reported before the only write below. _write_atomic is
    # reached with an empty errors list only, so a failed run leaves an
    # existing output file byte-for-byte unchanged.
    errors = [d for d in diagnostics if d["severity"] == "error"]
    for d in validate_music(candidate):
        diagnostics.append(d)
        if d["severity"] == "error":
            errors.append(d)

    for d in diagnostics:
        print(f"[{d['severity']}] {d['code']}: {d['path']} — {d['message']}")
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
