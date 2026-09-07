"""Browser regressions for private saved-list backups; no server-side writes."""
import argparse
import json
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright


KEY = "ohp-map.saved-accounts.v1"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def backup(ids):
    return json.dumps({"format": "ohp-saved-accounts", "version": 1, "ids": ids}).encode()


def saved(page):
    return page.evaluate("(key) => JSON.parse(localStorage.getItem(key))?.ids || []", KEY)


def open_saved(context, base, ids, width=1440, query=""):
    page = context.new_page()
    page.set_viewport_size({"width": width, "height": 900 if width > 768 else 800})
    page.add_init_script("""
        if (!sessionStorage.getItem('saved-backup-test-seeded')) {
          localStorage.setItem(%s, %s);
          sessionStorage.setItem('saved-backup-test-seeded', '1');
        }
    """ % (json.dumps(KEY), json.dumps(json.dumps({"version": 1, "ids": ids}))))
    page.goto(base + "/#/explore?saved=1" + query, wait_until="networkidle")
    expect(page.locator("#loading")).to_be_hidden()
    return page


def manage(page):
    page.locator("[data-act='manage-saved-list']").click()
    dialog = page.locator("#saved-list-dialog")
    expect(dialog).to_be_visible()
    return dialog


def choose(page, payload, name="ohp-saved-accounts.json"):
    page.locator("#saved-backup-file").set_input_files({
        "name": name, "mimeType": "application/json", "buffer": payload,
    })
    expect(page.locator("#saved-list-dialog")).to_have_attribute("aria-busy", "false")


def download(page, output):
    with page.expect_download() as event:
        page.locator("[data-download-saved-backup]").click()
    event.value.save_as(output)
    return json.loads(output.read_text(encoding="utf-8"))


def check_layout(page):
    result = page.locator("#saved-list-dialog").evaluate("""dialog => {
      const body=dialog.querySelector('.research-dialog-body');
      const buttons=[...dialog.querySelectorAll('button,input[type=file]')].filter(e=>e.getClientRects().length);
      return {overflow:body.scrollWidth>body.clientWidth+1,
        pageOverflow:document.documentElement.scrollWidth>innerWidth,
        targets:buttons.filter(e=>e.getBoundingClientRect().height<44).length,
        heading:dialog.querySelector('h2').textContent,
        labelled:dialog.getAttribute('aria-labelledby')===dialog.querySelector('h2').id};
    }""")
    assert not result["overflow"] and not result["pageOverflow"], result
    assert result["targets"] == 0 and result["labelled"], result


def responsive_round_trip(browser, base, width, output, errors):
    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        initial = ["adam-wally", "ferguson-george", "unavailable-backup-test"]
        page = open_saved(context, base, initial, width, "&q=Wally+Adam")
        manage(page)
        assert download(page, output / f"saved-backup-{width}.json")["ids"] == initial
        check_layout(page)
        page.screenshot(path=str(output / f"saved-backup-{width}.png"))
        candidate = backup(["adam-wally", "adler-amek", "unavailable-import-test", "adler-amek"])
        choose(page, candidate, "\u0179r\u00f3d\u0142o-" * 30 + ".json")
        expect(page.locator("[data-restore-saved-backup]")).to_have_text("Add 2 accounts")
        assert saved(page) == initial
        page.keyboard.press("Escape")
        expect(page.locator("[data-act='manage-saved-list']")).to_be_focused()
        assert saved(page) == initial
        manage(page)
        choose(page, candidate)
        check_layout(page)
        page.locator("#saved-backup-file").focus()
        page.keyboard.press("Tab")
        expect(page.locator("[data-restore-saved-backup]")).to_be_focused()
        page.screenshot(path=str(output / f"saved-restore-{width}.png"))

        other = context.new_page()
        other.goto(base + "/collection?q=backup-test-no-match", wait_until="networkidle")
        other.evaluate("(value) => localStorage.setItem(%s, JSON.stringify(value))" % json.dumps(KEY),
                       {"version": 1, "ids": initial + ["adler-amek", "baker-norman"]})
        expect(page.locator("[data-restore-saved-backup]")).to_have_text("Add 1 account")
        page.locator("[data-restore-saved-backup]").evaluate("(button) => {button.click();button.click()}")
        expect(page.locator("[data-saved-import-status]")).to_contain_text("1 account added")
        expected = initial + ["adler-amek", "baker-norman", "unavailable-import-test"]
        assert saved(page) == expected
        page.keyboard.press("Escape")
        page.reload(wait_until="networkidle")
        assert saved(page) == expected
        assert "q=Wally+Adam" in page.url
        print(f"PASS {width}px filtered backup, preview, cancel, keyboard, cross-tab merge, duplicate submit and reload")
    finally:
        context.close()


def corpus_transfer(browser, base, output, errors):
    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        response = context.request.get(base + "/data/index.json")
        assert response.ok
        ids = [feature["properties"]["survivor_id"] for feature in response.json()["features"]]
        page = open_saved(context, base, ids)
        manage(page)
        data_requests = []
        page.on("request", lambda request: data_requests.append(request.url)
                if "/data/" in request.url else None)
        payload = download(page, output / "saved-backup-entire-corpus.json")
        assert set(payload["ids"]) == set(ids) and len(payload["ids"]) == len(ids)
        assert len(json.dumps(payload)) > 7000
        assert not data_requests, data_requests
    finally:
        context.close()
    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        page = open_saved(context, base, [])
        manage(page)
        expect(page.locator("[data-download-saved-backup]")).to_be_disabled()
        expect(page.locator("#saved-backup-file")).to_be_focused()
        choose(page, json.dumps(payload).encode())
        assert not saved(page)
        page.locator("[data-restore-saved-backup]").click()
        assert set(saved(page)) == set(ids)
        page.keyboard.press("Escape")
        page.reload(wait_until="networkidle")
        assert len(saved(page)) == len(ids)
        print(f"PASS complete {len(ids)}-account transfer into a fresh browser, no additional data fetches for backup")
    finally:
        context.close()


def failure_and_race_checks(browser, base, output, errors):
    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        page = open_saved(context, base, ["adam-wally"])
        manage(page)
        for payload, message in [
            (b"{", "not valid JSON"),
            (b'{"format":"ohp-saved-accounts","version":2,"ids":[]}', "not a supported"),
            (b" " * 1_000_001, "larger than 1 MB"),
            (backup([]), "backup is empty"),
        ]:
            choose(page, payload)
            expect(page.locator("[data-saved-import-status]")).to_contain_text(message)
            expect(page.locator("[data-restore-saved-backup]")).to_be_disabled()
            assert saved(page) == ["adam-wally"]
        page.evaluate("""() => {
          window.originalFileText=File.prototype.text;
          File.prototype.text=function() {throw new DOMException('Read denied','NotReadableError')};
        }""")
        choose(page, backup(["adler-amek"]))
        expect(page.locator("[data-saved-import-status]")).to_contain_text("could not be read")
        page.evaluate("() => {File.prototype.text=window.originalFileText}")
        choose(page, backup(["adler-amek"]))
        page.evaluate("""() => {
          window.originalStorageSet=Storage.prototype.setItem;
          Storage.prototype.setItem=function(key,value) {
            if(key==='ohp-map.saved-accounts.v1')throw new DOMException('Storage full','QuotaExceededError');
            return window.originalStorageSet.call(this,key,value);
          };
        }""")
        page.locator("[data-restore-saved-backup]").click()
        expect(page.locator("[data-saved-import-status]")).to_contain_text("could not be added")
        assert saved(page) == ["adam-wally"]
        page.evaluate("() => {Storage.prototype.setItem=window.originalStorageSet}")
        page.locator("[data-restore-saved-backup]").click()
        assert saved(page) == ["adam-wally", "adler-amek"]
        print("PASS invalid, empty, oversized, unreadable and storage-denied files preserve existing data; retry succeeds")

        page.evaluate("""() => {
          File.prototype.text=function() {
            if(this.name==='slow.json')return new Promise(resolve=>{window.resolveSlowBackup=resolve});
            return window.originalFileText.call(this);
          };
        }""")
        page.locator("#saved-backup-file").set_input_files({
            "name": "slow.json", "mimeType": "application/json", "buffer": backup(["ferguson-george"]),
        })
        expect(page.locator("#saved-list-dialog")).to_have_attribute("aria-busy", "true")
        choose(page, backup(["baker-norman"]))
        page.evaluate("(text) => window.resolveSlowBackup(text)", backup(["ferguson-george"]).decode())
        expect(page.locator("[data-saved-import-preview]")).to_contain_text("Norman Baker")
        assert "George Ferguson" not in page.locator("[data-saved-import-preview]").inner_text()
        page.locator("#saved-backup-file").set_input_files({
            "name": "slow.json", "mimeType": "application/json", "buffer": backup(["ferguson-george"]),
        })
        page.keyboard.press("Escape")
        page.evaluate("(text) => window.resolveSlowBackup(text)", backup(["ferguson-george"]).decode())
        expect(page.locator("#saved-list-dialog")).to_have_count(0)
        assert saved(page) == ["adam-wally", "adler-amek"]
        manage(page)
        page.locator("#saved-backup-file").set_input_files({
            "name": "slow.json", "mimeType": "application/json", "buffer": backup(["ferguson-george"]),
        })
        page.evaluate("() => {location.hash='/about'}")
        expect(page.locator("#saved-list-dialog")).to_have_count(0)
        page.evaluate("(text) => window.resolveSlowBackup(text)", backup(["ferguson-george"]).decode())
        assert saved(page) == ["adam-wally", "adler-amek"]
        print("PASS superseded reads, Escape and navigation cannot commit or reopen stale imports")

        page.goto(base + "/#/explore?saved=1", wait_until="networkidle")
        manage(page)
        context.set_offline(True)
        assert download(page, output / "saved-backup-offline.json")["ids"] == ["adam-wally", "adler-amek"]
        choose(page, backup(["baker-norman"]))
        page.locator("[data-restore-saved-backup]").click()
        assert saved(page) == ["adam-wally", "adler-amek", "baker-norman"]
        context.set_offline(False)
        print("PASS backup and restore need no network once the archive is loaded")

        page.keyboard.press("Escape")
        page.evaluate("(key) => localStorage.setItem(key, '{\"version\":2,\"ids\":[\"keep-me\"]}')", KEY)
        manage(page)
        choose(page, backup(["ferguson-george"]))
        expect(page.locator("[data-restore-saved-backup]")).to_be_disabled()
        assert page.evaluate("(key) => localStorage.getItem(key)", KEY) == '{"version":2,"ids":["keep-me"]}'
        print("PASS a damaged receiving list is not overwritten by a valid backup")
    finally:
        context.close()

    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        page = open_saved(context, base, [])
        manage(page)
        ids = [f"unavailable-test-{index}" for index in range(10_000)]
        choose(page, backup(ids))
        expect(page.locator("[data-restore-saved-backup]")).to_have_text("Add 10000 accounts")
        page.locator("[data-restore-saved-backup]").click()
        assert saved(page) == ids
        assert download(page, output / "saved-backup-10000.json")["ids"] == ids
        print("PASS 10,000 synthetic identifiers round-trip without truncation or invented accounts")
    finally:
        context.close()


def unavailable_account_checks(browser, base, output, errors):
    context = browser.new_context(reduced_motion="reduce", accept_downloads=True)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    try:
        page = open_saved(context, base, ["unavailable-backup-test"], width=320)
        expect(page.locator(".rail-empty")).to_contain_text("Saved accounts are not in this snapshot")
        expect(page.locator("[data-explore-hint]")).to_contain_text("Your saved accounts are not in this snapshot")
        notice = page.locator("[data-reading-list-tools] .shared-list-warning")
        expect(notice).to_contain_text("1 account is not available")
        expect(notice).to_contain_text("remains in your saved list and backups")
        page.screenshot(path=str(output / "saved-unavailable-320.png"))
        page.locator(".saved-view").click()
        expect(page.locator(".saved-view > span")).to_have_text("1")
        page.locator(".saved-view").click()
        with page.expect_navigation(wait_until="networkidle"):
            page.locator("[data-act='reload-collection']").click()
        expect(page.locator(".rail-empty")).to_contain_text("Saved accounts are not in this snapshot")
        manage(page)
        assert page.locator("[data-download-saved-backup]").evaluate("(button) => button.classList.contains('btn-ghost')")
        assert download(page, output / "saved-backup-unavailable.json")["ids"] == ["unavailable-backup-test"]
        page.keyboard.press("Escape")
        page.evaluate("(key) => localStorage.setItem(key, JSON.stringify({version:1,ids:['adam-wally','unavailable-backup-test']}))", KEY)
        page.reload(wait_until="networkidle")
        expect(notice).to_contain_text("1 account is not available")
        page.locator("#search").fill("no-match-in-this-collection")
        expect(page.locator(".rail-empty")).to_contain_text("No account matches every search term")
        expect(page.locator(".rail-empty")).not_to_contain_text("Saved accounts are not in this snapshot")
        expect(page.locator("[data-explore-hint]")).to_contain_text("No accounts match these filters")
        page.locator(".rail-empty [data-act='reset-search']").click()
        expect(page.locator(".rail [data-survivor='adam-wally']")).to_be_visible()
        assert saved(page) == ["adam-wally", "unavailable-backup-test"]
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("[data-act='reset-saved-list']").click()
        expect(page.locator(".rail-empty")).to_contain_text("Keep an account for later")
        expect(page.locator("[data-explore-hint]")).to_contain_text("Your saved list is empty")
        expect(notice).to_have_count(0)
        print("PASS unavailable, mixed, filtered and truly empty saved lists stay distinct; counts, retry and backup retain missing IDs")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8124")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ohp-saved-list-") as temporary, sync_playwright() as playwright:
        output = args.output or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        errors = []
        browser = playwright.chromium.launch(headless=True, executable_path=EDGE)
        try:
            for width in [320, 768, 1440]:
                responsive_round_trip(browser, args.base.rstrip("/"), width, output, errors)
            corpus_transfer(browser, args.base.rstrip("/"), output, errors)
            failure_and_race_checks(browser, args.base.rstrip("/"), output, errors)
            unavailable_account_checks(browser, args.base.rstrip("/"), output, errors)
            assert not errors, errors
            print("All saved-list browser regressions passed.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
