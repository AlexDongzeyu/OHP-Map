"""Focused map-engine browser checks; use an existing local site and Playwright."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


HARNESS = """<!doctype html><meta charset="utf-8">
<style>
:root { --header-height:72px; }
body { margin:0; }
#stage { position:relative; width:100vw; height:100vh; }
#map { position:absolute; inset:0; }
#tip { position:absolute; pointer-events:none; }
.rail,.panel-host { position:absolute; }
</style>
<div id="stage"><div id="map"></div><div id="tip"></div>
<div class="ov-explore" data-presentation="map"></div></div>
<svg id="mini" viewBox="0 0 340 190" style="position:fixed;top:0;left:0;width:340px;height:190px;opacity:0;pointer-events:none"></svg>"""

SETUP = """async () => {
  const {loadData, journeyFilter} = await import('/js/data.js');
  const {createAtlas} = await import('/js/atlas.js');
  window.store = await loadData();
  window.journeyFilter = journeyFilter;
  for (const journey of store.journeys) {
    delete journey.bio;
    delete journey.media;
    delete journey.sourceProperties;
    journey.detailState = 'unloaded';
  }
  window.atlas = createAtlas(document.querySelector('#map'));
  atlas.setStore(store);
  atlas.setTooltipEl(document.querySelector('#tip'));
  await atlas.ready;
  window.assert = (condition, message) => { if (!condition) throw new Error(message); };
  window.context = (extra = {}) => ({
    selectedId:null, activePlaceIndex:null, matches:() => true,
    onPlace:index => { window.activatedPlace = index; },
    onPlaceCluster:canonical => { window.activatedCluster = canonical; },
    onMapFocus:text => { window.announcement = text; },
    ...extra,
  });
  window.zoomState = () => d3.zoomTransform(document.querySelector('#map > svg'));
  window.fixture = (selected) => {
    const mobile = innerWidth <= 820, overlay = document.querySelector('.ov-explore');
    overlay.classList.toggle('has-sel', selected);
    overlay.innerHTML = '<aside class="rail"></aside>' + (selected ? '<div class="panel-host"><section class="panel"></section></div>' : '');
    const rail = overlay.querySelector('.rail'), panel = overlay.querySelector('.panel-host');
    if (mobile) {
      rail.style.cssText = 'left:0;top:520px;width:100%;height:300px';
      if (panel) panel.style.cssText = 'left:0;top:470px;width:100%;height:340px';
    } else {
      rail.style.cssText = 'left:16px;top:96px;width:264px;height:680px';
      if (panel) panel.style.cssText = `left:${innerWidth - 336}px;top:96px;width:320px;height:680px`;
    }
    return mobile ? [20, selected ? 140 : 156, innerWidth - 20, selected ? 454 : 504] :
      [304, 92, selected ? innerWidth - 360 : innerWidth - 20, innerHeight - 24];
  };
  return store.journeys.length;
}"""

FRAMES = """() => {
  const frame = fixture(true), failures = [], samples = [];
  let mapped = 0, narrow = 0;
  for (const journey of store.journeys) {
    atlas.render('explore', context({selectedId:journey.id}), true);
    const points = journey.waypoints.filter(point => Number.isFinite(point.lng) && Number.isFinite(point.lat));
    if (!points.length) continue;
    mapped++;
    const zoom = zoomState(), drawn = document.querySelectorAll('.account-place-marker');
    const screen = points.map(point => zoom.apply([point.px, point.py]));
    const span = [d3.max(screen, point => point[0]) - d3.min(screen, point => point[0]),
      d3.max(screen, point => point[1]) - d3.min(screen, point => point[1])];
    if (drawn.length !== points.length || screen.some(point => !point.every(Number.isFinite) ||
      point[0] < frame[0] - .01 || point[0] > frame[2] + .01 || point[1] < frame[1] - .01 || point[1] > frame[3] + .01)) {
      failures.push(journey.id);
    }
    const single = span.every(value => value < .001);
    const precise = points.every(point => ['city','site'].includes(point.locationPrecision));
    const cap = single ? 6 : precise ? 14 : 8;
    assert(zoom.k <= cap + .001, `${journey.id}: excessive zoom`);
    if (single) assert(Math.abs(zoom.k - 6) < .001, `${journey.id}: unreadable single reference`);
    const coverage = Math.max(span[0] / (frame[2] - frame[0]), span[1] / (frame[3] - frame[1]));
    if (!single && coverage < .6 && zoom.k < cap - .001) narrow++;
    assert([...drawn].every(marker => {
      const point = marker.__data__, symbol = marker.querySelector('.map-reference-symbol');
      const solid = (point.verified || point.evidenceScope === 'personal') && ['city','site'].includes(point.locationPrecision);
      return solid ? symbol.getAttribute('fill') !== 'none' :
        symbol.getAttribute('fill') === 'none' && (point.verified || point.evidenceScope === 'personal' || symbol.hasAttribute('stroke-dasharray'));
    }), `${journey.id}: misleading reference symbol`);
    if (['baranek-martin','adler-amek'].includes(journey.id)) samples.push({
      id:journey.id, mapped:points.length, zoom:zoom.k, span, frame,
      routeDrawn:Boolean(document.querySelector('.explore-route')),
    });
  }
  assert(!failures.length, `Unframed accounts: ${failures.join(', ')}`);
  assert(!narrow, `${narrow} accounts have unnecessarily tiny reference extents`);
  return {mapped, failures, narrow, samples};
}"""

COLLECTION = """() => {
  fixture(false);
  const check = matches => {
    atlas.render('explore', context({matches}), true);
    const expected = new Map();
    for (const journey of store.journeys.filter(matches)) for (const point of journey.waypoints) {
      if (!Number.isFinite(point.lng) || !Number.isFinite(point.lat)) continue;
      const key = JSON.stringify([point.canonical,point.lng,point.lat]);
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key).add(journey.id);
    }
    const clusters = [...document.querySelectorAll('.place-cluster')];
    assert(clusters.length === expected.size, 'Collection excludes mapped source mentions');
    assert(clusters.every(marker => marker.__data__.count === expected.get(marker.__data__.key)?.size &&
      marker.dataset.accountIds === JSON.stringify([...expected.get(marker.__data__.key)].sort()) &&
      marker.getAttribute('role') === 'button' &&
      marker.getAttribute('aria-label').includes(marker.dataset.placeCanonical) &&
      marker.getAttribute('aria-label').includes(marker.dataset.precision) &&
      marker.getAttribute('aria-label').includes(marker.dataset.accountCount)), 'Wrong account count or accessible cluster label');
    assert(document.querySelectorAll('.place-cluster[tabindex="0"]').length === Math.min(1, clusters.length), 'Collection has more than one tab stop');
    assert(clusters.every(marker => !marker.__on), 'Collection installs per-marker listeners');
    return clusters.length;
  };
  const all = check(() => true);
  const groups = new Set(store.groups.map(group => group.name));
  const filtered = check(journeyFilter({query:'Canada',groupFilter:groups,savedOnly:true,savedIds:new Set(['baranek-martin','adler-amek'])}));
  assert(filtered > 0 && filtered < all, 'Search/saved filters do not reach the map');
  const empty = check(() => false);
  assert(atlas.focusMap() && document.activeElement === document.querySelector('#map > svg'), 'An empty map has no focus fallback');
  check(() => true);
  assert(atlas.focusMap(), 'Skip to map has no target');
  const clusters = [...document.querySelectorAll('.place-cluster')];
  const key = value => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:value,bubbles:true}));
  assert(document.activeElement === clusters[0], 'First cluster is not focused');
  key('ArrowRight');
  assert(document.activeElement === clusters[1], 'Arrow navigation failed');
  assert(window.announcement === clusters[1].getAttribute('aria-label') && document.querySelector('#tip').style.opacity === '1', 'Cluster focus has no tooltip/live feedback');
  key('End'); assert(document.activeElement === clusters.at(-1), 'End navigation failed');
  key('Home'); assert(document.activeElement === clusters[0], 'Home navigation failed');
  key('ArrowLeft'); assert(document.activeElement === clusters.at(-1), 'Arrow navigation does not wrap');
  key('Enter');
  assert(window.activatedCluster === clusters.at(-1).__data__.canonical, 'Activation does not return the exact canonical');
  atlas.render('explore', context());
  assert(document.activeElement.dataset.mapFocus === clusters.at(-1).dataset.mapFocus, 'Rerender lost cluster focus');
  assert(document.querySelectorAll('.place-cluster[tabindex="0"]').length === 1, 'Roving focus lost its single tab stop');
  return {all, filtered, empty, zoom:zoomState().k};
}"""

MINI_MAPS = """async () => {
  const {accountMapOverview} = await import('/js/ui.js');
  const element = document.querySelector('#mini'), failures = [], samples = [];
  const camera = zoomState().toString();
  let mapped = 0, unlocated = 0, noRoute = 0;
  for (const journey of store.journeys) {
    const coordinates = journey.waypoints.filter(point => Number.isFinite(point.lng) && Number.isFinite(point.lat));
    const markup = accountMapOverview(journey);
    if (!coordinates.length) {
      unlocated++;
      assert(!markup.includes('data-mini') && markup.includes('account-map-unavailable') && markup.includes(journey.archiveUrl),
        journey.id + ': a source without coordinates displays a blank map or lacks recovery');
      continue;
    }
    mapped++;
    const before = journey.waypoints.map(point => [point.px, point.py]);
    assert(markup.includes('data-mini') && markup.includes('Open larger map'), journey.id + ': mapped source has no account map');
    atlas.drawMini(element, journey);
    const markers = [...element.querySelectorAll('.mini-map-reference')];
    const land = [...element.querySelectorAll('.mini-country')].filter(country => {
      const box = country.getBBox();
      return box.width > 1 && box.height > 1;
    });
    const labels = [...element.querySelectorAll('.mini-place-label')];
    const expectedRoute = new Set(journey.routeWaypoints
      .filter(point => Number.isFinite(point.lng) && Number.isFinite(point.lat) &&
        (point.evidenceScope === 'personal' || point.verified) && ['city','site'].includes(point.locationPrecision))
      .map(point => `${point.lng},${point.lat}`)).size > 1;
    const route = element.querySelector('.mini-route');
    if (!expectedRoute) noRoute++;
    const visible = markers.every(marker => {
      const x = Number(marker.getAttribute('cx')), y = Number(marker.getAttribute('cy'));
      return Number.isFinite(x) && Number.isFinite(y) && x >= 23.99 && x <= 316.01 && y >= 23.99 && y <= 166.01;
    });
    if (markers.length !== coordinates.length || !land.length || !labels.length || !visible || Boolean(route) !== expectedRoute ||
        (route && (!route.getAttribute('d') || /NaN|Infinity/.test(route.getAttribute('d'))))) {
      failures.push({id:journey.id,markers:markers.length,expected:coordinates.length,land:land.length,labels:labels.length,visible,route:Boolean(route),expectedRoute});
    }
    assert(element.getAttribute('role') === 'img' && element.getAttribute('aria-label').includes(journey.name) &&
      element.querySelector('desc').textContent.includes('Current borders'), journey.id + ': overview has no geographic description');
    assert(JSON.stringify(before) === JSON.stringify(journey.waypoints.map(point => [point.px,point.py])),
      journey.id + ': the overview mutated the main map points');
    if (['adam-wally','adler-amek','ferguson-george'].includes(journey.id)) samples.push({id:journey.id,land:land.length,markers:markers.length,labels:labels.length});
  }
  assert(!failures.length, 'Unusable account maps: ' + JSON.stringify(failures));
  assert(camera === zoomState().toString(), 'Drawing account overviews moved the main map');

  const base = store.journeys[0];
  const point = (canonical,lng,lat) => ({canonical,lng,lat,evidenceScope:'personal',locationPrecision:'city',verified:false});
  const repeated = point('Toronto, Canada',-79.3832,43.6532);
  const pacific = [point('Suva, Fiji',178.45,-18.14),point('Apia, Samoa',-171.75,-13.83)];
  for (const [id,points] of [['single',[repeated]],['same-location',[repeated,{...repeated}]],['date-line',pacific]]) {
    const journey = {...base,id,name:id,waypoints:points,routeWaypoints:points};
    atlas.drawMini(element,journey);
    assert(element.querySelector('.mini-country') && element.querySelector('.mini-place-label'), id + ': missing geography or labels');
    if (id !== 'date-line') assert(!element.querySelector('.mini-route'), id + ': a repeated location became a route');
    else {
      const xs = [...element.querySelectorAll('.mini-map-reference')].map(marker => Number(marker.getAttribute('cx')));
      assert(Math.abs(xs[0]-xs[1]) > 60 && Math.abs(xs[0]-xs[1]) < 293, 'Date-line neighbours were stretched across a world map');
    }
  }
  return {mapped,unlocated,noRoute,failures,samples};
}"""

SELECTION = """() => {
  fixture(true);
  document.activeElement.blur();
  const journey = store.journeys.find(account => account.waypoints.length >= 3 &&
    account.waypoints.every(point => !point.verified && point.evidenceScope !== 'personal' &&
      Number.isFinite(point.lng) && Number.isFinite(point.lat)));
  assert(journey, 'No entirely unreviewed account is available for the negative route check');
  atlas.render('explore', context({selectedId:journey.id}));
  assert(!document.querySelector('.explore-route'), 'Unreviewed mentions became a route');
  const markers = [...document.querySelectorAll('.account-place-marker')];
  for (const marker of markers) {
    marker.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    assert(window.activatedPlace === Number(marker.dataset.placeIndex), 'Reference cannot activate its source entry');
  }
  const selected = Number(markers[2].dataset.placeIndex);
  atlas.render('explore', context({selectedId:journey.id,activePlaceIndex:selected}));
  assert(document.querySelector('.selected-place-label').textContent === journey.waypoints[selected].canonical, 'Selected reference has no visible label');
  assert(atlas.focusMap() && document.activeElement.dataset.placeIndex === String(selected), 'Map focus did not select the active reference');
  const focusKey = document.activeElement.dataset.mapFocus;
  atlas.render('explore', context({selectedId:journey.id,activePlaceIndex:selected}));
  assert(document.activeElement.dataset.mapFocus === focusKey, 'Source selection lost map focus');
  document.activeElement.blur();
  atlas.focusCoordinates(10, 40, 3, false);
  const before = zoomState().toString();
  const hydrated = {
    ...journey,
    waypoints:journey.waypoints.map(point => ({...point,px:undefined,py:undefined})),
    contextualPlaces:[{canonical:'Context',lng:28,lat:-30}],
  };
  hydrated.routeWaypoints = [];
  assert(atlas.refreshJourney(hydrated, {miniEl:document.querySelector('#mini')}), 'Hydration projection failed');
  assert(hydrated.waypoints.every(point => Number.isFinite(point.px) && Number.isFinite(point.py)) &&
    Number.isFinite(hydrated.contextualPlaces[0].px), 'Replacement places/context are not projected');
  assert(zoomState().toString() === before, 'Hydration moved the camera');
  assert(document.querySelectorAll('#mini .mini-map-reference').length === hydrated.waypoints.length && !document.querySelector('#mini .mini-route'), 'Mini map hides references or invents a route');
  atlas.render('explore', context({selectedId:journey.id,activePlaceIndex:selected}));
  assert(zoomState().toString() === before, 'Unchanged source selection reset a manual camera');
  const invalid = {...hydrated,waypoints:[{canonical:'Missing',lng:null,lat:null},{canonical:'Invalid',lng:NaN,lat:Infinity}]};
  atlas.refreshJourney(invalid);
  assert(invalid.waypoints.every(point => point.px === null && point.py === null), 'Missing coordinates were projected as zero');
  assert(document.querySelector('#map > svg').getAttribute('role') === 'group' && document.querySelector('#map').getAttribute('role') === 'region', 'Map semantics hide its child buttons');
  assert(document.querySelector('[data-country="Antarctica"]')?.getAttribute('d') === null, 'Antarctica is displayed or its source feature was removed');
  return {references:markers.length, selected:journey.waypoints[selected].canonical};
}"""

HISTORY = """() => {
  document.activeElement.blur();
  window.historyContext = context({
    scrubYear:1942,boundaryYear:1942,patternsLayer:'journeys',warPeriod:store.warAt(1942),
    historyCompare:false,historySplit:50,historyOpacity:1,
    onController:name => { window.activatedController = name; },
    onEvent:key => { window.activatedEvent = key; },
    patternEvents:[{key:'test-event',year:1942,place:'Warsaw, Poland',lng:21.0118,lat:52.2298,count:2,people:[]}],
  });
  atlas.render('patterns', historyContext);
}"""

HISTORY_CHECK = """() => {
  const checkLabels = () => {
    const nodes = [...document.querySelectorAll('.historical-flag, .historical-labels text')];
    const boxes = nodes.map(node => node.getBoundingClientRect());
    assert(boxes.every((box, i) => boxes.slice(i + 1).every(other =>
      box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom)), 'Historical flag/label collision');
    return nodes.length;
  };
  assert(document.querySelectorAll('.historical-territory').length > 100, 'Historical source geometries were discarded');
  const labels = checkLabels(), flag = document.querySelector('.historical-flag');
  assert(flag && flag.getAttribute('tabindex') === '0', 'Dated flags lost keyboard support');
  flag.focus();
  flag.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
  assert(window.activatedController === flag.__data__.controller && window.announcement.includes(flag.__data__.name), 'Flag activation/focus feedback failed');
  const marker = document.querySelector('.pattern-event-marker');
  marker.focus();
  marker.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
  assert(window.activatedEvent === 'test-event', 'Historical event keyboard activation failed');
  document.activeElement.blur();
  atlas.render('patterns', {...historyContext,historyCountry:'Germany'});
  const neutral = document.querySelector('.historical-identifier[data-neutral-identifier="true"]');
  assert(neutral && neutral.querySelector('text').textContent === 'Germany' &&
    !neutral.querySelector('image, .historical-flag-frame'), 'Neutral identifier became a flag ornament or obscured its country name');
  assert(neutral.getAttribute('aria-label').includes('not a historical flag') &&
    neutral.querySelector('title').textContent.includes('Source note:'), 'Neutral identifier lacks factual context');
  checkLabels();
  neutral.focus();
  neutral.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
  assert(window.activatedController === 'Germany', 'Text-only territorial identifier lost keyboard activation');
  atlas.render('patterns', {...historyContext,historyCountry:'Germany',historyLabels:false});
  assert(document.querySelector('.historical-identifier text')?.textContent === 'Germany',
    'Hiding optional labels turned the neutral identifier into an unnamed control');
  assert(document.querySelector('.historical-flag:not(.historical-identifier) image'), 'Other dated flags were replaced');
  atlas.render('patterns', {...historyContext,historyCountry:'Germany',boundaryYear:1930,scrubYear:1930,
    warPeriod:store.warAt(1930),patternEvents:[]});
  const earlier = document.querySelector('[data-map-focus="country:Germany"]');
  assert(earlier && !earlier.hasAttribute('data-neutral-identifier') && earlier.querySelector('image'),
    'Changing years did not restore the appropriate earlier flag');
  atlas.render('patterns', historyContext);
  document.activeElement.blur();
  atlas.focusCoordinates(18, 48, 4, false);
  const position = atlas.cameraPosition();
  atlas.focusCoordinates(position.lng, position.lat, position.zoom, false);
  const restored = atlas.cameraPosition();
  assert(Math.abs(restored.lng - position.lng) < 1e-8 && Math.abs(restored.lat - position.lat) < 1e-8 && restored.zoom === position.zoom, 'History camera restoration changed coordinates');
  atlas.setHistoryDisplay({compare:true,split:42,opacity:.65});
  checkLabels();
  const clip = document.querySelector('#history-comparison-clip rect'), zoom = zoomState();
  const divider = Number.parseFloat(document.querySelector('#map').style.getPropertyValue('--comparison-x'));
  assert(Math.abs(zoom.applyX(Number(clip.getAttribute('x')) + Number(clip.getAttribute('width'))) - divider) < .001 &&
    document.querySelector('.historical-flags').getAttribute('clip-path') === 'url(#history-comparison-clip)', 'Comparison clipping is not camera-aware');
  atlas.render('patterns', context({patternsLayer:'origins'}));
  const painted = [...document.querySelectorAll('[data-origin-count]')].filter(node => Number(node.dataset.originCount));
  const shade = node => { const color=d3.color(node.getAttribute('fill')); return color.r+color.g+color.b; };
  painted.sort((a,b) => Number(a.dataset.originCount)-Number(b.dataset.originCount));
  assert(painted.every((node,i) => !i || shade(node) <= shade(painted[i-1])), 'Origins ramp is not quantitatively monotonic');
  const empty = document.querySelector('[data-origin-count="0"]');
  assert(painted.length && empty && Math.abs(shade(painted[0])-shade(empty)) > 60, 'Low-count origins remain indistinguishable');
  return {labels, territories:document.querySelectorAll('.historical-territory').length, originCountries:painted.length};
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8124")
    parser.add_argument("--browser", default="")
    args = parser.parse_args()
    edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    executable = args.browser or (str(edge) if edge.exists() else None)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        try:
            page = browser.new_page(viewport={"width": 1366, "height": 850}, reduced_motion="reduce")
            errors, requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.on("response", lambda response: errors.append(f"HTTP {response.status}: {response.url}") if response.status >= 400 else None)
            page.on("request", lambda request: requests.append(request.url))
            page.route("**/survivor/map-engine-check", lambda route: route.fulfill(content_type="text/html", body=HARNESS))
            page.goto(f"{args.base.rstrip('/')}/survivor/map-engine-check", wait_until="networkidle")
            page.add_script_tag(url=f"{args.base.rstrip('/')}/vendor/d3/d3.min.js")
            page.add_script_tag(url=f"{args.base.rstrip('/')}/vendor/topojson/topojson-client.min.js")
            results = {"accounts": page.evaluate(SETUP)}
            results["desktop"] = page.evaluate(FRAMES)
            results["miniMaps"] = page.evaluate(MINI_MAPS)
            results["collection"] = page.evaluate(COLLECTION)
            results["selection"] = page.evaluate(SELECTION)
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate("() => { document.activeElement.blur(); atlas.resize(); }")
            results["mobile"] = page.evaluate(FRAMES)
            results["mobileCollection"] = page.evaluate(COLLECTION)
            page.set_viewport_size({"width": 1366, "height": 850})
            page.evaluate("() => atlas.resize()")
            page.evaluate(HISTORY)
            page.wait_for_function("() => atlas.historyLoaded()", timeout=60000)
            page.wait_for_load_state("networkidle")
            results["history"] = page.evaluate(HISTORY_CHECK)
            assert not any("/survivor/data/" in url or "/survivor/assets/" in url for url in requests), "Nested profile paths broke map resources"
            assert any("/data/atlas-world.json" in url for url in requests)
            assert any("/data/historical_boundaries.json" in url for url in requests)
            assert any("/assets/flags/" in url for url in requests)
            page.emulate_media(reduced_motion="no-preference")
            page.evaluate("""() => {
              fixture(true);
              atlas.render('explore', context({selectedId:'adler-amek'}));
              document.querySelector('.account-place-marker').focus();
              atlas.render('explore', context({selectedId:'adler-amek',activePlaceIndex:0}));
            }""")
            page.wait_for_function("() => Math.abs(zoomState().k - 6) < .001")
            results["animatedFocus"] = page.evaluate("""() => {
              assert(document.activeElement.dataset.mapFocus === 'place:adler-amek:0' &&
                document.querySelector('#tip').style.opacity === '1', 'Animated source focus or tooltip was lost');
              return {zoom:zoomState().k, focused:document.activeElement.dataset.mapFocus};
            }""")
            page.evaluate("() => atlas.render('landing', context())")
            before = page.locator(".globe-graticule").get_attribute("d")
            page.wait_for_timeout(180)
            assert before != page.locator(".globe-graticule").get_attribute("d"), "Landing animation no longer starts automatically"
            assert not errors, errors
            print(json.dumps(results, indent=2))
            print("PASS map framing, source safeguards, clustering, keyboard focus, hydration, history, resources, and automatic globe")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
