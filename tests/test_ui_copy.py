from pipeline import config


def _authored_copy() -> str:
    paths = [
        config.ROOT / "index.html",
        config.ROOT / "embed.html",
        config.ROOT / "js" / "ui.js",
        config.ROOT / "js" / "app.js",
        config.DATA / "war_context.json",
    ]
    content = []
    for path in paths:
        lines = path.read_text(encoding="utf-8").splitlines()
        content.extend(line for line in lines if not line.lstrip().startswith("//"))
    return "\n".join(content).lower()


def test_authored_interface_copy_avoids_ai_writing_patterns():
    content = _authored_copy()
    assert "—" not in content
    assert "–" not in content
    for phrase in (
        "a map made of remembering",
        "history carried them",
        "the shape of a life",
        "we do not pretend",
        "everyone is here",
        "stands as",
        "serves as",
        "vibrant",
        "tapestry",
        "testament",
    ):
        assert phrase not in content
