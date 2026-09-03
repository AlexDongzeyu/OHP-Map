"""Deployment contracts for the Cloudflare live archive refresh."""
from pathlib import Path
import tomllib


ROOT = Path(__file__).resolve().parents[1]


def test_live_refresh_has_hourly_cron_and_kv_binding():
    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))
    assert config["triggers"]["crons"] == ["7 * * * *"]
    assert config["kv_namespaces"][0]["binding"] == "OHP_DATA"
    assert config["kv_namespaces"][0]["id"] != "PASTE_YOUR_KV_NAMESPACE_ID_HERE"


def test_live_refresh_covers_both_veteran_indexes_and_all_categories():
    source = (ROOT / "worker" / "sync.js").read_text(encoding="utf-8")
    for category in (
        "holocaust-survivors",
        "military-veterans-al",
        "military-veterans-mz",
        "community-members",
        "first-nations",
        "crestwood-families",
    ):
        assert f'"{category}"' in source
    assert "const DETAIL_BUDGET = 30" in source
    assert "deferred_failures" in source


def test_sync_status_is_observable_but_manual_refresh_is_guarded():
    source = (ROOT / "worker" / "index.js").read_text(encoding="utf-8")
    assert 'url.pathname === "/__sync/status"' in source
    assert "env.SYNC_TOKEN" in source
    assert 'request.method !== "POST"' in source


def test_pending_review_badge_is_not_in_the_header():
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    assert "status-pill" not in index
    assert "Pending review" not in index
