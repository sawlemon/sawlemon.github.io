"""Tests for the pure Replay canonicalizer against anonymized fixtures."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CANONICALIZE_DIR = os.path.join(REPO, "scripts", "music-pipeline", "canonicalize")
sys.path.insert(0, CANONICALIZE_DIR)

from raw_io import FlatReader, ManifestReader, RawInputError, load_json  # noqa: E402
from canonicalize import (  # noqa: E402
    artwork_url,
    canonicalize,
    month_entry,
    pick_playlist,
    top_songs,
)

FIXTURES = os.path.join(REPO, "tests", "music", "fixtures")
RAW = os.path.join(FIXTURES, "raw")


def load_expected():
    with open(os.path.join(FIXTURES, "expected", "music.json"), encoding="utf-8") as f:
        return json.load(f)


def set_feb_marker(value):
    """Mutation that corrupts February's month marker in a raw payload."""
    def mutate(payload):
        payload["resources"]["music-summaries"]["month-2024-02"]["attributes"]["month"] = value
    return mutate


def empty_feb_data(payload):
    """Mutation that strips all replay data from a present February payload."""
    payload["data"] = []


RAW_NAMES = ("year-2024.json", "month-2024-01.json", "month-2024-02.json")


def make_flat_dir(feb_mutate=None, extra_files=None):
    """Copy the raw fixtures into a fresh flat directory (temp, outside repo)."""
    tmp = tempfile.mkdtemp(prefix="replay-flat-")
    for name in RAW_NAMES:
        shutil.copy(os.path.join(RAW, name), os.path.join(tmp, name))
    if feb_mutate is not None:
        path = os.path.join(tmp, "month-2024-02.json")
        payload = load_json(path)
        feb_mutate(payload)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    for name, payload in (extra_files or {}).items():
        with open(os.path.join(tmp, name), "w", encoding="utf-8") as f:
            json.dump(payload, f)
    return tmp


def make_manifest_run(feb_mutate=None, feb_absent=False):
    """Build a run directory (manifest.json + raw/) in a fresh temp dir.

    Mirrors what snapshots/store.mjs writes: present entries carry a
    recomputed payloadSha256, absent entries are pathless with no hash.
    """
    tmp = tempfile.mkdtemp(prefix="replay-run-")
    run_dir = os.path.join(tmp, "runs", "r1")
    os.makedirs(os.path.join(run_dir, "raw"))
    for name in RAW_NAMES:
        shutil.copy(os.path.join(RAW, name), os.path.join(run_dir, "raw", name))
    if feb_mutate is not None:
        path = os.path.join(run_dir, "raw", "month-2024-02.json")
        payload = load_json(path)
        feb_mutate(payload)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    entries = []
    if feb_absent:
        # Absent entries are pathless, exactly as snapshots/store.mjs
        # recordAbsent() writes them.
        entries.append({
            "kind": "month", "id": "2024-02",
            "status": "absent", "httpStatus": 404, "observedAt": "2024-01-01T00:00:00Z",
        })
    entries.append({"kind": "year", "id": "2024", "name": "year-2024.json"})
    entries.append({"kind": "month", "id": "2024-01", "name": "month-2024-01.json"})
    if not feb_absent:
        entries.append({"kind": "month", "id": "2024-02", "name": "month-2024-02.json"})
    final_entries = []
    for entry in entries:
        if entry.get("status") == "absent":
            final_entries.append(entry)
            continue
        with open(os.path.join(run_dir, "raw", entry["name"]), "rb") as payload_file:
            payload = payload_file.read()
        final_entries.append({
            "kind": entry["kind"], "id": entry["id"], "path": f"raw/{entry['name']}",
            "status": "present", "httpStatus": 200, "observedAt": "2024-01-01T00:00:00Z",
            "payloadSha256": hashlib.sha256(payload).hexdigest(),
        })
    manifest = {
        "schemaVersion": 1,
        "runId": "r1",
        "source": "apple-music-replay",
        "fetchedAt": "2024-01-01T00:00:00Z",
        "years": ["2024"],
        "snapshots": final_entries,
        "coverage": {},
        "warnings": [],
    }
    with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return run_dir


class ArtworkTest(unittest.TestCase):
    def test_template_expansion(self):
        self.assertEqual(
            artwork_url("https://is1-ssl.mzstatic.com/x/{w}x{h}{c}.jpg"),
            "https://is1-ssl.mzstatic.com/x/200x200bb.jpg",
        )

    def test_missing_template_is_none(self):
        self.assertIsNone(artwork_url(None))
        self.assertIsNone(artwork_url(""))


class CanonicalizeTest(unittest.TestCase):
    def setUp(self):
        self.reader = FlatReader(RAW)
        self.candidate, self.diagnostics = canonicalize(self.reader, date(2024, 1, 1))

    def test_matches_expected_fixture(self):
        self.assertEqual(self.candidate, load_expected())

    def test_year_minutes_equal_month_sum(self):
        yd = self.candidate["years"]["2024"]
        self.assertEqual(yd["minutes"], sum(m["minutes"] for m in yd["months"]))

    def test_songs_ranked_by_plays(self):
        plays = [s["plays"] for s in self.candidate["years"]["2024"]["topSongs"]]
        self.assertEqual(plays, sorted(plays, reverse=True))

    def test_song_without_playcount_is_skipped(self):
        titles = [s["title"] for s in self.candidate["years"]["2024"]["topSongs"]]
        self.assertNotIn("Unrankable Song", titles)

    def test_artwork_expanded(self):
        song = self.candidate["years"]["2024"]["topSongs"][0]
        self.assertEqual(song["artwork"], "https://is1-ssl.mzstatic.com/image/thumb/fake/200x200bb.jpg")

    def test_playlist_prefers_exact_replay(self):
        playlist = self.candidate["years"]["2024"]["playlist"]
        self.assertEqual(playlist["id"], "pl.rp-fake-2024")

    def test_playlist_falls_back_to_first_replay(self):
        resources = {
            "playlists": {
                "p1": {"id": "pl.other", "attributes": {"name": "Chill Mix", "url": "https://music.apple.com/x"}},
                "p2": {"id": "pl.rp-x", "attributes": {"name": "Replay 2099", "url": "https://music.apple.com/y"}},
            }
        }
        playlist = pick_playlist(resources, "2024")
        self.assertEqual(playlist["id"], "pl.rp-x")

    def test_playlist_falls_back_to_any_playlist(self):
        resources = {"playlists": {"p1": {"id": "pl.any", "attributes": {"name": "Mix", "url": "https://music.apple.com/z"}}}}
        playlist = pick_playlist(resources, "2024")
        self.assertEqual(playlist["id"], "pl.any")

    def test_no_playlists_gives_none(self):
        self.assertIsNone(pick_playlist({"playlists": {}}, "2024"))
        self.assertIsNone(pick_playlist({}, "2024"))

    def test_month_entry_uses_resources_attributes(self):
        payload = load_json(os.path.join(RAW, "month-2024-01.json"))
        entry, errors = month_entry(payload, "2024", 1)
        self.assertEqual(errors, [])
        self.assertEqual(entry["month"], 1)
        self.assertEqual(entry["label"], "Jan")
        self.assertEqual(entry["minutes"], 75)
        self.assertEqual(entry["artists"][0]["name"], "Fake Artist A")

    def test_month_entry_invalid_month_marker_is_error(self):
        payload = load_json(os.path.join(FIXTURES, "malformed", "invalid-month.json"))
        entry, errors = month_entry(payload, "2099", 3)
        self.assertIsNone(entry)
        matched = [e for e in errors if e["code"] == "month-marker-invalid"]
        self.assertTrue(matched)
        for e in matched:
            self.assertEqual(e["severity"], "error")
            self.assertEqual(e["path"], "years.2099.months.03")

    def test_present_payload_without_data_is_error_not_omission(self):
        # A stored payload with no replay data contradicts the acquisition
        # contract (404s are recorded absent, 200-without-data aborts the
        # run), so it is malformed input — never silently omitted.
        entry, errors = month_entry({"data": []}, "2024", 1)
        self.assertIsNone(entry)
        self.assertTrue(any(e["code"] == "month-empty" and e["severity"] == "error" for e in errors))

        entry, errors = month_entry(None, "2024", 1)
        self.assertIsNone(entry)
        self.assertTrue(any(e["code"] == "month-shape" and e["severity"] == "error" for e in errors))

    def test_missing_resources_year_is_error_diagnostic(self):
        import tempfile
        input_dir = tempfile.mkdtemp(prefix="malformed-only-")
        path = os.path.join(input_dir, "year-2099.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"data": [{"id": "year-2099"}]}, f)
        try:
            reader = FlatReader(input_dir)
            candidate, diagnostics = canonicalize(reader, date(2024, 1, 1))
        finally:
            import shutil
            shutil.rmtree(input_dir, ignore_errors=True)
        self.assertEqual(candidate["years"], {})
        self.assertTrue(any(d["code"] == "raw-missing-resources" and d["severity"] == "error" for d in diagnostics))

    def test_deterministic_output(self):
        again, _ = canonicalize(FlatReader(RAW), date(2024, 1, 1))
        self.assertEqual(self.candidate, again)


class MonthPayloadValidationTest(unittest.TestCase):
    """Every present-but-malformed month payload must surface severity=error
    diagnostics naming the year and month, never a silent omission."""

    def january(self):
        return load_json(os.path.join(RAW, "month-2024-01.json"))

    def assert_rejected(self, payload, code, fallback=1, year="2024"):
        entry, errors = month_entry(payload, year, fallback)
        self.assertIsNone(entry, f"expected {code} to reject the payload")
        matched = [e for e in errors if e["code"] == code]
        self.assertTrue(matched, f"expected code {code}, got {[e['code'] for e in errors]}")
        for e in matched:
            self.assertEqual(e["severity"], "error")
            self.assertEqual(e["path"], f"years.{year}.months.{fallback:02d}")

    def test_payload_not_an_object(self):
        self.assert_rejected(None, "month-shape")
        self.assert_rejected([], "month-shape")
        self.assert_rejected("{}", "month-shape")

    def test_missing_or_empty_data_for_present_file(self):
        self.assert_rejected({"resources": {}}, "month-empty")
        self.assert_rejected({"data": []}, "month-empty")

    def test_data_not_a_list(self):
        payload = self.january()
        payload["data"] = {"month-2024-01": payload["data"][0]}
        self.assert_rejected(payload, "month-data-shape")

    def test_summary_entry_not_an_object(self):
        self.assert_rejected({"data": ["month-2024-01"]}, "month-data-shape")

    def test_summary_entry_without_id(self):
        self.assert_rejected({"data": [{"type": "music-summaries"}]}, "month-data-shape")

    def test_resources_not_an_object(self):
        payload = self.january()
        payload["resources"] = []
        self.assert_rejected(payload, "month-resources-shape")

    def test_music_summaries_not_an_object(self):
        payload = self.january()
        payload["resources"]["music-summaries"] = []
        self.assert_rejected(payload, "month-resources-shape")

    def test_resource_summary_entry_not_an_object(self):
        payload = self.january()
        payload["resources"]["music-summaries"]["month-2024-01"] = "oops"
        self.assert_rejected(payload, "month-resources-shape")

    def test_artist_summaries_not_an_object(self):
        payload = self.january()
        payload["resources"]["artist-period-summaries"] = []
        self.assert_rejected(payload, "month-resources-shape")

    def test_unresolved_summary_attributes(self):
        payload = {
            "data": [{"id": "month-2024-01", "type": "music-summaries"}],
            "resources": {"music-summaries": {}},
        }
        self.assert_rejected(payload, "month-summary-unresolved")

    def test_month_marker_bool(self):
        for value in (True, False):
            payload = self.january()
            payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["month"] = value
            self.assert_rejected(payload, "month-marker-invalid")

    def test_month_marker_out_of_range(self):
        for value in (0, 13):
            payload = self.january()
            payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["month"] = value
            self.assert_rejected(payload, "month-marker-invalid")

    def test_month_marker_not_an_integer(self):
        payload = self.january()
        payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["month"] = "1"
        self.assert_rejected(payload, "month-marker-invalid")

    def test_month_marker_mismatches_snapshot_month(self):
        payload = self.january()
        payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["month"] = 3
        self.assert_rejected(payload, "month-marker-mismatch")

    def test_fallback_month_out_of_range(self):
        # A flat file month-2024-13.json (or manifest id 2024-13) enumerates
        # month 13; with no marker attribute the fallback itself is invalid.
        payload = self.january()
        del payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["month"]
        self.assert_rejected(payload, "month-marker-invalid", fallback=13)

    def test_listen_minutes_invalid_type_or_range(self):
        for value in ("45", 4.5, True, None, -1):
            payload = self.january()
            payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["listenTimeInMinutes"] = value
            self.assert_rejected(payload, "month-minutes-invalid")

    def test_missing_listen_minutes_defaults_to_zero(self):
        # Legacy behavior preserved: an absent metric defaults to 0; only a
        # present-but-invalid metric is malformed.
        payload = self.january()
        del payload["resources"]["music-summaries"]["month-2024-01"]["attributes"]["listenTimeInMinutes"]
        entry, errors = month_entry(payload, "2024", 1)
        self.assertEqual(errors, [])
        self.assertEqual(entry["minutes"], 0)

    def test_shape_errors_reported_together(self):
        payload = self.january()
        payload["resources"] = []
        entry, errors = month_entry(payload, "2024", 1)
        self.assertIsNone(entry)
        codes = [e["code"] for e in errors]
        self.assertIn("month-resources-shape", codes)
        self.assertIn("month-summary-unresolved", codes)

    def test_valid_payload_returns_entry_without_errors(self):
        entry, errors = month_entry(self.january(), "2024", 1)
        self.assertEqual(errors, [])
        self.assertEqual(entry["month"], 1)
        self.assertEqual(entry["label"], "Jan")
        self.assertEqual(entry["minutes"], 75)


class ManifestReaderTest(unittest.TestCase):
    def setUp(self):
        import shutil
        import tempfile
        self.tmp = tempfile.mkdtemp()
        run_dir = os.path.join(self.tmp, "runs", "r1")
        os.makedirs(os.path.join(run_dir, "raw"))
        for name in ("year-2024.json", "month-2024-01.json", "month-2024-02.json"):
            shutil.copy(os.path.join(RAW, name), os.path.join(run_dir, "raw", name))
        import hashlib
        entries = []
        for kind, ident, name in [
            ("year", "2024", "year-2024.json"),
            ("month", "2024-01", "month-2024-01.json"),
            ("month", "2024-02", "month-2024-02.json"),
        ]:
            with open(os.path.join(run_dir, "raw", name), "rb") as payload_file:
                payload = payload_file.read()
            entries.append({
                "kind": kind, "id": ident, "path": f"raw/{name}", "status": "present",
                "httpStatus": 200, "observedAt": "2024-01-01T00:00:00Z",
                "payloadSha256": hashlib.sha256(payload).hexdigest(),
            })
        entries.append({
            # Absent entries are pathless, exactly as snapshots/store.mjs
            # recordAbsent() writes them.
            "kind": "month", "id": "2024-03",
            "status": "absent", "httpStatus": 404, "observedAt": "2024-01-01T00:00:00Z",
        })
        manifest = {
            "schemaVersion": 1,
            "runId": "r1",
            "source": "apple-music-replay",
            "fetchedAt": "2024-01-01T00:00:00Z",
            "years": ["2024"],
            "snapshots": entries,
            "coverage": {},
            "warnings": [],
        }
        with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        self.manifest = manifest
        self.reader = ManifestReader(run_dir)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_manifest_reader_matches_expected(self):
        candidate, diagnostics = canonicalize(self.reader, date(2024, 1, 1))
        self.assertEqual(candidate, load_expected())
        self.assertFalse([d for d in diagnostics if d["severity"] == "error"])

    def test_absent_month_is_not_loaded(self):
        self.assertEqual(self.reader.month_ids("2024"), [1, 2])
        self.assertIsNone(self.reader.month_payload("2024", 3))

    def test_invalid_manifest_raises(self):
        bad = os.path.join(self.tmp, "runs", "bad")
        os.makedirs(bad)
        with open(os.path.join(bad, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"nope": True}, f)
        with self.assertRaises(RawInputError):
            ManifestReader(bad)

    def test_absent_entry_with_path_raises(self):
        manifest = json.loads(json.dumps(self.manifest))
        manifest["snapshots"][-1]["path"] = "raw/month-2024-03.json"
        bad = os.path.join(self.tmp, "runs", "contradictory")
        os.makedirs(bad)
        with open(os.path.join(bad, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        with self.assertRaises(RawInputError):
            ManifestReader(bad)


class MalformedMonthPipelineTest(unittest.TestCase):
    """Regression: a malformed present month must fail canonicalization on
    both reader paths; an explicitly absent month stays safely omitted."""

    def assert_blocked(self, diagnostics, code, path):
        errors = [d for d in diagnostics if d["severity"] == "error"]
        self.assertTrue(errors, "expected blocking error diagnostics")
        self.assertTrue(any(d["code"] == code and d["path"] == path for d in errors),
                        f"expected {code} at {path}, got {[(d['code'], d['path']) for d in errors]}")

    def test_mutated_marker_13_cannot_reduce_total_silently_flat(self):
        # The original bug: flipping February's marker to 13 dropped the year
        # total 120 → 75 with no diagnostics and a zero exit status.
        flat = make_flat_dir(feb_mutate=set_feb_marker(13))
        self.addCleanup(shutil.rmtree, flat, ignore_errors=True)
        candidate, diagnostics = canonicalize(FlatReader(flat), date(2024, 1, 1))
        months = candidate["years"]["2024"]["months"]
        self.assertEqual([m["label"] for m in months], ["Jan"])
        self.assertEqual(candidate["years"]["2024"]["minutes"], 75)
        self.assert_blocked(diagnostics, "month-marker-invalid", "years.2024.months.02")

    def test_flat_month_file_with_out_of_range_number_fails(self):
        # A legacy flat file named month-2024-13.json is present by
        # definition; it must fail, not vanish.
        flat = make_flat_dir(extra_files={"month-2024-13.json": load_json(os.path.join(RAW, "month-2024-01.json"))})
        self.addCleanup(shutil.rmtree, flat, ignore_errors=True)
        _, diagnostics = canonicalize(FlatReader(flat), date(2024, 1, 1))
        self.assert_blocked(diagnostics, "month-marker-invalid", "years.2024.months.13")

    def test_flat_month_without_data_fails(self):
        flat = make_flat_dir(extra_files={"month-2024-03.json": {"data": []}})
        self.addCleanup(shutil.rmtree, flat, ignore_errors=True)
        _, diagnostics = canonicalize(FlatReader(flat), date(2024, 1, 1))
        self.assert_blocked(diagnostics, "month-empty", "years.2024.months.03")

    def test_manifest_malformed_present_month_fails(self):
        run_dir = make_manifest_run(feb_mutate=set_feb_marker(13))
        self.addCleanup(shutil.rmtree, os.path.dirname(run_dir), ignore_errors=True)
        candidate, diagnostics = canonicalize(ManifestReader(run_dir), date(2024, 1, 1))
        self.assertEqual([m["label"] for m in candidate["years"]["2024"]["months"]], ["Jan"])
        self.assert_blocked(diagnostics, "month-marker-invalid", "years.2024.months.02")

    def test_manifest_present_month_without_data_fails(self):
        run_dir = make_manifest_run(feb_mutate=empty_feb_data)
        self.addCleanup(shutil.rmtree, os.path.dirname(run_dir), ignore_errors=True)
        _, diagnostics = canonicalize(ManifestReader(run_dir), date(2024, 1, 1))
        self.assert_blocked(diagnostics, "month-empty", "years.2024.months.02")

    def test_manifest_explicitly_absent_month_is_omitted_without_errors(self):
        run_dir = make_manifest_run(feb_absent=True)
        self.addCleanup(shutil.rmtree, os.path.dirname(run_dir), ignore_errors=True)
        candidate, diagnostics = canonicalize(ManifestReader(run_dir), date(2024, 1, 1))
        self.assertEqual([d for d in diagnostics if d["severity"] == "error"], [])
        months = candidate["years"]["2024"]["months"]
        self.assertEqual([m["month"] for m in months], [1])
        self.assertEqual(candidate["years"]["2024"]["minutes"], 75)


class CanonicalizeCliTest(unittest.TestCase):
    """End-to-end CLI regression: malformed present months exit nonzero with
    actionable diagnostics and never touch an existing output file."""

    CANONICALIZE = os.path.join(REPO, "scripts", "music-pipeline", "canonicalize", "canonicalize.py")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, self.CANONICALIZE, *args],
            capture_output=True,
            text=True,
        )

    def temp_dir(self, prefix):
        tmp = tempfile.mkdtemp(prefix=prefix)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return tmp

    def test_original_mutation_month_13_exits_nonzero_and_preserves_output(self):
        flat = make_flat_dir(feb_mutate=set_feb_marker(13))
        self.addCleanup(shutil.rmtree, flat, ignore_errors=True)
        output = os.path.join(self.temp_dir("replay-cli-out-"), "out.json")
        sentinel = b'{"previous": true}\n'
        with open(output, "wb") as f:
            f.write(sentinel)
        result = self.run_cli("--input-dir", flat, "--output", output, "--generated-date", "2024-01-01")
        self.assertEqual(result.returncode, 1)
        self.assertIn("[error] month-marker-invalid", result.stdout)
        self.assertIn("years.2024.months.02", result.stdout)
        self.assertIn("month marker 13 is not an integer 1-12", result.stdout)
        self.assertIn("FAILED: 1 error(s) — output not written", result.stderr)
        with open(output, "rb") as f:
            self.assertEqual(f.read(), sentinel)

    def test_valid_fixtures_write_expected_output(self):
        flat = make_flat_dir()
        self.addCleanup(shutil.rmtree, flat, ignore_errors=True)
        output = os.path.join(self.temp_dir("replay-cli-out-"), "out.json")
        result = self.run_cli("--input-dir", flat, "--output", output, "--generated-date", "2024-01-01")
        self.assertEqual(result.returncode, 0)
        with open(output, encoding="utf-8") as f:
            self.assertEqual(json.load(f), load_expected())

    def test_manifest_cli_path_fails_on_malformed_month(self):
        run_dir = make_manifest_run(feb_mutate=set_feb_marker(13))
        self.addCleanup(shutil.rmtree, os.path.dirname(run_dir), ignore_errors=True)
        output = os.path.join(self.temp_dir("replay-cli-out-"), "out.json")
        with open(output, "wb") as f:
            f.write(b'{"previous": true}\n')
        result = self.run_cli("--manifest", os.path.join(run_dir, "manifest.json"),
                              "--output", output, "--generated-date", "2024-01-01")
        self.assertEqual(result.returncode, 1)
        self.assertIn("month-marker-invalid", result.stdout)
        with open(output, "rb") as f:
            self.assertEqual(f.read(), b'{"previous": true}\n')

    def test_validate_only_fails_on_malformed_and_passes_on_valid(self):
        bad = make_flat_dir(feb_mutate=set_feb_marker(13))
        self.addCleanup(shutil.rmtree, bad, ignore_errors=True)
        result = self.run_cli("--input-dir", bad, "--validate-only")
        self.assertEqual(result.returncode, 1)
        self.assertIn("month-marker-invalid", result.stdout)

        good = make_flat_dir()
        self.addCleanup(shutil.rmtree, good, ignore_errors=True)
        result = self.run_cli("--input-dir", good, "--validate-only")
        self.assertEqual(result.returncode, 0)


class RawInputErrorTest(unittest.TestCase):
    def test_missing_file_raises(self):
        with self.assertRaises(RawInputError):
            load_json(os.path.join(RAW, "does-not-exist.json"))

    def test_bad_json_raises(self):
        with self.assertRaises(RawInputError):
            load_json(os.path.join(FIXTURES, "malformed", "bad-json.json"))


if __name__ == "__main__":
    unittest.main()
