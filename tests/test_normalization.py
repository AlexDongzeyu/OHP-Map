"""Place-name normalization: Lemberg -> Lviv etc. (doc 01 geocoding problem)."""
from pipeline import gazetteer


def test_known_exonyms_map_to_canonical():
    assert gazetteer.normalize("Lemberg") == "Lviv, Ukraine"
    assert gazetteer.normalize("Lwów") == "Lviv, Ukraine"
    assert gazetteer.normalize("Pressburg") == "Bratislava, Slovakia"
    assert gazetteer.normalize("Cracow") == "Krakow, Poland"
    assert gazetteer.normalize("Breslau") == "Wroclaw, Poland"


def test_case_and_whitespace_insensitive():
    assert gazetteer.normalize("  LEMBERG ") == "Lviv, Ukraine"
    assert gazetteer.normalize("auschwitz") == "Auschwitz (Oswiecim), Poland"


def test_phrasing_with_extra_words():
    # "the Lemberg ghetto" should still resolve the place token.
    assert gazetteer.normalize("the Lemberg ghetto") == "Lviv, Ukraine"


def test_unknown_place_returns_none_not_a_guess():
    # An honest "unplaced" beats a wrong pin (doc 08 weakness #9).
    assert gazetteer.normalize("Some Village Nobody Listed") is None
    assert gazetteer.normalize("") is None


def test_known_site_roles():
    assert gazetteer.known_site_role("Auschwitz (Oswiecim), Poland") == "camp"
    assert gazetteer.known_site_role("Nowhere") is None
