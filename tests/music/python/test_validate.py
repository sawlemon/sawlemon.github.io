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
                    # Absent entries are pathless, exactly as
                    # snapshots/store.mjs recordAbsent() writes them.
                    "kind": "month",
                    "id": "2024-03",
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

    def test_wrong_source(self):
        manifest = self.valid_manifest()
        manifest["source"] = "other"
        self.assertIn("manifest-source", codes(validate_raw_manifest(manifest)))

    def test_duplicate_snapshot_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"].append(dict(manifest["snapshots"][0]))
        self.assertIn("snapshot-duplicate", codes(validate_raw_manifest(manifest)))

    def test_path_traversal_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["path"] = "raw/../../etc/passwd"
        self.assertIn("snapshot-path", codes(validate_raw_manifest(manifest)))

    def test_present_entry_needs_hash(self):
        manifest = self.valid_manifest()
        del manifest["snapshots"][0]["payloadSha256"]
        self.assertIn("snapshot-hash", codes(validate_raw_manifest(manifest)))

    def test_present_entry_needs_path(self):
        manifest = self.valid_manifest()
        del manifest["snapshots"][0]["path"]
        self.assertIn("snapshot-path", codes(validate_raw_manifest(manifest)))

    def test_present_entry_malformed_hash_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["payloadSha256"] = "not-a-hash"
        self.assertIn("snapshot-hash", codes(validate_raw_manifest(manifest)))

    def test_absent_entry_with_path_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][1]["path"] = "raw/month-2024-03.json"
        self.assertIn("snapshot-absent-path", codes(validate_raw_manifest(manifest)))

    def test_absent_entry_with_hash_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][1]["payloadSha256"] = "a" * 64
        self.assertIn("snapshot-absent-hash", codes(validate_raw_manifest(manifest)))

    def test_bad_status(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][1]["status"] = "missing"
        self.assertIn("snapshot-status", codes(validate_raw_manifest(manifest)))

    # --- parity with contracts/raw-snapshot.schema.json --------------------

    def test_manifest_must_be_object(self):
        for bad in ([], "nope", None):
            with self.subTest(bad=bad):
                self.assertIn("manifest-shape", codes(validate_raw_manifest(bad)))

    def test_unknown_top_level_field_rejected(self):
        manifest = self.valid_manifest()
        manifest["extra"] = "nope"
        self.assertIn("manifest-field", codes(validate_raw_manifest(manifest)))

    def test_schema_version_must_be_exact_integer(self):
        # True == 1 in Python and 1.0 parses as a float; neither is the
        # integer 1 the contract declares.
        for bad in (True, "1", 1.0, None):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["schemaVersion"] = bad
                self.assertIn("manifest-version", codes(validate_raw_manifest(manifest)))

    def test_run_id_whitespace_only_rejected(self):
        # \x1c is whitespace to Python's str.strip() but not to the schema's
        # ECMA-262 \s, so this pin lives Python-side (see the Node parity
        # test's notes on control-character whitespace).
        for bad in ("   ", "\x1c"):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["runId"] = bad
                self.assertIn("manifest-run-id", codes(validate_raw_manifest(manifest)))

    def test_snapshot_id_whitespace_only_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["id"] = " "
        self.assertIn("snapshot-id", codes(validate_raw_manifest(manifest)))

    def test_fetched_at_must_be_rfc3339_date_time(self):
        bad_values = [
            "",
            "not-a-date",
            "2024-01-01",  # date only
            "2024-01-01 00:00:00Z",  # space separator
            "2024-13-01T00:00:00Z",  # month 13
            "2024-02-30T00:00:00Z",  # impossible day
            "2024-01-01T24:00:00Z",  # hour 24
            "2024-01-01T00:60:00Z",  # minute 60
            "2024-01-01T00:00:00",  # missing offset
            "2024-01-01T00:00:00+24:00",  # offset hour 24
            "0000-01-01T00:00:00Z",  # year 0000: stdlib datetime rejects; ajv-formats accepts (Node parity test note)
            "٢٠٢٤-٠١-٠١T00:00:00Z",  # non-ASCII digits: Python \d accepted them before the ECMA parity fix
            "2024-01-01T00:00:60Z",  # second 60 away from the UTC 23:59:60 leap second
        ]
        for fetched_at in bad_values:
            with self.subTest(fetched_at=fetched_at):
                manifest = self.valid_manifest()
                manifest["fetchedAt"] = fetched_at
                self.assertIn("manifest-fetched-at", codes(validate_raw_manifest(manifest)))
        good_values = [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:00.5Z",
            "2024-06-30T23:59:60Z",  # RFC 3339 leap second
            "2024-01-01T00:59:60+01:00",  # leap second at UTC 23:59:60 after offset adjustment
            "2024-01-01T00:00:00+05:30",
            "2024-01-01t00:00:00z",  # RFC 3339 allows lowercase
        ]
        for fetched_at in good_values:
            with self.subTest(fetched_at=fetched_at):
                manifest = self.valid_manifest()
                manifest["fetchedAt"] = fetched_at
                self.assertEqual(validate_raw_manifest(manifest), [])

    def test_years_required_array_of_four_digit_strings(self):
        bad_values = [None, "2024", {}, ["24"], ["2024-01"], [2024], ["20x4"], ["2024\n"], ["٢٠٢٤"]]
        for years in bad_values:
            with self.subTest(years=years):
                manifest = self.valid_manifest()
                manifest["years"] = years
                self.assertIn("manifest-years", codes(validate_raw_manifest(manifest)))

    def test_years_missing_rejected(self):
        manifest = self.valid_manifest()
        del manifest["years"]
        self.assertIn("manifest-years", codes(validate_raw_manifest(manifest)))

    def test_empty_years_accepted(self):
        # The schema allows an empty array; only the four-digit string item
        # shape is enforced per item.
        manifest = self.valid_manifest()
        manifest["years"] = []
        self.assertEqual(validate_raw_manifest(manifest), [])

    def test_years_duplicates_rejected(self):
        # Declared invariant, mirrored by uniqueItems in the schema.
        manifest = self.valid_manifest()
        manifest["years"] = ["2024", "2023", "2024"]
        found = codes(validate_raw_manifest(manifest))
        self.assertIn("manifest-years-duplicate", found)

    def test_coverage_must_be_object(self):
        for bad in ("everything", ["all"], 3, True):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["coverage"] = bad
                self.assertIn("manifest-coverage", codes(validate_raw_manifest(manifest)))

    def test_warnings_must_be_array_of_strings(self):
        for bad in ("none", {}, [1], ["ok", None]):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["warnings"] = bad
                self.assertIn("manifest-warnings", codes(validate_raw_manifest(manifest)))

    def test_unknown_snapshot_field_rejected(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["payloadHash"] = "a" * 64
        self.assertIn("snapshot-field", codes(validate_raw_manifest(manifest)))

    def test_http_status_must_be_nonnegative_integer(self):
        # 2.0 parses as a float in Python but as the integer 2 in JavaScript,
        # so this float-encoded-integer pin lives Python-side (see the Node
        # parity test's notes on JSON floats).
        for bad in (-1, True, "200", 1.5, 2.0, None):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["snapshots"][1]["httpStatus"] = bad
                self.assertIn("snapshot-http-status", codes(validate_raw_manifest(manifest)))

    def test_http_status_optional(self):
        manifest = self.valid_manifest()
        del manifest["snapshots"][1]["httpStatus"]
        self.assertEqual(validate_raw_manifest(manifest), [])

    def test_observed_at_must_be_rfc3339_date_time(self):
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["observedAt"] = "2024-01-01"
        self.assertIn("snapshot-observed-at", codes(validate_raw_manifest(manifest)))
        manifest["snapshots"][0]["observedAt"] = "2024-01-01T12:34:56.789Z"
        self.assertEqual(validate_raw_manifest(manifest), [])

    def test_payload_hash_must_be_string_lowercase_64_hex(self):
        # A 64-digit integer must not be accepted by stringifying it.
        for bad in (int("1" * 64), "A" * 64, "a" * 63, "a" * 65, "g" * 64, "a" * 64 + "\n", None, 1.0):
            with self.subTest(bad=bad):
                manifest = self.valid_manifest()
                manifest["snapshots"][0]["payloadSha256"] = bad
                self.assertIn("snapshot-hash", codes(validate_raw_manifest(manifest)))

    def test_path_trailing_newline_rejected(self):
        # Parity with the schema pattern: Python $ would otherwise accept a
        # trailing newline that the JSON Schema pattern rejects.
        manifest = self.valid_manifest()
        manifest["snapshots"][0]["path"] = "raw/year-2024.json\n"
        self.assertIn("snapshot-path", codes(validate_raw_manifest(manifest)))

    def test_reproduced_case_missing_years_negative_http_status_string_coverage(self):
        manifest = self.valid_manifest()
        del manifest["years"]
        manifest["snapshots"] = [
            {
                "kind": "year",
                "id": "2024",
                "path": "raw/year-2024.json",
                "status": "present",
                "payloadSha256": "a" * 64,
            },
            {"kind": "month", "id": "2024-02", "status": "absent", "httpStatus": -5},
        ]
        manifest["coverage"] = "everything"
        found = codes(validate_raw_manifest(manifest))
        self.assertIn("manifest-years", found)
        self.assertIn("snapshot-http-status", found)
        self.assertIn("manifest-coverage", found)

    def test_fully_pathless_absent_manifest_accepted(self):
        manifest = self.valid_manifest()
        manifest["snapshots"] = [
            {
                "kind": "year",
                "id": "2024",
                "status": "absent",
                "httpStatus": 404,
                "observedAt": "2024-01-01T00:00:00Z",
            },
            {"kind": "month", "id": "2024-03", "status": "absent"},
        ]
        self.assertEqual(validate_raw_manifest(manifest), [])


if __name__ == "__main__":
    unittest.main()
