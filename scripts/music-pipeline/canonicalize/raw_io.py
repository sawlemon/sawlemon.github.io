"""Raw snapshot input readers for the Apple Music Replay pipeline.

Two input layouts are supported:

- Legacy flat directory: ``year-YYYY.json`` / ``month-YYYY-MM.json`` directly
  in the input directory (the original /tmp/replay layout).
- Run directory: a directory containing ``manifest.json`` plus raw payloads
  (written by scripts/music-pipeline/snapshots/store.mjs).

Readers perform no network, browser, or secret handling: payloads are the
plain JSON responses saved by the acquisition adapter.
"""
import glob
import hashlib
import json
import os
import re

YEAR_FILE_RE = re.compile(r"year-(\d{4})\.json$")
MONTH_FILE_RE = re.compile(r"month-(\d{4})-(\d{2})\.json$")


class RawInputError(Exception):
    """Raised when raw snapshot files cannot be located or parsed."""

    def __init__(self, code, message, path=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError as e:
        raise RawInputError("raw-missing", f"missing raw snapshot: {os.path.basename(path)}", path) from e
    except json.JSONDecodeError as e:
        raise RawInputError("raw-invalid-json", f"invalid JSON in {os.path.basename(path)}", path) from e
    except OSError as e:
        raise RawInputError("raw-unreadable", f"cannot read {os.path.basename(path)}: {e.strerror}", path) from e


class FlatReader:
    """Reader for the legacy flat directory layout."""

    layout = "flat"

    def __init__(self, input_dir):
        self.input_dir = input_dir
        self.years = {}
        self.months = {}
        for path in sorted(glob.glob(os.path.join(input_dir, "year-*.json"))):
            m = YEAR_FILE_RE.search(os.path.basename(path))
            if m:
                self.years[m.group(1)] = load_json(path)
        for path in sorted(glob.glob(os.path.join(input_dir, "month-*.json"))):
            m = MONTH_FILE_RE.search(os.path.basename(path))
            if m:
                self.months[(m.group(1), int(m.group(2)))] = load_json(path)

    def year_ids(self):
        return sorted(self.years)

    def year_payload(self, year):
        return self.years.get(year)

    def month_ids(self, year):
        return sorted(mm for (y, mm) in self.months if y == year)

    def month_payload(self, year, month):
        return self.months.get((year, month))


class ManifestReader:
    """Reader for a run directory backed by manifest.json."""

    layout = "manifest"

    def __init__(self, run_dir):
        self.run_dir = run_dir
        manifest_path = os.path.join(run_dir, "manifest.json")
        manifest = load_json(manifest_path)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("snapshots"), list):
            raise RawInputError("manifest-invalid", "manifest.json has no snapshots list", manifest_path)
        self.manifest = manifest
        # The validator is imported lazily to keep raw_io usable as a small
        # standalone reader while enforcing the manifest contract here.
        from validate import validate_raw_manifest
        errors = validate_raw_manifest(manifest)
        if errors:
            raise RawInputError("manifest-invalid", f"manifest.json failed validation ({len(errors)} error(s))", manifest_path)
        self._present = {}
        for entry in manifest["snapshots"]:
            if not isinstance(entry, dict) or entry.get("status") != "present":
                continue
            payload_path = os.path.join(run_dir, entry["path"])
            try:
                with open(payload_path, "rb") as payload_file:
                    payload_bytes = payload_file.read()
            except OSError as e:
                raise RawInputError("snapshot-missing", f"missing manifest payload: {entry['path']}", payload_path) from e
            actual_hash = hashlib.sha256(payload_bytes).hexdigest()
            if actual_hash != entry.get("payloadSha256"):
                raise RawInputError("snapshot-hash", f"snapshot hash mismatch: {entry['path']}", payload_path)
            self._present.setdefault(entry.get("kind"), {})[entry.get("id")] = entry

    def year_ids(self):
        return sorted(e["id"] for e in self._present.get("year", {}).values())

    def year_payload(self, year):
        entry = self._present.get("year", {}).get(year)
        return load_json(os.path.join(self.run_dir, entry["path"])) if entry else None

    def month_ids(self, year):
        ids = []
        for e in self._present.get("month", {}).values():
            if isinstance(e["id"], str) and e["id"].startswith(f"{year}-"):
                ids.append(int(e["id"].split("-", 1)[1]))
        return sorted(ids)

    def month_payload(self, year, month):
        entry = self._present.get("month", {}).get(f"{year}-{month:02d}")
        return load_json(os.path.join(self.run_dir, entry["path"])) if entry else None


def open_input(input_dir):
    """Open a directory as a manifest run or legacy flat layout."""
    if not os.path.isdir(input_dir):
        raise RawInputError("input-missing", f"input directory does not exist: {input_dir}")
    if os.path.isfile(os.path.join(input_dir, "manifest.json")):
        return ManifestReader(input_dir)
    return FlatReader(input_dir)
