import json
import re
import subprocess
import pytest

from pipeline import config, media
from pipeline.extract import OfflineExtractor
from pipeline.text import repair_source_quote


def _worker(code, payload=None):
    bootstrap = r"""
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const payload = JSON.parse(fs.readFileSync(0, 'utf8') || 'null');
      const mediaModule = await import('./worker/media.js');
      let source = fs.readFileSync('worker/sync.js', 'utf8')
        .replace('import gazetteer from "../data/gazetteer.json";',
          `const gazetteer = ${fs.readFileSync('data/gazetteer.json', 'utf8')};`)
        .replace('import geocodeCache from "../data/geocode_cache.json";',
          `const geocodeCache = ${fs.readFileSync('data/geocode_cache.json', 'utf8')};`)
        .replace('import otherMediaPages from "../data/source/ohp_media_pages.json";',
          `const otherMediaPages = ${fs.readFileSync('data/source/ohp_media_pages.json', 'utf8')};`)
        .replace('from "./media.js"', `from ${JSON.stringify(pathToFileURL(process.cwd() + '/worker/media.js').href)}`);
      source += '\nexport { extract, extractSlugs, parseEntry, toFeature, mergeFeature, migrateCachedData, sanitizeCachedFeature, sourceSentence, sentenceExcerpt, repairSourceQuote };';
      const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", bootstrap + code],
        cwd=config.ROOT, input=json.dumps(payload), capture_output=True, text=True, timeout=45,
        encoding="utf-8",
    )
    diagnostic = re.sub(r"data:text/javascript;base64,[A-Za-z0-9+/=]+", "(worker module)", result.stderr)
    assert result.returncode == 0, diagnostic[-5000:]
    return json.loads(result.stdout)


def test_worker_media_inventory_changes_reset_caption_status():
    script = r"""
      import { mergeMediaCoverage } from './worker/media.js';
      const complete = {
        video_count: 2,
        video_inventory: '2:aaaaaaaa',
        captioned_video_count: 2,
        transcript_status: 'complete',
      };
      const same = mergeMediaCoverage(complete, {
        video_count: 2,
        video_inventory: '2:aaaaaaaa',
        transcript_status: 'pending',
      });
      const replaced = mergeMediaCoverage(complete, {
        video_count: 2,
        video_inventory: '2:bbbbbbbb',
        transcript_status: 'pending',
      });
      const added = mergeMediaCoverage(complete, {
        video_count: 3,
        video_inventory: '3:cccccccc',
        transcript_status: 'pending',
      });
      const removed = mergeMediaCoverage(complete, {
        video_count: 0,
        video_inventory: '0:811c9dc5',
        transcript_status: 'none',
      });
      if (same.transcript_status !== 'complete' || same.captioned_video_count !== 2) process.exit(1);
      if (replaced.transcript_status !== 'pending' || replaced.captioned_video_count !== 0) process.exit(2);
      if (added.transcript_status !== 'pending' || added.captioned_video_count !== 0) process.exit(3);
      if (removed.transcript_status !== 'none' || removed.captioned_video_count !== 0) process.exit(4);
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=config.ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_idle_sync_preserves_live_media_and_only_supplements_matching_audits():
    result = _worker(r"""
      const video = (id, hash, status) => ({
        ...mediaModule.safeVimeoReference(`https://player.vimeo.com/video/${id}?h=${hash}`),
        title: `Chapter ${id}`, status,
      });
      const photo = (name) => ({
        url: `https://ohp.crestwood.on.ca/wp-content/uploads/2020/${name}.jpg`,
        source_url: `https://ohp.crestwood.on.ca/wp-content/uploads/2020/${name}.jpg`,
        rights: 'See source rights.', caption: name, credit: 'OHP',
      });
      const primary = {
        ...photo('portrait'), url: 'assets/portraits/person.webp',
        rights: 'Permission granted.', primary: true,
      };
      const feature = (media) => ({
        type: 'Feature', geometry: null,
        properties: {
          survivor_id: 'person', name: 'A Person', group: 'Military Veterans',
          review_status: 'reviewed', waypoints: [], profile_media: media,
        },
      });
      const metadata = {
        gazetteer_revision: worker.GAZETTEER_REVISION,
        content_revision: worker.CONTENT_REVISION,
      };
      const live = {metadata, features: [feature({
        images: [photo('live-photo')], videos: [
          video('1', 'newhash123', 'pending'), video('2', 'sharedhash', 'pending'),
        ],
      })]};
      const seed = {metadata, features: [feature({
        images: [primary, photo('removed-photo')], videos: [
          video('1', 'oldhash123', 'captioned'), video('2', 'sharedhash', 'captioned'),
          video('3', 'removed123', 'captioned'),
        ],
      })]};
      const database = new Map([[worker.DATA_KEY, JSON.stringify(live)]]);
      const env = {
        OHP_DATA: {
          get: async (key, type) => type === 'json'
            ? (database.has(key) ? JSON.parse(database.get(key)) : null) : (database.get(key) || null),
          put: async (key, value) => database.set(key, value),
        },
        ASSETS: {fetch: async () => new Response(JSON.stringify(seed))},
      };
      globalThis.fetch = async () => new Response('<a href="https://ohp.crestwood.on.ca/ohp/person/">A Person</a>');
      const status = await worker.syncSurvivors(env);
      const record = JSON.parse(database.get(worker.DATA_KEY)).features[0].properties;
      const removedAll = mediaModule.mergeSeedMediaCoverage({
        profile_media: {images: [], videos: []},
      }, seed.features[0].properties);
      console.log(JSON.stringify({status, record, removedAll}));
    """)
    assert result["status"]["profiles_checked"] == 0
    record = result["record"]
    assert [video["id"] for video in record["profile_media"]["videos"]] == ["1", "2"]
    assert "h=newhash123" in record["profile_media"]["videos"][0]["embed_url"]
    assert [video["status"] for video in record["profile_media"]["videos"]] == ["pending", "captioned"]
    assert record["captioned_video_count"] == 1
    images = record["profile_media"]["images"]
    assert images[0]["url"] == "assets/portraits/person.webp"
    assert any(image["url"].endswith("/live-photo.jpg") for image in images)
    assert not any(image["url"].endswith("/removed-photo.jpg") for image in images)
    assert result["removedAll"]["profile_media"]["videos"] == []


@pytest.mark.parametrize("existing", [False, True])
def test_invalid_source_preserves_backoff_for_new_and_refresh_profiles(existing):
    result = _worker(r"""
      const metadata = {
        gazetteer_revision: worker.GAZETTEER_REVISION,
        content_revision: worker.CONTENT_REVISION,
      };
      const feature = {
        type: 'Feature', geometry: null,
        properties: {
          survivor_id: 'retry-person', name: 'Retry Person', group: 'Military Veterans',
          review_status: 'pending', waypoints: [], profile_media: {images: [], videos: []},
        },
      };
      const seed = {metadata, features: payload ? [feature] : []};
      const database = new Map([[worker.DATA_KEY, JSON.stringify(seed)]]);
      const env = {
        OHP_DATA: {
          get: async (key, type) => type === 'json'
            ? (database.has(key) ? JSON.parse(database.get(key)) : null) : (database.get(key) || null),
          put: async (key, value) => database.set(key, value),
        },
        ASSETS: {fetch: async () => new Response(JSON.stringify(seed))},
      };
      let detailRequests = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes('/ohp-type/')) {
          return new Response('<a href="https://ohp.crestwood.on.ca/ohp/retry-person/">Retry Person</a>');
        }
        detailRequests++;
        return new Response('<html><h1>Temporarily unavailable</h1></html>');
      };
      await worker.syncSurvivors(env);
      const firstFailure = JSON.parse(database.get('ohp-fetch-failures.json'))['retry-person'];
      const seen = JSON.parse(database.get('ohp-seen-slugs.json'));
      const deferred = await worker.syncSurvivors(env);
      const beforeDeadline = detailRequests;
      const originalNow = Date.now;
      Date.now = () => Date.parse(firstFailure.retry_after) + 1;
      try {
        await worker.syncSurvivors(env);
      } finally {
        Date.now = originalNow;
      }
      const finalFailure = JSON.parse(database.get('ohp-fetch-failures.json'))['retry-person'];
      console.log(JSON.stringify({firstFailure, seen, deferred, beforeDeadline, detailRequests, finalFailure}));
    """, existing)
    assert result["firstFailure"]["attempts"] == 1
    assert ("retry-person" in result["seen"]) == existing
    assert result["deferred"]["profiles_checked"] == 0
    assert result["deferred"]["deferred_failures"] == 1
    assert result["beforeDeadline"] == 1
    assert result["detailRequests"] == 2
    assert result["finalFailure"]["attempts"] == 2


def test_worker_and_pipeline_share_public_source_media_parsing_and_fingerprints():
    page = """<article><div class="entry-content">
      <p>Mr. Example was born in Toronto. He went to St. Catharines.</p>
      <div id="ohp-video">
        <a href="https://player.vimeo.com/video/123?h=abcdef1234&amp;title=0&amp;token=private">School &amp; family</a>
        <a href="https://vimeo.com/124/987abc654f">Watch video</a>
        <a href="https://player.vimeo.com/video/123">Duplicate</a>
      </div>
      <div id="ohp-photo"><a href="https://ohp.crestwood.on.ca/wp-content/uploads/2020/person.jpg">
        <img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/person-150x150.jpg" alt="Source caption">
      </a><img src="https://ohp.crestwood.on.ca/wp-content/uploads/site-logo.png"></div>
    </div><!-- .entry-content --></article>"""
    archive = "https://ohp.crestwood.on.ca/ohp/person/"
    expected = media.parse_profile_media(page, archive, "Person")
    for video in expected["videos"]:
        video.pop("source_title", None)
    actual = _worker("""
      const value = mediaModule.parseProfileMedia(payload.page, payload.archive, 'Person');
      console.log(JSON.stringify({
        media: value, biography: mediaModule.sourceBiography(payload.page),
        ids: mediaModule.videoInventory(value.videos.map((video) => video.id)),
        refs: mediaModule.sourceInventory(value.videos),
      }));
    """, {"page": page, "archive": archive})
    assert actual["media"] == expected
    assert actual["biography"] == media.biography_text(page)
    assert actual["ids"] == media.video_inventory([video["id"] for video in expected["videos"]])
    assert actual["refs"] == media.source_inventory(expected["videos"])


def test_worker_and_pipeline_quote_spans_preserve_date_and_role_context():
    texts = [
        "Mr. Example went to St. Catharines in 1944. He later returned to Toronto.",
        "In 1944 he was born far away and " + "worked with his family " * 8 +
        "before he came to Canada where he remained.",
        "He trained in Glasgow, Scotland, then served in Dublin, Ireland.",
        "He was born in Vienna. He later passed through Italy and Switzerland before settling in Canada.",
        "He was interviewed in London, Ontario in August 2023.Davis, Frank",
    ]
    result = _worker("""
      console.log(JSON.stringify(payload.map((text) => worker.extract(text).map(
        ({ canonical, ...waypoint }) => waypoint
      ))));
    """, texts)
    assert result == [OfflineExtractor().extract(text) for text in texts]


def test_worker_repairs_split_source_blocks_without_changing_extracted_claims():
    page = (config.DATA / "source" / "pages_cache" / "scott-doug.html")
    if not page.exists():
        return
    actual = _worker("""
      const record = worker.parseEntry('scott-doug', payload, 'Military Veterans');
      console.log(JSON.stringify({record, feature: worker.toFeature(record)}));
    """, page.read_text(encoding="utf-8"))
    raw = next(
        person for person in json.loads((config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"))["people"]
        if person["survivor_id"] == "scott-doug"
    )
    expected = [
        repair_source_quote(waypoint, media.biography_text(page.read_text(encoding="utf-8")))
        for waypoint in OfflineExtractor().extract(raw["text"])
    ]
    actual_waypoints = actual["feature"]["properties"]["waypoints"]
    assert [
        {key: value for key, value in waypoint.items() if key not in {"canonical", "lat", "lng"}}
        for waypoint in actual_waypoints
    ] == expected
    assert actual_waypoints[1]["source_quote"] == (
        "He graduated from Upper Canada College and the University of Toronto."
    )


def test_worker_merges_only_matching_caption_results_and_retains_local_primary():
    actual = _worker("""
      const video = (id, hash, status) => ({
        ...mediaModule.safeVimeoReference(`https://player.vimeo.com/video/${id}?h=${hash}`),
        title: 'A source chapter', status,
      });
      const primary = {
        url: 'assets/portraits/person.webp',
        source_url: 'https://ohp.crestwood.on.ca/wp-content/uploads/2020/person.jpg',
        caption: 'Source photograph', credit: 'OHP', rights: 'Permission granted.', primary: true,
      };
      const old = {profile_media: {images: [primary], videos: [
        video('1', 'abcdef1234', 'captioned'), video('2', '1234abcdef', 'captioned'),
      ]}};
      const fresh = {profile_media: {images: [{...primary, primary: false, url: primary.source_url}], videos: [
        video('2', 'different1', 'pending'), video('1', 'abcdef1234', 'pending'),
      ]}};
      console.log(JSON.stringify(mediaModule.mergeMediaCoverage(old, fresh)));
    """)
    assert [video["id"] for video in actual["profile_media"]["videos"]] == ["2", "1"]
    assert [video["status"] for video in actual["profile_media"]["videos"]] == ["pending", "captioned"]
    assert actual["captioned_video_count"] == 1
    assert actual["transcript_status"] == "pending"
    assert len(actual["profile_media"]["images"]) == 1
    assert actual["profile_media"]["images"][0]["url"] == "assets/portraits/person.webp"


def test_content_migration_changes_quotes_and_media_but_not_existing_claims():
    result = _worker("""
      const waypoint = {
        as_written: 'Canada', canonical: 'Canada', role: 'transit', verified: false,
        lat: 50, lng: -100, date: {start: '1949', end: '1949', precision: 'year'},
        source_quote: 'came to Canada',
      };
      const feature = (id, verified = false) => ({
        type: 'Feature', geometry: {type: 'Point', coordinates: [-100, 50]},
        properties: {
          survivor_id: id, name: id, review_status: verified ? 'reviewed' : 'pending',
          waypoints: [{...waypoint, verified}], bio_excerpt: 'He came to Canada.',
        },
      });
      const cached = {
        metadata: {gazetteer_revision: worker.GAZETTEER_REVISION, content_revision: 'old'},
        features: [feature('pending'), feature('reviewed', true)],
      };
      const media = {images: [], videos: [{
        ...mediaModule.safeVimeoReference('https://player.vimeo.com/video/123'),
        title: 'Source chapter', status: 'captioned',
      }]};
      const seed = {features: cached.features.map((original) => ({
        ...original, geometry: {type: 'Point', coordinates: [-79, 43]},
        properties: {
          ...original.properties, profile_media: media,
          waypoints: [{
            ...original.properties.waypoints[0], role: 'birthplace',
            date: {start: '1948', end: '1948', precision: 'year'},
            lat: 43, lng: -79, source_quote: 'In 1948 he came to Canada and remained there.',
          }],
        },
      }))};
      seed.features.push({
        type: 'Feature', geometry: null,
        properties: {survivor_id: 'unplaced', name: 'Unplaced', review_status: 'pending', waypoints: [], profile_media: media},
      });
      console.log(JSON.stringify({cached, migrated: worker.migrateCachedData(cached, seed)}));
    """)
    cached, migrated = result["cached"]["features"], result["migrated"]["features"]
    for old, new in zip(cached, migrated):
        assert new["geometry"] == old["geometry"]
        original = old["properties"]["waypoints"][0]
        updated = new["properties"]["waypoints"][0]
        assert {key: value for key, value in updated.items() if key != "source_quote"} == {
            key: value for key, value in original.items() if key != "source_quote"
        }
        assert new["properties"]["profile_media"]["videos"][0]["status"] == "captioned"
    assert migrated[0]["properties"]["waypoints"][0]["source_quote"].startswith("In 1948")
    assert migrated[1]["properties"]["waypoints"][0]["source_quote"] == "came to Canada"
    assert migrated[2]["geometry"] is None
    assert result["migrated"]["metadata"]["unplaced"] == 1


def test_live_sync_includes_a_public_unplaced_profile_with_source_media():
    result = _worker("""
      const store = new Map();
      const env = {
        OHP_DATA: {
          get: async (key, format) => {
            const value = store.get(key);
            return format === 'json' && value ? JSON.parse(value) : value || null;
          },
          put: async (key, value) => store.set(key, value),
        },
        ASSETS: {fetch: async () => new Response(JSON.stringify({
          type: 'FeatureCollection', metadata: {
            gazetteer_revision: worker.GAZETTEER_REVISION,
            content_revision: worker.CONTENT_REVISION,
          }, features: [],
        }))},
      };
      globalThis.fetch = async (url) => new Response(url.includes('/ohp-type/')
        ? '<a href="https://ohp.crestwood.on.ca/ohp/unplaced/">Public profile</a>'
        : '<title>Public Profile – CRESTWOOD</title><article><div class="entry-content"><p>This public summary describes teaching and family memories.</p><div id="ohp-video"><a href="https://player.vimeo.com/video/123?h=abcdef1234">Family memories</a></div></div><!-- .entry-content --></article>');
      const status = await worker.syncSurvivors(env);
      console.log(JSON.stringify({status, data: JSON.parse(store.get(worker.DATA_KEY))}));
    """)
    assert result["status"]["added"] == 1
    assert result["status"]["unplaced"] == 1
    feature = result["data"]["features"][0]
    assert feature["geometry"] is None
    assert feature["properties"]["waypoints"] == []
    assert feature["properties"]["review_status"] == "pending"
    assert feature["properties"]["profile_media"]["videos"][0]["title"] == "Family memories"


def test_worker_keeps_media_only_profiles_but_does_not_invent_a_biography():
    result = _worker("""
      const record = worker.parseEntry('media-only', '<article><div class="entry-content"><div id="ohp-video"><a href="https://player.vimeo.com/video/123">Canada memories</a></div></div><!-- .entry-content --></article>', 'Holocaust Survivors');
      const protectedRecord = worker.parseEntry('protected', '<article><div class="entry-content"><form class="post-password-form"><input name="post_password"></form></div></article>', 'Holocaust Survivors');
      console.log(JSON.stringify({
        feature: worker.toFeature(record), protectedFeature: worker.toFeature(protectedRecord),
      }));
    """)
    assert result["feature"]["geometry"] is None
    assert result["feature"]["properties"]["bio_excerpt"] == ""
    assert result["feature"]["properties"]["waypoints"] == []
    assert len(result["feature"]["properties"]["profile_media"]["videos"]) == 1
    assert result["protectedFeature"] is None


def test_geography_sanitization_does_not_reinfer_roles_from_a_wider_quote():
    result = _worker("""
      const waypoint = (place, role, quote) => ({
        as_written: place, canonical: place, role, source_quote: quote, verified: false,
        date: {start: null, end: null, precision: 'unknown'},
      });
      const feature = {
        type: 'Feature', geometry: {type: 'Point', coordinates: [-1, 52]},
        properties: {
          survivor_id: 'example', bio_excerpt: '',
          waypoints: [
            waypoint('England', 'birthplace', 'He grew up in England.'),
            waypoint('Canada', 'resettlement', 'He was born in an unrecorded town and worked with family for many years before moving to Canada.'),
          ],
        },
      };
      console.log(JSON.stringify(worker.sanitizeCachedFeature(feature).properties.waypoints));
    """)
    assert [(waypoint["as_written"], waypoint["role"]) for waypoint in result] == [
        ("England", "birthplace"), ("Canada", "resettlement"),
    ]


def test_worker_url_guards_only_handle_expected_parse_and_encoding_errors():
    result = _worker("""
      const capture = (action) => {
        try { return {value: action()}; }
        catch (error) { return {name: error.name, message: error.message}; }
      };
      const invalid = [
        mediaModule.safeVimeoReference('https://['),
        mediaModule.safeVimeoReference('https://player.vimeo.com/video/123?h=%E0%A4%A'),
      ];
      const html = '<div class="entry-content"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/bad%zz.jpg"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/bad%E0%A4%A.jpg"></div>';
      const gallery = mediaModule.parseProfileMedia(html, 'https://ohp.crestwood.on.ca/ohp/example/');
      const coercion = capture(() => mediaModule.safeVimeoReference({
        toString() { throw new TypeError('unexpected coercion'); },
      }));
      const NativeURL = globalThis.URL;
      globalThis.URL = function () { throw new RangeError('unexpected URL failure'); };
      let urlFailure;
      try { urlFailure = capture(() => mediaModule.safeVimeoReference('https://player.vimeo.com/video/123')); }
      finally { globalThis.URL = NativeURL; }
      const nativeDecode = globalThis.decodeURIComponent;
      globalThis.decodeURIComponent = () => { throw new Error('unexpected decoding failure'); };
      let decodeFailure;
      try { decodeFailure = capture(() => mediaModule.parseProfileMedia('<div class="entry-content"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/photo.jpg"></div>', 'https://ohp.crestwood.on.ca/ohp/example/')); }
      finally { globalThis.decodeURIComponent = nativeDecode; }
      console.log(JSON.stringify({invalid, gallery, coercion, urlFailure, decodeFailure}));
    """)
    assert result["invalid"] == [None, None]
    assert result["gallery"]["images"] == []
    assert result["coercion"] == {"name": "TypeError", "message": "unexpected coercion"}
    assert result["urlFailure"] == {"name": "RangeError", "message": "unexpected URL failure"}
    assert result["decodeFailure"] == {"name": "Error", "message": "unexpected decoding failure"}


def test_worker_full_photo_url_never_extends_permission_to_a_different_picture():
    result = _worker("""
      const primary = {
        url: 'assets/portraits/person.webp', primary: true, caption: 'Cleared picture', credit: 'OHP',
        rights: 'Reuse permission granted.',
        source_url: 'https://ohp.crestwood.on.ca/wp-content/uploads/photo-150x150.jpg',
      };
      const gallery = mediaModule.parseProfileMedia('<div class="entry-content"><a href="https://ohp.crestwood.on.ca/wp-content/uploads/photo.jpg"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/photo-150x150.jpg"></a><a href="https://ohp.crestwood.on.ca/wp-content/uploads/other.jpg"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/other-150x150.jpg"></a></div>', 'https://ohp.crestwood.on.ca/ohp/person/');
      const merged = mediaModule.mergeProfileMedia({images: [primary], videos: []}, gallery);
      const mismatched = mediaModule.mergeProfileMedia({images: [primary], videos: []}, {
        images: [{...gallery.images[0], full_url: gallery.images[1].full_url}], videos: [],
      });
      console.log(JSON.stringify({merged, mismatched}));
    """)
    images = result["merged"]["images"]
    assert images[0]["full_url"].endswith("/photo.jpg")
    assert images[0]["rights"] == "Reuse permission granted."
    assert "full_url" not in images[1]
    assert images[1]["rights"] == "See the OHP source page for photograph credits and reuse rights."
    assert "full_url" not in result["mismatched"]["images"][0]


def test_worker_canonical_alias_migration_keeps_reviewed_geography_and_deduplicates_people():
    result = _worker("""
      const old = {
        type: 'Feature', geometry: {type: 'Point', coordinates: [-100, 50]},
        properties: {
          survivor_id: 'old-id', name: 'Person', review_status: 'reviewed',
          archive_url: 'https://ohp.crestwood.on.ca/ohp/old-id/',
          waypoints: [{
            as_written: 'Canada', canonical: 'Canada', lat: 50, lng: -100,
            role: 'transit', verified: true, date: {start: '1949', end: '1949', precision: 'year'},
          }],
        },
      };
      const duplicate = {
        ...old, geometry: {type: 'Point', coordinates: [-79, 43]},
        properties: {...old.properties, survivor_id: 'new-id', review_status: 'pending'},
      };
      const seeded = {
        ...duplicate,
        properties: {
          ...duplicate.properties, source_aliases: ['old-id'],
          archive_url: 'https://ohp.crestwood.on.ca/ohp/new-id/',
        },
      };
      const next = worker.migrateCachedData({
        metadata: {gazetteer_revision: worker.GAZETTEER_REVISION}, features: [old, duplicate],
      }, {features: [seeded]});
      console.log(JSON.stringify(next));
    """)
    assert len(result["features"]) == 1
    feature = result["features"][0]
    assert feature["geometry"]["coordinates"] == [-100, 50]
    assert feature["properties"]["survivor_id"] == "new-id"
    assert feature["properties"]["source_aliases"] == ["old-id"]
    assert feature["properties"]["review_status"] == "reviewed"
    assert feature["properties"]["waypoints"][0]["date"]["start"] == "1949"


def test_worker_discovery_includes_public_option_entries_and_excludes_protected_entries():
    result = _worker("""
      console.log(JSON.stringify(worker.extractSlugs('<option value="/ohp/first/">First</option><a href="/ohp/second/">Second</a><option value="/ohp/private/">Protected: Private</option><a href="/ohp/private/">Private</a>')));
    """)
    assert result == ["first", "second"]
