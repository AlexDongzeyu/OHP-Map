"""Rights and output contracts for generated OHP portraits."""
from pathlib import Path
import json

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "portraits" / "manifest.json"


def _manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def test_portrait_manifest_records_permission_and_sources():
    manifest = _manifest()
    assert manifest["portraits_built"] >= 900
    assert "permission granted" in manifest["permission_basis"].lower()
    assert not manifest["failures"]
    assert all(
        entry["source_url"].startswith(
            "https://ohp.crestwood.on.ca/wp-content/uploads/"
        )
        for entry in manifest["portraits"]
    )


def test_karol_portrait_is_generated_from_his_ohp_gallery():
    portraits = {
        entry["survivor_id"]: entry for entry in _manifest()["portraits"]
    }
    karol = portraits["abramowicz-karol"]
    assert "Karol" in karol["source_url"]
    assert (ROOT / karol["portrait"]).exists()


def test_veterans_use_centered_square_portraits():
    veterans = [
        record
        for record in _manifest()["portraits"]
        if record.get("group") == "Military Veterans"
    ]
    assert len(veterans) >= 600
    for record in veterans:
        path = ROOT / record["portrait"]
        assert path.exists()
        with Image.open(path) as image:
            assert image.size == (192, 192)
            assert image.format == "WEBP"
