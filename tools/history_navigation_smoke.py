"""Recorded-place history links and navigation, using isolated browser contexts."""
import argparse
from pathlib import Path
import tempfile
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright


EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def parameters(address):
    return parse_qs(urlsplit(address).fragment.partition("?")[2])


def ready(page, address):
    page.goto(address, wait_until="networkidle")
    expect(page.locator("#loading")).to_be_hidden()


def choose_place(page, name="Warsaw, Poland"):
    page.locator("[data-country-search]").fill(name)
    page.locator("[data-history-search] button").click()
    expect(page.locator("[data-country-search]")).to_have_value(name)
    expect(page.locator("[data-search-status]")).to_contain_text(name)
    assert parameters(page.url).get("place") == [name], page.url


def scale(page):
    return page.locator(".camera").evaluate("(node) => Number(node.getAttribute('transform').match(/scale\\(([^)]+)\\)/)[1])")


def camera_frame(page):
    return page.locator(".camera").evaluate("""node => {
      const matrix=node.transform.baseVal.consolidate().matrix;
      return [matrix.e,matrix.f,matrix.a];
    }""")


def expect_frame(page, expected):
    actual = camera_frame(page)
    assert all(abs(a - b) < tolerance for a, b, tolerance in zip(actual, expected, [.5, .5, .001])), (actual, expected)


def copy_map(page):
    page.evaluate("""() => Object.defineProperty(navigator,'clipboard',{configurable:true,
      value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError')}}})""")
    page.locator("[data-act='share-map']").click()
    field = page.locator("[data-share-address]")
    expect(field).to_be_visible()
    address = field.input_value()
    page.locator("[data-act='close-share']").click()
    return address


def run(browser, base, output, camera_checks):
    failures = []
    for width in [320, 768, 1440]:
        context = browser.new_context(viewport={"width": width, "height": 900 if width > 768 else 800},
                                      reduced_motion="reduce")
        context.on("page", lambda page: page.on("pageerror", lambda error: failures.append(str(error))))
        try:
            page = context.new_page()
            ready(page, base + "/#/patterns/1951")
            choose_place(page)
            assert abs(scale(page) - 4) < .01
            page.reload(wait_until="networkidle")
            expect(page.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
            assert page.title().startswith("Warsaw, Poland, 1951")
            assert abs(scale(page) - 4) < .01
            copied = copy_map(page)
            assert parameters(copied)["place"] == ["Warsaw, Poland"]
            target = context.new_page()
            ready(target, copied)
            expect(target.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
            assert abs(scale(target) - 4) < .01
            target.close()
            page.locator("[data-country-search]").fill("Unsubmitted research")
            assert parameters(page.url)["place"] == ["Warsaw, Poland"]
            page.locator("[data-country-search]").fill("")
            assert "place" not in parameters(page.url)
            choose_place(page)
            page.screenshot(path=str(output / f"history-place-{width}.png"))
            if camera_checks:
                if width == 1440:
                    page.mouse.move(650, 500)
                    page.mouse.down()
                    page.mouse.move(720, 540, steps=8)
                    page.mouse.up()
                    panned = camera_frame(page)
                    page.reload(wait_until="networkidle")
                    expect_frame(page, panned)
                page.locator("[data-act='zoom-in']").click()
                before = scale(page)
                frame = camera_frame(page)
                assert before > 4
                page.reload(wait_until="networkidle")
                assert abs(scale(page) - before) < .01
                expect_frame(page, frame)
                page.locator("#topbar [data-view='about']").click()
                page.locator("#topbar [data-view='patterns']").click()
                expect(page.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
                assert abs(scale(page) - before) < .01, (width, before, scale(page))
                expect_frame(page, frame)
                page.reload(wait_until="networkidle")
                assert abs(scale(page) - before) < .01
                expect_frame(page, frame)
                page.locator("#topbar [data-view='explore']").click()
                page.locator("[data-act='zoom-in']").click()
                page.locator("#topbar [data-view='patterns']").click()
                assert abs(scale(page) - before) < .01
                expect_frame(page, frame)
                page.go_back(wait_until="networkidle")
                page.go_back(wait_until="networkidle")
                expect(page.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
                assert abs(scale(page) - before) < .01
                expect_frame(page, frame)
                page.screenshot(path=str(output / f"history-return-{width}.png"))
            print(f"PASS {width}px named place, reload, shared link, cleared/unsubmitted input"
                  + (", cross-view camera and Back" if camera_checks else ""))
        finally:
            context.close()

    context = browser.new_context(reduced_motion="reduce")
    context.on("page", lambda page: page.on("pageerror", lambda error: failures.append(str(error))))
    try:
        page = context.new_page()
        for pairs in [
            [("place", "")], [("place", "Not in the archive")],
            [("place", "Warsaw, Poland"), ("place", "Korea")],
            [("place", "Warsaw, Poland"), ("country", "Poland")],
            [("place", "Warsaw, Poland"), ("event", "not-an-event")],
            [("place", "Warsaw, Poland"), ("layer", "origins")],
            [("place", "<svg onload=alert(1)>")], [("place", "\u0141" * 201)],
        ]:
            ready(page, base + "/#/patterns/1951?" + urlencode(pairs))
            expect(page.locator("body")).to_have_attribute("data-view", "not-found")
        ready(page, base + "/#/patterns?" + urlencode({"place": "Warsaw, Poland"}))
        expect(page.locator("body")).to_have_attribute("data-view", "not-found")
        print("PASS empty, unknown, conflicting, duplicated, oversized and unsupported place addresses reject explicitly")

        ready(page, base + "/#/patterns/1951?" + urlencode({
            "place": "Warsaw, Poland", "flags": "0", "compare": "1", "opacity": ".4", "split": "65",
        }))
        expect(page.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
        assert parameters(copy_map(page))["place"] == ["Warsaw, Poland"]
        page.locator("[data-act='next-year']").click()
        assert parameters(page.url)["place"] == ["Warsaw, Poland"]
        expect(page.locator("[data-year-entry]")).to_have_value("1952")
        page.reload(wait_until="networkidle")
        expect(page.locator("[data-country-search]")).to_have_value("Warsaw, Poland")
        assert parameters(page.url)["flags"] == ["0"]
        assert parameters(page.url)["compare"] == ["1"]
        print("PASS changing the border year and display layers retains the named source place")
    finally:
        context.close()
    assert not failures, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8124")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--camera", action="store_true", help="Also verify cross-view camera continuity")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ohp-history-navigation-") as directory, sync_playwright() as playwright:
        output = args.output or Path(directory)
        output.mkdir(parents=True, exist_ok=True)
        browser = playwright.chromium.launch(executable_path=EDGE, headless=True)
        try:
            run(browser, args.base.rstrip("/"), output, args.camera)
        finally:
            browser.close()
    print("All history navigation checks passed.")


if __name__ == "__main__":
    main()
