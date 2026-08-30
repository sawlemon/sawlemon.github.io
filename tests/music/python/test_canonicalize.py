"""Tests for the pure Replay canonicalizer against anonymized fixtures."""
import json
import os
import sys
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
        entry = month_entry(payload, 1)
        self.assertEqual(entry["month"], 1)
        self.assertEqual(entry["label"], "Jan")
        self.assertEqual(entry["minutes"], 75)
        self.assertEqual(entry["artists"][0]["name"], "Fake Artist A")

    def test_month_entry_invalid_month_is_none(self):
        payload = load_json(os.path.join(FIXTURES, "malformed", "invalid-month.json"))
        self.assertIsNone(month_entry(payload, 3))

    def test_month_entry_404_body_is_none(self):
        self.assertIsNone(month_entry({"data": []}, 1))
        self.assertIsNone(month_entry(None, 1))

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
            "kind": "month", "id": "2024-03", "path": "raw/month-2024-03.json",
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


class RawInputErrorTest(unittest.TestCase):
    def test_missing_file_raises(self):
        with self.assertRaises(RawInputError):
            load_json(os.path.join(RAW, "does-not-exist.json"))

    def test_bad_json_raises(self):
        with self.assertRaises(RawInputError):
            load_json(os.path.join(FIXTURES, "malformed", "bad-json.json"))


if __name__ == "__main__":
    unittest.main()
