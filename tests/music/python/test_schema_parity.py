"""Parity between the Python manifest validator and the JSON Schema contract.

Every case in tests/music/fixtures/manifest-cases.json is evaluated here by
the authoritative validate_raw_manifest and (in
tests/music/node/schema-parity.test.mjs) by the JSON Schema compiled from
contracts/raw-snapshot.schema.json in strict draft-2020-12 mode. Both must
agree with each case's expected validity, so contract drift between the
duplicated implementations cannot pass all tests unnoticed.

Cases that cannot be shared with the Node side (JSON float-encoded integers,
year-0000 timestamps, control-character whitespace) are pinned in
test_validate.py; see the notes in the Node test for the rationale.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CANONICALIZE_DIR = os.path.join(REPO, "scripts", "music-pipeline", "canonicalize")
sys.path.insert(0, CANONICALIZE_DIR)

from validate import validate_raw_manifest  # noqa: E402

CORPUS_PATH = os.path.join(REPO, "tests", "music", "fixtures", "manifest-cases.json")


def load_corpus():
    with open(CORPUS_PATH, encoding="utf-8") as f:
        return json.load(f)["cases"]


class CorpusWellFormedTest(unittest.TestCase):
    def test_cases_have_stable_names_manifests_and_flags(self):
        cases = load_corpus()
        self.assertGreater(len(cases), 0)
        seen = set()
        for case in cases:
            with self.subTest(name=case.get("name")):
                self.assertIsInstance(case["name"], str)
                self.assertNotEqual(case["name"], "")
                self.assertNotIn(case["name"], seen, f"duplicate case name: {case['name']}")
                seen.add(case["name"])
                self.assertIn("manifest", case)
                self.assertIsInstance(case["valid"], bool)


class SchemaParityTest(unittest.TestCase):
    def test_validator_agrees_with_expected_validity(self):
        for case in load_corpus():
            with self.subTest(name=case["name"]):
                errors = validate_raw_manifest(case["manifest"])
                self.assertEqual(
                    errors == [],
                    case["valid"],
                    f"validator {'rejected' if errors else 'accepted'} case {case['name']!r}: "
                    f"{json.dumps(errors, ensure_ascii=False)}",
                )


if __name__ == "__main__":
    unittest.main()
