"""Verify native browser PDFs preserve complete source sheets and reader state."""
import argparse
import json
from pathlib import Path
import tempfile
import unicodedata

from playwright.sync_api import sync_playwright
from pypdf import PdfReader


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).split())


def pdf_text(path, footer=None):
    reader = PdfReader(path)
    pages = []
    for index, page in enumerate(reader.pages, 1):
        lines = (page.extract_text() or "").splitlines()
        if lines and lines[0].strip() == str(index):
            lines.pop(0)
        if footer:
            if lines and source_characters(lines[0]) in {
                str(index) + source_characters(footer), source_characters(footer) + str(index),
            }:
                lines.pop(0)
            lines = [line for line in lines if source_characters(line) != source_characters(footer)]
        pages.append("\n".join(lines))
    return reader, normalized("\n".join(pages))


def source_characters(value):
    # Some embedded PDF fonts map typographic punctuation to a replacement glyph.
    return "".join(character for character in unicodedata.normalize("NFKC", value) if character.isalnum())


def verify(base, output, executable):
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            for identifier in ["adam-wally", "ferguson-george"]:
                page.goto(f"{base}/survivor/{identifier}", wait_until="networkidle")
                page.locator(".panel[data-profile-state='ready']").wait_for()
                assert page.locator("[data-act='print-account']").is_enabled()
                name = page.locator("#profile-name").inner_text()
                places = page.locator(".profile-places .step-place").all_text_contents()
                biography = page.locator(".bio").inner_text()
                page.locator("[data-act='read-full-biography']").click()
                page.locator(".full-biography-text").wait_for()
                full_biography = page.locator(".full-biography-text").inner_text()
                page.keyboard.press("Escape")
                page.locator(".map-tools [data-act='zoom-in']").click()
                page.wait_for_timeout(200)
                camera = page.locator(".camera").get_attribute("transform")
                path = output / f"{identifier}-reading-sheet.pdf"
                page.pdf(path=str(path), format="A4", print_background=True)
                document, text = pdf_text(path, f"{name} · Crestwood Oral History Project")
                assert all(normalized(place) in text for place in places), f"{identifier}: a place was clipped"
                assert normalized(biography) in text, f"{identifier}: the summary was clipped"
                assert source_characters(full_biography) in source_characters(text), f"{identifier}: the full source biography was clipped"
                assert "Accessed" in text and "not a verbatim interview transcript" in text
                assert "Name, place or period" not in text, "The interactive controls were printed"
                assert all(normalized(name) in normalized(part.extract_text() or "") for part in document.pages), "A page lost its account identity"
                if identifier == "ferguson-george":
                    assert len(document.pages) > 1, "The long account did not paginate"
                page.wait_for_timeout(250)
                assert page.locator("#print-sheet").count() == 0
                assert page.locator(".camera").get_attribute("transform") == camera
                results.append({"account": identifier, "pages": len(document.pages), "references": len(places),
                                "biography_characters": len(full_biography), "complete": True})

            page.goto(f"{base}/?print-list-test=1#/explore?list=adler-amek,baranek-martin", wait_until="networkidle")
            page.locator("#loading").wait_for(state="hidden")
            saved = page.evaluate("localStorage.getItem('ohp-map.saved-accounts.v1')")
            path = output / "shared-reading-list.pdf"
            page.pdf(path=str(path), format="Letter", print_background=True)
            document, text = pdf_text(path)
            assert "Amek Adler" in text and "Martin Baranek" in text and "Wally Adam" not in text
            assert len(document.pages) == 1, "Two source citations created an unnecessary extra page"
            assert text.count("Accessed") == 2 and "do not infer interview dates" in text
            assert page.evaluate("localStorage.getItem('ohp-map.saved-accounts.v1')") == saved
            results.append({"reading_list": 2, "pages": len(document.pages), "private_saves_unchanged": True})

            fallback = browser.new_page(java_script_enabled=False)
            fallback.goto(f"{base}/survivor/ferguson-george", wait_until="networkidle")
            source = fallback.locator("#server-profile blockquote").inner_text()
            places = fallback.locator("#server-profile li strong").all_text_contents()
            path = output / "server-readable-account.pdf"
            fallback.pdf(path=str(path), format="A4", print_background=True)
            document, text = pdf_text(path)
            assert source_characters(source) in source_characters(text)
            assert all(source_characters(place) in source_characters(text) for place in places)
            results.append({"without_javascript": True, "pages": len(document.pages), "references": len(places), "complete": True})
            source_reader = browser.new_page()
            source_reader.goto(f"{base}/survivor/ferguson-george?reader=source", wait_until="networkidle")
            source = source_reader.locator("#server-profile blockquote").inner_text()
            places = source_reader.locator("#server-profile li strong").all_text_contents()
            assert source_reader.locator("script,#stage").count() == 0
            path = output / "source-only-reader.pdf"
            source_reader.pdf(path=str(path), format="A4", print_background=True)
            document, text = pdf_text(path)
            assert source_characters(source) in source_characters(text), "The script-free PDF lost source text"
            assert all(source_characters(place) in source_characters(text) for place in places)
            positions = []

            def record_position(text, matrix, text_matrix, _font, _size):
                if text.strip():
                    positions.append(text_matrix[4] * matrix[0] + text_matrix[5] * matrix[2] + matrix[4])

            for sheet in document.pages:
                sheet.extract_text(visitor_text=record_position)
            assert positions and min(positions) >= 12 * 72 / 25.4, "The source-only reader lost its print margins"
            results.append({"source_only_javascript_enabled": True, "pages": len(document.pages),
                            "references": len(places), "minimum_text_margin_mm": round(min(positions) * 25.4 / 72, 2),
                            "complete": True})
            assert not errors, errors
        finally:
            browser.close()
    print(json.dumps(results, indent=2))
    print("PASS native account/list PDFs, pagination, source caveats, no-JS fallback and reader restoration")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8124")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--browser")
    args = parser.parse_args()
    edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    executable = args.browser or (str(edge) if edge.exists() else None)
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        verify(args.base.rstrip("/"), args.output, executable)
    else:
        with tempfile.TemporaryDirectory(prefix="ohp-print-") as folder:
            verify(args.base.rstrip("/"), Path(folder), executable)


if __name__ == "__main__":
    main()
