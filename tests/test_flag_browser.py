"""Country flag discovery preserves dates, source roles and independent snapshots."""
from test_collection_tools import _node


def test_flag_history_and_catalogue_keep_dated_designs_and_fresh_results():
    data = _node(r"""
const {flagHistory,flagCatalogue,flagFor}=await import('./js/historical-context.js');
const history=flagHistory('USA');
const catalogue=flagCatalogue(1960);
const country=catalogue.find(entry=>entry.names.includes('USA'));
const ids=history.map(entry=>entry.id);
const original=history[0].label;
history[0].label='changed';
country.names.push('A false alias');
country.history[0].note='changed';
console.log(JSON.stringify({
 ids,selected:country.flag.src,
 fresh:flagHistory('USA')[0].label===original,
 aliasesFresh:!flagCatalogue(1960).some(entry=>entry.names.includes('A false alias')),
 notesFresh:flagHistory('USA')[0].note!=='changed',
 unknown:flagHistory('Unmapped test administration'),
 invalid:flagCatalogue('not a year'),
 neutral:flagFor('Germany',1944).neutralIdentifier,
 occupation:flagFor('Germany',1948),
}));
""")
    assert data["ids"] == ["united-states-48", "united-states-49", "united-states-50"]
    assert data["selected"].endswith("united-states-49-stars.svg")
    assert data["fresh"] and data["aliasesFresh"] and data["notesFresh"]
    assert not data["unknown"] and not data["invalid"]
    assert data["neutral"] and data["occupation"] is None


def test_flag_directory_has_all_entries_year_controls_and_explicit_unknown_dates():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {flagCatalogue}=await import('./js/historical-context.js');
const {esc}=await import('./js/config.js');
const ui=await import('./js/ui.js');
const countries=flagCatalogue(1944);
const shell=ui.flagBrowser(1944,1914,2026);
const directory=ui.flagDirectory(countries,1944,'ready');
console.log(JSON.stringify({
 all:countries.every(entry=>directory.includes('data-flag-name="'+esc(entry.name)+'"')),
 rows:(directory.match(/data-flag-row/g)||[]).length,total:countries.length,
 years:(shell.match(/<option /g)||[]).length,year:shell.includes('value="1944" selected'),
 roles:directory.includes('Neutral historical identifier')&&directory.includes('No dated design for 1944'),
 sources:directory.includes('Source and dates')&&directory.includes('Flag history'),
 keyboard:directory.includes('data-flag-summary')&&directory.includes('tabindex="-1"'),
 policy:shell.includes('not evidence that a country had no flag')&&shell.includes('sovereignty'),
}));
""")
    assert data["all"] and data["rows"] == data["total"]
    assert data["years"] == 114 and data["year"]
    assert data["roles"] and data["sources"] and data["keyboard"] and data["policy"]


def test_current_reference_does_not_become_a_historical_flag_and_text_is_escaped():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const ui=await import('./js/ui.js');
const reference={src:'assets/flags/france-tricolour.svg',label:'Reference <script>text</script>',
 sourceUrl:'https://example.org/source',credit:'An author',license:'Public domain',
 note:'A current reference with no use dates established.'};
const html=ui.flagDirectory([{
 name:'Test <img src=x>',names:['Test <img src=x>'],flag:null,history:[],currentReference:reference,
}],1914,'error');
console.log(JSON.stringify({
 escaped:html.includes('Test &lt;img src=x&gt;')&&html.includes('&lt;script&gt;text&lt;/script&gt;'),
 injected:html.includes('<script>')||html.includes('<img src=x>'),
 dated:html.includes('data-flag-available="true"'),
 current:html.includes('Current reference image')&&html.includes('not assigned to historical dates'),
 unavailable:html.includes('No dated design for 1914')&&html.includes('Retry country outlines'),
 noOutline:!html.includes('data-flag-controller'),
}));
""")
    assert data["escaped"] and not data["injected"] and not data["dated"]
    assert data["current"] and data["unavailable"] and data["noOutline"]


def test_month_precision_withholds_only_the_uncertain_month():
    data = _node(r"""
const {flagInterval}=await import('./js/historical-context.js');
const month=flagInterval({start:'1960-07',end:'1961-06'});
const year=flagInterval({start:'1960',end:null});
const exact=flagInterval({start:'1960-01-01',end:null});
console.log(JSON.stringify({
 monthStart:new Date(month.start).toISOString(),monthEnd:new Date(month.end).toISOString(),
 yearStart:new Date(year.start).toISOString(),exactStart:new Date(exact.start).toISOString(),
 invalid:['1960-13','1960-00','1960-02-30','1961-02-29'].every(start=>Number.isNaN(flagInterval({start,end:null}).start)),
}));
""")
    assert data["monthStart"].startswith("1960-08-01")
    assert data["monthEnd"].startswith("1961-06-01")
    assert data["yearStart"].startswith("1961-01-01")
    assert data["exactStart"].startswith("1960-01-01")
    assert data["invalid"]


def test_sharing_a_flag_image_does_not_merge_administration_identity():
    data = _node(r"""
const {flagFor}=await import('./js/historical-context.js');
const france=flagFor('France',1944),vichy=flagFor('Vichy France',1944);
console.log(JSON.stringify({
 sharedImage:france.src===vichy.src,
 distinctIdentity:france.countryName!==vichy.countryName,
 france:france.countryName,vichy:vichy.countryName,
}));
""")
    assert data["sharedImage"] and data["distinctIdentity"]
    assert data["france"] == "France" and data["vichy"] == "Vichy France"


def test_every_current_map_country_has_a_flag_or_explicit_no_national_flag_status():
    data = _node(r"""
import fs from 'node:fs';
import path from 'node:path';
const {flagCatalogue}=await import('./js/historical-context.js');
const world=JSON.parse(fs.readFileSync(path.join('vendor','atlas','countries-110m.json'),'utf8'));
const history=JSON.parse(fs.readFileSync(path.join('data','historical_boundaries.json'),'utf8'));
const modern=world.objects.countries.geometries.map(feature=>feature.properties.name);
const active=history.objects.territories.geometries
 .filter(feature=>feature.properties.start<=2026.5&&(feature.properties.end===null||feature.properties.end>2026.5))
 .map(feature=>feature.properties.controller||feature.properties.name);
const wanted=[...new Set([...modern,...active])];
const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g,' ').trim();
const entries=flagCatalogue(2026);
const lookup=name=>entries.find(entry=>entry.names.some(alias=>normalize(alias)===normalize(name)));
const missing=wanted.filter(name=>!lookup(name));
const noImage=wanted.filter(name=>name!=='Antarctica'&&!lookup(name)?.flag&&!lookup(name)?.currentReference);
const antarctica=lookup('Antarctica');
console.log(JSON.stringify({
 modern:modern.length,active:new Set(active).size,missing,noImage,
 antarctica:!!antarctica&&!antarctica.flag&&!antarctica.currentReference&&/no.*(national|official).*flag/i.test(antarctica.note||''),
}));
""")
    assert data["modern"] == 177 and data["active"] == 199
    assert not data["missing"], data["missing"]
    assert not data["noImage"], data["noImage"]
    assert data["antarctica"]


def test_current_reference_view_includes_every_country_without_claiming_historical_dates():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {flagCatalogue}=await import('./js/historical-context.js');
const {flagDirectory}=await import('./js/ui.js');
const catalogue=flagCatalogue(2026);
const html=flagDirectory(catalogue,2026,'ready',true);
console.log(JSON.stringify({
 countries:(html.match(/data-flag-row/g)||[]).length,
 current:(html.match(/Current reference image<\/small>/g)||[]).length,
 historical:html.includes('data-flag-name="Aden Colony"'),
 disclaimer:html.includes('Current reference images are not assigned to earlier dates'),
 antarctica:html.includes('No national flag'),
 datedHeader:html.includes('Dated design for 2026'),
}));
""")
    assert data["countries"] == 252 and data["current"] == 251
    assert not data["historical"] and not data["datedHeader"]
    assert data["disclaimer"] and data["antarctica"]


def test_shared_historical_alias_uses_the_year_valid_administration():
    data = _node(r"""
const {flagCatalogue,flagCatalogueMatch}=await import('./js/historical-context.js');
const selected=flagCatalogueMatch(flagCatalogue(1993),'Yugoslavia',1993);
const ambiguous=[
 {name:'First',names:['Shared'],flag:{countryName:'First'}},
 {name:'Second',names:['Shared'],flag:{countryName:'Second'}},
];
console.log(JSON.stringify({
 selected:selected?.name,
 ambiguous:flagCatalogueMatch(ambiguous,'Shared',1993),
 singleDated:flagCatalogueMatch([{...ambiguous[0],flag:null},ambiguous[1]],'Shared',1993)?.name,
}));
""")
    assert data["selected"] == "Federal Republic of Yugoslavia"
    assert data["ambiguous"] is None
    assert data["singleDated"] == "Second"
