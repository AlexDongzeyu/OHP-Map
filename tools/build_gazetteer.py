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

    # ---- Canada: hometowns + where veterans grew up / returned -------------
    "Ottawa, Canada":    {"lat": 45.4215, "lng": -75.6972, "aliases": ["ottawa"]},
    "Hamilton, Canada":  {"lat": 43.2557, "lng": -79.8711, "aliases": ["hamilton"]},
    "London, Ontario":   {"lat": 42.9849, "lng": -81.2453, "aliases": ["london, ontario", "london on"]},
    "Kitchener, Canada": {"lat": 43.4516, "lng": -80.4925, "aliases": ["kitchener", "berlin, ontario", "waterloo"]},
    "Kingston, Canada":  {"lat": 44.2312, "lng": -76.4860, "aliases": ["kingston"]},
    "Windsor, Canada":   {"lat": 42.3149, "lng": -83.0364, "aliases": ["windsor"]},
    "Winnipeg, Canada":  {"lat": 49.8951, "lng": -97.1384, "aliases": ["winnipeg"]},
    "Vancouver, Canada": {"lat": 49.2827, "lng": -123.1207, "aliases": ["vancouver"]},
    "Halifax, Canada":   {"lat": 44.6488, "lng": -63.5752, "aliases": ["halifax"]},
    "Calgary, Canada":   {"lat": 51.0447, "lng": -114.0719, "aliases": ["calgary"]},
    "Edmonton, Canada":  {"lat": 53.5461, "lng": -113.4938, "aliases": ["edmonton"]},
    "Quebec City, Canada": {"lat": 46.8139, "lng": -71.2080, "aliases": ["quebec city", "québec city"]},
    "Victoria, Canada":  {"lat": 48.4284, "lng": -123.3656, "aliases": ["victoria, bc", "victoria, british columbia"]},
    "Brantford, Canada": {"lat": 43.1394, "lng": -80.2644, "aliases": ["brantford"]},
    "Sudbury, Canada":   {"lat": 46.4917, "lng": -80.9930, "aliases": ["sudbury"]},
    "Oshawa, Canada":    {"lat": 43.8971, "lng": -78.8658, "aliases": ["oshawa"]},
    "Regina, Canada":    {"lat": 50.4452, "lng": -104.6189, "aliases": ["regina"]},
    "Saskatoon, Canada": {"lat": 52.1332, "lng": -106.6700, "aliases": ["saskatoon"]},
    "St. Catharines, Canada": {"lat": 43.1594, "lng": -79.2469, "aliases": ["st. catharines", "st catharines"]},
    "Newfoundland, Canada": {"lat": 48.9500, "lng": -55.6500, "aliases": ["newfoundland"]},

    # ---- Military training camps (Canada) ---------------------------------
    "Camp Borden, Canada": {"lat": 44.2700, "lng": -79.9100, "role": "camp", "aliases": ["camp borden", "borden"]},
    "Petawawa, Canada":  {"lat": 45.8970, "lng": -77.2830, "role": "camp", "aliases": ["petawawa"]},
    "Valcartier, Canada": {"lat": 46.9000, "lng": -71.4900, "role": "camp", "aliases": ["valcartier"]},

    # ---- Britain: staging / training before the front ----------------------
    "London, England":   {"lat": 51.5074, "lng": -0.1278, "aliases": ["london, england", "london, uk"]},
    "Aldershot, England": {"lat": 51.2480, "lng": -0.7600, "role": "transit", "aliases": ["aldershot"]},
    "England":           {"lat": 52.3555, "lng": -1.1743, "aliases": ["england", "britain", "united kingdom"]},
    "Liverpool, England": {"lat": 53.4084, "lng": -2.9916, "aliases": ["liverpool"]},

    # ---- Second World War theatres (where veterans served) -----------------
    "Normandy, France":  {"lat": 49.2000, "lng": -0.3700, "role": "liberation", "aliases": ["normandy", "juno beach", "d-day", "d day"]},
    "Dieppe, France":    {"lat": 49.9220, "lng": 1.0780, "role": "camp", "aliases": ["dieppe"]},
    "Caen, France":      {"lat": 49.1829, "lng": -0.3707, "aliases": ["caen", "falaise"]},
    "Antwerp, Belgium":  {"lat": 51.2194, "lng": 4.4025, "aliases": ["antwerp", "scheldt"]},
    "Arnhem, Netherlands": {"lat": 51.9851, "lng": 5.8987, "aliases": ["arnhem"]},
    "Ortona, Italy":     {"lat": 42.3550, "lng": 14.4030, "role": "camp", "aliases": ["ortona"]},
    "Monte Cassino, Italy": {"lat": 41.4870, "lng": 13.8140, "role": "camp", "aliases": ["monte cassino", "cassino"]},
    "Sicily, Italy":     {"lat": 37.6000, "lng": 14.0150, "aliases": ["sicily"]},
    "Rome, Italy":       {"lat": 41.9028, "lng": 12.4964, "aliases": ["rome"]},
    "Hong Kong":         {"lat": 22.3193, "lng": 114.1694, "role": "camp", "aliases": ["hong kong"]},

    # ---- Korean War --------------------------------------------------------
    "Korea":             {"lat": 37.5000, "lng": 127.5000, "aliases": ["korea", "korean peninsula"]},
    "Kapyong, Korea":    {"lat": 37.8870, "lng": 127.4890, "role": "camp", "aliases": ["kapyong", "kap'yong"]},
    "Seoul, Korea":      {"lat": 37.5665, "lng": 126.9780, "aliases": ["seoul"]},
    "Busan, Korea":      {"lat": 35.1796, "lng": 129.0756, "aliases": ["busan", "pusan"]},

    # ---- Other world origins (community members) ---------------------------
    "United States":     {"lat": 39.8283, "lng": -98.5795, "aliases": ["united states", "u.s.a.", "u.s.", "america", "american"]},
    "England, UK":       {"lat": 52.3555, "lng": -1.1743, "aliases": ["english"]},
    "Scotland":          {"lat": 56.4907, "lng": -4.2026, "aliases": ["scotland", "scottish", "glasgow", "edinburgh"]},
    "Ireland":           {"lat": 53.1424, "lng": -7.6921, "aliases": ["ireland", "irish", "dublin"]},
    "Russia":            {"lat": 61.5240, "lng": 105.3188, "aliases": ["russia", "russian", "soviet union", "ussr", "moscow"]},
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
