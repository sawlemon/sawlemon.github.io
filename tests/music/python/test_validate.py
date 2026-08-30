"""Tests for the Replay boundary validators."""
import json
import os
import sys
import unittest
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CANONICALIZE_DIR = os.path.join(REPO, "scripts", "music-pipeline", "canonicalize")
sys.path.insert(0, CANONICALIZE_DIR)

from raw_io import FlatReader  # noqa: E402
from canonicalize import canonicalize  # noqa: E402
from validate import validate_music, validate_raw_manifest  # noqa: E402

FIXTURES = os.path.join(REPO, "tests", "music", "fixtures")
RAW = os.path.join(FIXTURES, "raw")


def valid_candidate():
    candidate, _ = canonicalize(FlatReader(RAW), date(2024, 1, 1))
    return candidate


def codes(diagnostics):
    return {d["code"] for d in diagnostics}


class ValidCandidateTest(unittest.TestCase):
    def test_fixture_candidate_passes(self):
        self.assertEqual(validate_music(valid_candidate()), [])

    def test_real_music_json_passes(self):
        path = os.path.join(REPO, "src", "data", "music.json")
        if not os.path.exists(path):
            self.skipTest("src/data/music.json not present")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(validate_music(json.load(f)), [])


class CanonicalInvariantTest(unittest.TestCase):
    def test_root_shape(self):
        self.assertIn("root-shape", codes(validate_music([])))
        self.assertIn("years-empty", codes(validate_music({"generated": "2024-01-01", "years": {}})))

    def test_generated_must_be_iso_date(self):
        candidate = valid_candidate()
        candidate["generated"] = "not-a-date"
        self.assertIn("generated-invalid", codes(validate_music(candidate)))

    def test_year_minutes_mismatch(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["minutes"] = 999
        self.assertIn("year-minutes-mismatch", codes(validate_music(candidate)))

    def test_duplicate_month(self):
        candidate = valid_candidate()
        months = candidate["years"]["2024"]["months"]
        months.append(dict(months[0]))
        self.assertIn("month-duplicate", codes(validate_music(candidate)))

    def test_month_out_of_range(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["months"][0]["month"] = 13
        self.assertIn("month-range", codes(validate_music(candidate)))

    def test_wrong_month_label(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["months"][0]["label"] = "Dec"
        self.assertIn("month-label", codes(validate_music(candidate)))

    def test_negative_minutes(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["months"][0]["minutes"] = -1
        self.assertIn("month-minutes", codes(validate_music(candidate)))

    def test_empty_top_songs(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["topSongs"] = []
        self.assertIn("top-songs-empty", codes(validate_music(candidate)))

    def test_song_without_title(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["topSongs"][0]["title"] = ""
        self.assertIn("song-title", codes(validate_music(candidate)))

    def test_non_mzstatic_artwork(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["topSongs"][0]["artwork"] = "https://evil.example.com/x.jpg"
        self.assertIn("artwork-url", codes(validate_music(candidate)))

    def test_non_apple_playlist_url(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["playlist"]["url"] = "https://evil.example.com/pl"
        self.assertIn("playlist-url", codes(validate_music(candidate)))

    def test_negative_plays(self):
        candidate = valid_candidate()
        candidate["years"]["2024"]["topSongs"][0]["plays"] = -5
        self.assertIn("metric-invalid", codes(validate_music(candidate)))


class RawManifestTest(unittest.TestCase):
    def valid_manifest(self):
        return {
            "schemaVersion": 1,
            "runId": "r1",
            "source": "apple-music-replay",
            "fetchedAt": "2024-01-01T00:00:00Z",
            "years": ["2024"],
            "snapshots": [
                {
                    "kind": "year",
                    "id": "2024",
                    "path": "raw/year-2024.json",
                    "status": "present",
                    "httpStatus": 200,
                    "payloadSha256": "a" * 64,
                },
                {
                    "kind": "month",
                    "id": "2024-03",
                    "path": "raw/month-2024-03.json",
                    "status": "absent",
                    "httpStatus": 404,
                },
            ],
            "coverage": {},
            "warnings": [],
        }

    def test_valid_manifest_passes(self):
        self.assertEqual(validate_raw_manifest(self.valid_manifest()), [])

    def test_wrong_version(self):
        manifest = self.valid_manifest()
        manifest["schemaVersion"] = 2
        self.assertIn("manifest-version", codes(validate_raw_manifest(manifest)))

    def test_path_traversal_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["path"] = "raw/../../etc/passwd"
        self.assertIn("snapshot-path", codes(validate_raw_manifest(manifest)))

    def test_present_entry_needs_hash(self):
        manifest = self.valid_manifest()
        del manifest["snapshots"][0]["payloadSha256"]
        self.assertIn("snapshot-hash", codes(validate_raw_manifest(manifest)))

    def test_bad_status(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][1]["status"] = "missing"
        self.assertIn("snapshot-status", codes(validate_raw_manifest(manifest)))


if __name__ == "__main__":
    unittest.main()
