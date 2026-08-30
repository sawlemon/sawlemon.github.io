"""Boundary invariants for Apple Music Replay data.

Two entry points:

- ``validate_music(data)`` checks the canonical music.json contract that
  src/pages/music.astro depends on.
- ``validate_raw_manifest(manifest)`` checks the snapshot manifest written
  by scripts/music-pipeline/snapshots/store.mjs.

All checks return a list of structured diagnostics ({severity, code, path,
message}) instead of raising, so callers can aggregate and report. Diagnostics
never contain payload fragments, URLs with query strings, or secrets.

The ``validate.py --input <music.json>`` CLI is used by CI to reject
malformed canonical data before the Astro build.
"""
import argparse
import json
import re
import sys
from urllib.parse import urlparse

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
YEAR_KEY_RE = re.compile(r"^\d{4}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

ARTWORK_HOST_SUFFIXES = ("mzstatic.com",)
PLAYLIST_HOSTS = ("music.apple.com",)


def _error(errors, code, path, message):
    errors.append({"severity": "error", "code": code, "path": path, "message": message})


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_nonempty_str(value):
    return isinstance(value, str) and value.strip() != ""


def _url_allowed(url, allowed):
    if not isinstance(url, str) or not url:
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = parsed.hostname or ""
    return parsed.scheme == "https" and any(host == s or host.endswith("." + s) for s in allowed)


def _check_metric(errors, value, path):
    if not _is_int(value) or value < 0:
        _error(errors, "metric-invalid", path, f"expected nonnegative integer, got {value!r}")


def _check_top_songs(errors, songs, path):
    if not isinstance(songs, list) or not songs:
        _error(errors, "top-songs-empty", path, "topSongs must be a nonempty list (music.astro reads topSongs[0])")
        return
    for i, song in enumerate(songs):
        if not isinstance(song, dict):
            _error(errors, "song-shape", f"{path}[{i}]", "song entry must be an object")
            continue
        if not _is_nonempty_str(song.get("title")):
            _error(errors, "song-title", f"{path}[{i}].title", "song title must be a nonempty string")
        if not _is_nonempty_str(song.get("artist")):
            _error(errors, "song-artist", f"{path}[{i}].artist", "song artist must be a nonempty string")
        if song.get("artwork") is not None and not _url_allowed(song.get("artwork"), ARTWORK_HOST_SUFFIXES):
            _error(errors, "artwork-url", f"{path}[{i}].artwork", "artwork must be an https mzstatic.com URL")
        _check_metric(errors, song.get("plays"), f"{path}[{i}].plays")


def _check_ranked_people(errors, entries, path, name_key):
    if not isinstance(entries, list) or not entries:
        _error(errors, f"{name_key}-empty", path, f"{name_key} must be a nonempty list")
        return
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            _error(errors, f"{name_key}-shape", f"{path}[{i}]", "entry must be an object")
            continue
        if not _is_nonempty_str(entry.get("name")):
            _error(errors, f"{name_key}-name", f"{path}[{i}].name", "name must be a nonempty string")
        _check_metric(errors, entry.get("minutes"), f"{path}[{i}].minutes")
        if "plays" in entry:
            _check_metric(errors, entry.get("plays"), f"{path}[{i}].plays")


def validate_music(data):
    """Validate canonical music.json; returns a list of error diagnostics."""
    errors = []
    if not isinstance(data, dict):
        _error(errors, "root-shape", "$", "music.json must be an object")
        return errors

    if not _is_nonempty_str(data.get("generated")) or not ISO_DATE_RE.match(data.get("generated", "")):
        _error(errors, "generated-invalid", ".generated", "generated must be an ISO date (YYYY-MM-DD)")

    years = data.get("years")
    if not isinstance(years, dict) or not years:
        _error(errors, "years-empty", ".years", "years must be a nonempty object")
        return errors

    for year, yd in years.items():
        if not YEAR_KEY_RE.match(str(year)):
            _error(errors, "year-key", f".years.{year}", "year keys must be four-digit strings")
        if not isinstance(yd, dict):
            _error(errors, "year-shape", f".years.{year}", "year must be an object")
            continue

        months = yd.get("months")
        if not isinstance(months, list):
            _error(errors, "months-shape", f".years.{year}.months", "months must be a list")
            months = []

        total = 0
        seen = set()
        for i, month in enumerate(months):
            path = f".years.{year}.months[{i}]"
            if not isinstance(month, dict):
                _error(errors, "month-shape", path, "month must be an object")
                continue
            num = month.get("month")
            if not _is_int(num) or not 1 <= num <= 12:
                _error(errors, "month-range", f"{path}.month", "month must be an integer 1-12")
                continue
            if num in seen:
                _error(errors, "month-duplicate", path, f"month {num} appears more than once")
            seen.add(num)
            if month.get("label") != MONTH_LABELS[num - 1]:
                _error(errors, "month-label", f"{path}.label", f"label must be {MONTH_LABELS[num - 1]!r}")
            minutes = month.get("minutes")
            if not _is_int(minutes) or minutes < 0:
                _error(errors, "month-minutes", f"{path}.minutes", "minutes must be a nonnegative integer")
            else:
                total += minutes
            artists = month.get("artists")
            if not isinstance(artists, list):
                _error(errors, "month-artists", f"{path}.artists", "artists must be a list")
                continue
            for j, artist in enumerate(artists):
                if not isinstance(artist, dict) or not _is_nonempty_str(artist.get("name")):
                    _error(errors, "month-artist-name", f"{path}.artists[{j}].name", "artist name must be a nonempty string")
                else:
                    _check_metric(errors, artist.get("minutes"), f"{path}.artists[{j}].minutes")

        year_minutes = yd.get("minutes")
        if not _is_int(year_minutes) or year_minutes < 0:
            _error(errors, "year-minutes", f".years.{year}.minutes", "minutes must be a nonnegative integer")
        elif year_minutes != total:
            _error(
                errors,
                "year-minutes-mismatch",
                f".years.{year}.minutes",
                f"year minutes {year_minutes} != sum of month minutes {total}",
            )

        _check_top_songs(errors, yd.get("topSongs"), f".years.{year}.topSongs")
        _check_ranked_people(errors, yd.get("topArtists"), f".years.{year}.topArtists", "topArtists")
        albums = yd.get("topAlbums")
        if not isinstance(albums, list):
            _error(errors, "topAlbums-shape", f".years.{year}.topAlbums", "topAlbums must be a list")
        else:
            for i, album in enumerate(albums):
                if not isinstance(album, dict):
                    _error(errors, "album-shape", f".years.{year}.topAlbums[{i}]", "album entry must be an object")
                    continue
                if not _is_nonempty_str(album.get("name")):
                    _error(errors, "album-name", f".years.{year}.topAlbums[{i}].name", "album name must be a nonempty string")
                if album.get("artwork") is not None and not _url_allowed(album.get("artwork"), ARTWORK_HOST_SUFFIXES):
                    _error(errors, "artwork-url", f".years.{year}.topAlbums[{i}].artwork", "artwork must be an https mzstatic.com URL")
                _check_metric(errors, album.get("minutes"), f".years.{year}.topAlbums[{i}].minutes")
                _check_metric(errors, album.get("plays"), f".years.{year}.topAlbums[{i}].plays")

        playlist = yd.get("playlist")
        if playlist is not None:
            path = f".years.{year}.playlist"
            if not isinstance(playlist, dict):
                _error(errors, "playlist-shape", path, "playlist must be an object or null")
            else:
                for field in ("name", "url", "id"):
                    if not _is_nonempty_str(playlist.get(field)):
                        _error(errors, f"playlist-{field}", f"{path}.{field}", "playlist field must be a nonempty string")
                if _is_nonempty_str(playlist.get("url")) and not _url_allowed(playlist.get("url"), PLAYLIST_HOSTS):
                    _error(errors, "playlist-url", f"{path}.url", "playlist url must be an https music.apple.com URL")

    return errors


def validate_raw_manifest(manifest):
    """Validate a snapshot manifest; returns a list of error diagnostics."""
    errors = []
    if not isinstance(manifest, dict):
        _error(errors, "manifest-shape", "$", "manifest must be an object")
        return errors
    if manifest.get("schemaVersion") != 1:
        _error(errors, "manifest-version", ".schemaVersion", "schemaVersion must be 1")
    if manifest.get("source") != "apple-music-replay":
        _error(errors, "manifest-source", ".source", "source must be apple-music-replay")
    if not _is_nonempty_str(manifest.get("runId")):
        _error(errors, "manifest-run-id", ".runId", "runId must be a nonempty string")
    if not _is_nonempty_str(manifest.get("fetchedAt")):
        _error(errors, "manifest-fetched-at", ".fetchedAt", "fetchedAt must be a nonempty string")
    snapshots = manifest.get("snapshots")
    if not isinstance(snapshots, list) or not snapshots:
        _error(errors, "manifest-snapshots", ".snapshots", "snapshots must be a nonempty list")
        return errors
    seen_ids = set()
    for i, entry in enumerate(snapshots):
        path = f".snapshots[{i}]"
        if not isinstance(entry, dict):
            _error(errors, "snapshot-shape", path, "snapshot entry must be an object")
            continue
        if entry.get("kind") not in ("year", "month"):
            _error(errors, "snapshot-kind", f"{path}.kind", "kind must be 'year' or 'month'")
        if not _is_nonempty_str(entry.get("id")):
            _error(errors, "snapshot-id", f"{path}.id", "id must be a nonempty string")
        else:
            key = (entry.get("kind"), entry.get("id"))
            if key in seen_ids:
                _error(errors, "snapshot-duplicate", path, "kind/id appears more than once")
            seen_ids.add(key)
        rel = entry.get("path")
        if not _is_nonempty_str(rel) or not rel.startswith("raw/") or ".." in rel:
            _error(errors, "snapshot-path", f"{path}.path", "path must be a relative raw/ path without traversal")
        if entry.get("status") not in ("present", "absent"):
            _error(errors, "snapshot-status", f"{path}.status", "status must be 'present' or 'absent'")
        elif entry["status"] == "present" and not SHA256_RE.match(str(entry.get("payloadSha256", ""))):
            _error(errors, "snapshot-hash", f"{path}.payloadSha256", "present payloads need a sha256 hash")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="validate.py",
        description="Validate canonical music.json (or a snapshot manifest) and report diagnostics.",
    )
    parser.add_argument("--input", required=True, help="path to music.json or manifest.json")
    args = parser.parse_args(argv)

    try:
        with open(args.input, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[error] input-unreadable: {e}")
        return 1

    is_manifest = isinstance(data, dict) and "snapshots" in data
    diagnostics = validate_raw_manifest(data) if is_manifest else validate_music(data)
    for d in diagnostics:
        print(f"[{d['severity']}] {d['code']}: {d['path']} — {d['message']}")
    if any(d["severity"] == "error" for d in diagnostics):
        print(f"FAILED: {len([d for d in diagnostics if d['severity'] == 'error'])} error(s) in {args.input}")
        return 1
    print(f"validation passed: {args.input}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
