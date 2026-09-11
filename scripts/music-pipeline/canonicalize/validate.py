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
from datetime import datetime
from urllib.parse import urlparse

# JSON Schema ``pattern`` uses the ECMA-262 dialect, where ``$`` anchors at
# the end of input only (Python's ``$`` would also match before a trailing
# newline, hence ``\Z``) and ``\d`` means exactly ASCII 0-9 (Python's ``\d``
# would also match Unicode decimal digits). These patterns use ``[0-9]`` to
# stay exactly in parity with the declared schema patterns.
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
YEAR_KEY_RE = re.compile(r"^[0-9]{4}\Z")
SHA256_RE = re.compile(r"^[0-9a-f]{64}\Z")
RAW_PATH_RE = re.compile(r"^raw/[^/].*\Z")
RFC3339_DATETIME_RE = re.compile(
    r"^(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]"
    r"(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})(?P<fraction>\.[0-9]+)?"
    r"(?P<offset>[Zz]|[+-][0-9]{2}:[0-9]{2})\Z"
)

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

ARTWORK_HOST_SUFFIXES = ("mzstatic.com",)
PLAYLIST_HOSTS = ("music.apple.com",)


def _error(errors, code, path, message):
    errors.append({"severity": "error", "code": code, "path": path, "message": message})


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_nonempty_str(value):
    return isinstance(value, str) and value.strip() != ""


def _is_rfc3339_datetime(value):
    """True when value is an RFC 3339 date-time (JSON Schema format: date-time).

    Standard library only: a structural regex plus calendar and clock range
    checks, so it behaves identically on every supported Python. The RFC 3339
    ABNF requires the T separator and a colon-separated numeric offset (the
    spec's NOTE also permits a space separator by prior agreement; it is not
    accepted here, matching the contract's declared pattern).

    A second value of 60 is the RFC 3339 leap second, which is only inserted
    at 23:59:60 UTC, so the offset-adjusted time must land there (matching
    the contract's ``format: date-time`` implementation).
    """
    if not isinstance(value, str):
        return False
    match = RFC3339_DATETIME_RE.match(value)
    if not match:
        return False
    try:
        year, month, day = (int(part) for part in match.group("date").split("-"))
        datetime(year, month, day)
    except ValueError:
        return False
    hour, minute, second = int(match.group("hour")), int(match.group("minute")), int(match.group("second"))
    if hour > 23 or minute > 59 or second > 60:
        return False
    offset = match.group("offset")
    if offset in ("Z", "z"):
        offset_hour, offset_minute = 0, 0
    else:
        offset_hour, offset_minute = int(offset[1:3]), int(offset[4:6])
        if offset_hour > 23 or offset_minute > 59:
            return False
    if second < 60:
        return True
    # second 60: only valid when the offset-adjusted UTC time is 23:59:60.
    sign = 1 if offset[0] == "+" else -1
    utc_minute = minute - sign * offset_minute
    utc_hour = hour - sign * offset_hour - (1 if utc_minute < 0 else 0)
    return utc_hour in (23, -1) and utc_minute in (59, -1)


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


MANIFEST_FIELDS = frozenset(
    {"schemaVersion", "runId", "source", "fetchedAt", "years", "snapshots", "coverage", "warnings"}
)
SNAPSHOT_FIELDS = frozenset({"kind", "id", "path", "status", "httpStatus", "observedAt", "payloadSha256"})


def _raw_path_error(rel):
    """Return a message when rel is not a safe relative raw/ path, else None."""
    if not isinstance(rel, str) or not RAW_PATH_RE.match(rel):
        return "path must be a relative raw/ path"
    if ".." in rel:
        return "path must not contain path traversal"
    return None


def validate_raw_manifest(manifest):
    """Validate a snapshot manifest; returns a list of error diagnostics.

    Authoritative implementation of the contract declared in
    scripts/music-pipeline/contracts/raw-snapshot.schema.json:

    - exact top-level field set (``additionalProperties: false``) with the
      required fields and types; ``schemaVersion`` must be the integer 1
      (never a boolean or float) and ``source`` exactly
      ``apple-music-replay``;
    - ``fetchedAt`` and per-entry ``observedAt`` must be RFC 3339 date-time
      strings (the schema's ``format: date-time``);
    - ``years`` is a required array of four-digit strings; duplicates are
      rejected, matching the schema's ``uniqueItems``;
    - ``snapshots`` is a required nonempty array with an exact per-entry
      field set and unique ``(kind, id)`` pairs across entries (the schema's
      ``uniqueItems`` only rejects exact duplicates; JSON Schema cannot
      express uniqueness of a projected key, so the Python validator owns
      the cross-entry check). Absent entries are pathless: they carry no
      ``path`` and no ``payloadSha256`` — the resource does not exist, so
      there is nothing to load or hash. Present entries require a safe
      relative ``raw/`` path and a string, lowercase, 64-hex SHA-256 payload
      hash (a 64-digit integer is not a hash);
    - ``httpStatus``, when present, is a nonnegative integer (never
      boolean); ``coverage``, when present, is an object; ``warnings``,
      when present, is an array of strings.
    """
    errors = []
    if not isinstance(manifest, dict):
        _error(errors, "manifest-shape", "$", "manifest must be an object")
        return errors

    for key in sorted(set(manifest) - MANIFEST_FIELDS):
        _error(errors, "manifest-field", f".{key}", "unknown manifest field")

    version = manifest.get("schemaVersion")
    if not _is_int(version) or version != 1:
        _error(errors, "manifest-version", ".schemaVersion", "schemaVersion must be the integer 1")
    if manifest.get("source") != "apple-music-replay":
        _error(errors, "manifest-source", ".source", "source must be apple-music-replay")
    if not _is_nonempty_str(manifest.get("runId")):
        _error(errors, "manifest-run-id", ".runId", "runId must be a nonempty string")
    if not _is_rfc3339_datetime(manifest.get("fetchedAt")):
        _error(errors, "manifest-fetched-at", ".fetchedAt", "fetchedAt must be an RFC 3339 date-time string")

    years = manifest.get("years")
    if not isinstance(years, list) or any(not isinstance(y, str) or not YEAR_KEY_RE.match(y) for y in years):
        _error(errors, "manifest-years", ".years", "years must be an array of four-digit year strings")
    else:
        seen_years = set()
        for i, year in enumerate(years):
            if year in seen_years:
                _error(errors, "manifest-years-duplicate", f".years[{i}]", f"year {year} appears more than once")
            seen_years.add(year)

    snapshots = manifest.get("snapshots")
    if not isinstance(snapshots, list) or not snapshots:
        _error(errors, "manifest-snapshots", ".snapshots", "snapshots must be a nonempty list")
        snapshots = []
    seen_ids = set()
    for i, entry in enumerate(snapshots):
        path = f".snapshots[{i}]"
        if not isinstance(entry, dict):
            _error(errors, "snapshot-shape", path, "snapshot entry must be an object")
            continue
        for key in sorted(set(entry) - SNAPSHOT_FIELDS):
            _error(errors, "snapshot-field", f"{path}.{key}", "unknown snapshot field")
        if entry.get("kind") not in ("year", "month"):
            _error(errors, "snapshot-kind", f"{path}.kind", "kind must be 'year' or 'month'")
        if not _is_nonempty_str(entry.get("id")):
            _error(errors, "snapshot-id", f"{path}.id", "id must be a nonempty string")
        else:
            key = (entry.get("kind"), entry.get("id"))
            if key in seen_ids:
                _error(errors, "snapshot-duplicate", path, "kind/id appears more than once")
            seen_ids.add(key)
        status = entry.get("status")
        if status not in ("present", "absent"):
            _error(errors, "snapshot-status", f"{path}.status", "status must be 'present' or 'absent'")
        elif status == "present":
            path_error = _raw_path_error(entry.get("path"))
            if path_error:
                _error(errors, "snapshot-path", f"{path}.path", path_error)
            digest = entry.get("payloadSha256")
            if not isinstance(digest, str) or not SHA256_RE.match(digest):
                _error(
                    errors,
                    "snapshot-hash",
                    f"{path}.payloadSha256",
                    "present payloads need a lowercase 64-hex sha256 hash string",
                )
        else:
            # Absent entries are pathless: a path or hash on them is a
            # contradiction, not metadata.
            if "path" in entry:
                _error(errors, "snapshot-absent-path", f"{path}.path", "absent entries must not have a path")
            if "payloadSha256" in entry:
                _error(errors, "snapshot-absent-hash", f"{path}.payloadSha256", "absent entries must not have a payloadSha256")
        if "httpStatus" in entry:
            http_status = entry["httpStatus"]
            if not _is_int(http_status) or http_status < 0:
                _error(errors, "snapshot-http-status", f"{path}.httpStatus", "httpStatus must be a nonnegative integer")
        if "observedAt" in entry and not _is_rfc3339_datetime(entry["observedAt"]):
            _error(errors, "snapshot-observed-at", f"{path}.observedAt", "observedAt must be an RFC 3339 date-time string")

    if "coverage" in manifest and not isinstance(manifest["coverage"], dict):
        _error(errors, "manifest-coverage", ".coverage", "coverage must be an object")
    if "warnings" in manifest:
        warnings = manifest["warnings"]
        if not isinstance(warnings, list) or any(not isinstance(w, str) for w in warnings):
            _error(errors, "manifest-warnings", ".warnings", "warnings must be an array of strings")
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
