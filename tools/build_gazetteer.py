"""Generate data/gazetteer.json + data/geocode_cache.json from one curated table.

Keeping the alias map, the known-site roles, and the coordinates in a single source
of truth means they can never drift apart. Coordinates are hand-set, town/site level,
for the historical Holocaust geography that appears in the Crestwood OHP bios. Run:

    python tools/build_gazetteer.py
"""
import json
import os

# canonical -> dict(lat, lng, role(optional known-site role), aliases[list of exonyms/spellings])
PLACES = {
    # ---- Origin countries / regions (fuzzy birthplaces) --------------------
    "Poland":            {"lat": 52.2370, "lng": 19.0000, "aliases": ["poland", "polish"]},
    "Hungary":           {"lat": 47.1625, "lng": 19.5033, "aliases": ["hungary", "hungarian"]},
    "Romania":           {"lat": 45.9432, "lng": 24.9668, "aliases": ["romania", "romanian", "roumania"]},
    "Germany":           {"lat": 51.1657, "lng": 10.4515, "aliases": ["germany", "german"]},
    "Austria":           {"lat": 47.5162, "lng": 14.5501, "aliases": ["austria", "austrian"]},
    "Czechoslovakia":    {"lat": 49.8175, "lng": 15.4730, "aliases": ["czechoslovakia", "czech", "bohemia", "moravia"]},
    "Netherlands":       {"lat": 52.1326, "lng": 5.2913,  "aliases": ["netherlands", "holland", "dutch"]},
    "France":            {"lat": 46.2276, "lng": 2.2137,  "aliases": ["france", "french"]},
    "Lithuania":         {"lat": 55.1694, "lng": 23.8813, "aliases": ["lithuania", "lithuanian"]},
    "Greece":            {"lat": 39.0742, "lng": 21.8243, "aliases": ["greece", "greek"]},
    "Transnistria":      {"lat": 47.5000, "lng": 29.5000, "role": "ghetto", "aliases": ["transnistria"]},
    "Transylvania, Romania": {"lat": 46.7700, "lng": 23.5900, "aliases": ["transylvania"]},
    "Galicia":           {"lat": 49.5000, "lng": 22.5000, "aliases": ["galicia", "galician"]},

    # ---- Cities / hometowns (with historical exonyms) ----------------------
    "Lodz, Poland":      {"lat": 51.7592, "lng": 19.4560, "aliases": ["lodz", "łódź", "litzmannstadt"]},
    "Warsaw, Poland":    {"lat": 52.2297, "lng": 21.0122, "aliases": ["warsaw", "warszawa", "warschau"]},
    "Krakow, Poland":    {"lat": 50.0647, "lng": 19.9450, "aliases": ["krakow", "kraków", "cracow", "krakau"]},
    "Lviv, Ukraine":     {"lat": 49.8397, "lng": 24.0297, "aliases": ["lviv", "lvov", "lwow", "lwów", "lemberg", "leopolis"]},
    "Wroclaw, Poland":   {"lat": 51.1079, "lng": 17.0385, "aliases": ["wroclaw", "wrocław", "breslau"]},
    "Starachowice, Poland": {"lat": 51.0367, "lng": 21.0714, "aliases": ["starachowice"]},
    "Starachowice Ghetto, Poland": {"lat": 51.0500, "lng": 21.0700, "role": "ghetto", "aliases": ["starachowice ghetto"]},
    "Bedzin, Poland":    {"lat": 50.3266, "lng": 19.1280, "aliases": ["bedzin", "będzin", "bendin"]},
    "Sosnowiec, Poland": {"lat": 50.2863, "lng": 19.1041, "aliases": ["sosnowiec"]},
    "Radom, Poland":     {"lat": 51.4027, "lng": 21.1471, "aliases": ["radom"]},
    "Budapest, Hungary": {"lat": 47.4979, "lng": 19.0402, "aliases": ["budapest"]},
    "Debrecen, Hungary": {"lat": 47.5316, "lng": 21.6273, "aliases": ["debrecen"]},
    "Munkacs, Ukraine":  {"lat": 48.4390, "lng": 22.7178, "aliases": ["munkacs", "mukachevo", "munkács"]},
    "Bratislava, Slovakia": {"lat": 48.1486, "lng": 17.1077, "aliases": ["bratislava", "pressburg", "pozsony"]},
    "Vienna, Austria":   {"lat": 48.2082, "lng": 16.3738, "aliases": ["vienna", "wien"]},
    "Berlin, Germany":   {"lat": 52.5200, "lng": 13.4050, "aliases": ["berlin"]},
    "Frankfurt, Germany":{"lat": 50.1109, "lng": 8.6821,  "aliases": ["frankfurt"]},
    "Prague, Czechia":   {"lat": 50.0755, "lng": 14.4378, "aliases": ["prague", "praha", "prag"]},
    "Amsterdam, Netherlands": {"lat": 52.3676, "lng": 4.9041, "aliases": ["amsterdam"]},
    "Vilnius, Lithuania":{"lat": 54.6872, "lng": 25.2797, "aliases": ["vilnius", "vilna", "vilno", "wilno"]},
    "Kaunas, Lithuania": {"lat": 54.8985, "lng": 23.9036, "aliases": ["kaunas", "kovno", "kowno"]},
    "Thessaloniki, Greece": {"lat": 40.6401, "lng": 22.9444, "aliases": ["thessaloniki", "salonika", "salonica"]},
    "Bucharest, Romania":{"lat": 44.4268, "lng": 26.1025, "aliases": ["bucharest", "bucuresti"]},

    # ---- Ghettos ------------------------------------------------------------
    "Lodz Ghetto, Poland":   {"lat": 51.7769, "lng": 19.4490, "role": "ghetto", "aliases": ["lodz ghetto", "łódź ghetto", "litzmannstadt ghetto"]},
    "Warsaw Ghetto, Poland": {"lat": 52.2450, "lng": 20.9930, "role": "ghetto", "aliases": ["warsaw ghetto"]},
    "Krakow Ghetto, Poland": {"lat": 50.0383, "lng": 19.9560, "role": "ghetto", "aliases": ["krakow ghetto", "cracow ghetto", "podgorze"]},
    "Vilna Ghetto, Lithuania": {"lat": 54.6790, "lng": 25.2790, "role": "ghetto", "aliases": ["vilna ghetto", "vilnius ghetto"]},
    "Budapest Ghetto, Hungary": {"lat": 47.4960, "lng": 19.0570, "role": "ghetto", "aliases": ["budapest ghetto"]},

    # ---- Camps (with German spellings) -------------------------------------
    "Auschwitz (Oswiecim), Poland": {"lat": 50.0270, "lng": 19.2030, "role": "camp", "aliases": ["auschwitz", "auschwitz-birkenau", "birkenau", "oswiecim", "oświęcim", "auschwitz birkenau"]},
    "Treblinka, Poland":     {"lat": 52.6314, "lng": 22.0520, "role": "camp", "aliases": ["treblinka"]},
    "Sobibor, Poland":       {"lat": 51.4470, "lng": 23.5950, "role": "camp", "aliases": ["sobibor", "sobibór"]},
    "Belzec, Poland":        {"lat": 50.3717, "lng": 23.4586, "role": "camp", "aliases": ["belzec", "bełżec"]},
    "Majdanek (Lublin), Poland": {"lat": 51.2200, "lng": 22.6100, "role": "camp", "aliases": ["majdanek", "lublin"]},
    "Plaszow (Krakow), Poland": {"lat": 50.0330, "lng": 19.9610, "role": "camp", "aliases": ["plaszow", "płaszów", "plaszów"]},
    "Janowska (Lviv), Ukraine": {"lat": 49.8500, "lng": 23.9800, "role": "camp", "aliases": ["janowska"]},
    "Stutthof, Poland":      {"lat": 54.3280, "lng": 19.1660, "role": "camp", "aliases": ["stutthof"]},
    "Gross-Rosen, Poland":   {"lat": 50.9990, "lng": 16.2730, "role": "camp", "aliases": ["gross-rosen", "gross rosen", "grossrosen"]},
    "Buchenwald, Germany":   {"lat": 51.0220, "lng": 11.2480, "role": "camp", "aliases": ["buchenwald"]},
    "Dachau, Germany":       {"lat": 48.2690, "lng": 11.4680, "role": "camp", "aliases": ["dachau"]},
    "Bergen-Belsen, Germany":{"lat": 52.7575, "lng": 9.9076,  "role": "camp", "aliases": ["bergen-belsen", "bergen belsen", "belsen"]},
    "Mauthausen, Austria":   {"lat": 48.2558, "lng": 14.5014, "role": "camp", "aliases": ["mauthausen"]},
    "Flossenburg, Germany":  {"lat": 49.7340, "lng": 12.3560, "role": "camp", "aliases": ["flossenburg", "flossenbürg"]},
    "Sachsenhausen, Germany":{"lat": 52.7660, "lng": 13.2630, "role": "camp", "aliases": ["sachsenhausen", "oranienburg"]},
    "Ravensbruck, Germany":  {"lat": 53.1900, "lng": 13.1700, "role": "camp", "aliases": ["ravensbruck", "ravensbrück"]},
    "Dora-Mittelbau, Germany": {"lat": 51.5350, "lng": 10.7430, "role": "camp", "aliases": ["dora-mittelbau", "mittelbau-dora", "nordhausen", "dora"]},
    "Kaufering (Dachau subcamp), Germany": {"lat": 48.0890, "lng": 10.8700, "role": "camp", "aliases": ["kaufering"]},
    "Gunskirchen, Austria": {"lat": 48.2200, "lng": 13.9200, "role": "camp", "aliases": ["gunskirchen"]},
    "Theresienstadt (Terezin), Czechia": {"lat": 50.5108, "lng": 14.1508, "role": "transit", "aliases": ["theresienstadt", "terezin", "terezín"]},
    "Westerbork, Netherlands": {"lat": 52.9180, "lng": 6.6080, "role": "transit", "aliases": ["westerbork"]},

    # ---- Liberation / resettlement destinations ----------------------------
    "Toronto, Canada":   {"lat": 43.6532, "lng": -79.3832, "aliases": ["toronto"]},
    "Canada":            {"lat": 56.1304, "lng": -106.3468, "aliases": ["canada"]},
    "Montreal, Canada":  {"lat": 45.5019, "lng": -73.5674, "aliases": ["montreal", "montréal"]},
    "Israel":            {"lat": 31.0461, "lng": 34.8516, "aliases": ["israel", "palestine"]},
    "Switzerland":       {"lat": 46.8182, "lng": 8.2275,  "aliases": ["switzerland"]},
    "Italy":             {"lat": 41.8719, "lng": 12.5674, "aliases": ["italy"]},
    "New York, USA":     {"lat": 40.7128, "lng": -74.0060, "aliases": ["new york"]},
}

def main():
    aliases = {}
    known_sites = {}
    cache = {"_about": "Build-time geocode cache: canonical place -> coordinates. "
                        "Generated by tools/build_gazetteer.py. Committed for reproducibility."}
    for canonical, info in PLACES.items():
        for a in info["aliases"]:
            aliases[a] = canonical
        if "role" in info:
            known_sites[canonical] = info["role"]
        cache[canonical] = {"lat": info["lat"], "lng": info["lng"],
                             "source": "curated", "precision": "site" if "role" in info else "city"}

    gaz = {
        "_about": "Curated place gazetteer (generated by tools/build_gazetteer.py). "
                  "'aliases' maps a historical/as-written spelling to one canonical modern "
                  "name; 'known_sites' force-matches camp/ghetto/transit roles.",
        "aliases": dict(sorted(aliases.items())),
        "known_sites": dict(sorted(known_sites.items())),
    }

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "data", "gazetteer.json"), "w", encoding="utf-8") as fh:
        json.dump(gaz, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    with open(os.path.join(root, "data", "geocode_cache.json"), "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"Wrote {len(PLACES)} canonical places, {len(aliases)} aliases, "
          f"{len(known_sites)} known sites.")

if __name__ == "__main__":
    main()
