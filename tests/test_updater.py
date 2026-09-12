import pytest
from datetime import datetime
from backend.updater import (
    parse_float,
    sanitize_string,
    is_valid_price,
    clean_station_data,
    compute_station_stats,
    update_stations_dataset,
    RETENTION_DAYS,
)


def test_parse_float():
    assert parse_float("1,739") == 1.739
    assert parse_float("1.739") == 1.739
    assert parse_float(1.5) == 1.5
    assert parse_float("-0.35") == -0.35
    assert parse_float("") is None
    assert parse_float("   ") is None
    assert parse_float(None) is None
    assert parse_float("invalid") is None


def test_sanitize_string():
    assert sanitize_string("  CALLE   MAYOR  ") == "CALLE MAYOR"
    assert sanitize_string("REPSOL\n") == "REPSOL"
    assert sanitize_string("") == ""
    assert sanitize_string(None) == ""


def test_is_valid_price():
    assert is_valid_price(1.65) is True
    assert is_valid_price(0.50) is True
    assert is_valid_price(3.50) is True
    assert is_valid_price(0.49) is False
    assert is_valid_price(3.51) is False
    assert is_valid_price(0.0) is False
    assert is_valid_price(-1.5) is False
    assert is_valid_price(None) is False


def test_clean_station_data():
    raw_sample = [
        {
            "IDEESS": "1001",
            "Rótulo": "PETROPRIX",
            "Dirección": "CALLE REAL 1",
            "Localidad": "VALENCIA",
            "Municipio": "Valencia",
            "C.P.": "46001",
            "Latitud": "39,4699",
            "Longitud (WGS84)": "-0,3763",
            "Horario": "L-D: 24H",
            "Precio Gasolina 95 E5": "1,559",
            "Precio Gasoleo A": "1,499",
            "Precio Gasolina 98 E5": "1,709",
            "Precio Gasoleo Premium": "1,609",
        },
        # Skipped due to 0 coordinates
        {
            "IDEESS": "1002",
            "Rótulo": "BAD COORDS",
            "Latitud": "0",
            "Longitud (WGS84)": "0",
            "Precio Gasolina 95 E5": "1,500",
        },
        # Skipped due to no valid prices
        {
            "IDEESS": "1003",
            "Rótulo": "NO PRICES",
            "Latitud": "39,4699",
            "Longitud (WGS84)": "-0,3763",
            "Precio Gasolina 95 E5": "99,99",
            "Precio Gasoleo A": "0,10",
        },
    ]

    cleaned = clean_station_data(raw_sample)
    assert len(cleaned) == 1
    station = cleaned[0]
    assert station["id"] == "1001"
    assert station["name"] == "PETROPRIX"
    assert station["latitude"] == pytest.approx(39.4699)
    assert station["longitude"] == pytest.approx(-0.3763)
    assert station["price_gasoline_95"] == 1.559
    assert station["price_diesel_a"] == 1.499
    assert station["price_gasoline_98"] == 1.709
    assert station["price_diesel_premium"] == 1.609


def test_compute_station_stats_single_entry():
    data = [
        {
            "date": "2026-09-12",
            "price_gasoline_95": 1.730,
            "price_diesel_a": 1.770,
            "price_gasoline_98": None,
            "price_diesel_premium": None,
        }
    ]
    stats = compute_station_stats(data)
    assert stats["mean_price_gasoline_95"] == 1.730
    assert stats["trend_price_gasoline_95"] == 0.0
    assert stats["trend_percent_price_gasoline_95"] == 0.0
    assert stats["mean_price_diesel_a"] == 1.770
    assert stats["trend_price_diesel_a"] == 0.0
    assert stats["trend_percent_price_diesel_a"] == 0.0
    assert stats["mean_price_gasoline_98"] is None
    assert stats["trend_price_gasoline_98"] is None
    assert stats["trend_percent_price_gasoline_98"] is None


def test_compute_station_stats_multiple_entries():
    data = [
        {
            "date": "2024-06-09",
            "price_gasoline_95": 1.730,
            "price_diesel_a": 1.770,
            "price_gasoline_98": None,
            "price_diesel_premium": None,
        },
        {
            "date": "2024-06-10",
            "price_gasoline_95": 1.720,
            "price_diesel_a": 1.760,
            "price_gasoline_98": None,
            "price_diesel_premium": None,
        },
    ]
    stats = compute_station_stats(data)
    # Mean: (1.730 + 1.720) / 2 = 1.725
    assert stats["mean_price_gasoline_95"] == 1.725
    # Trend: latest - oldest = 1.720 - 1.730 = -0.010
    assert stats["trend_price_gasoline_95"] == -0.010
    # Percent: (-0.010 / 1.730) * 100 = -0.58%
    assert stats["trend_percent_price_gasoline_95"] == -0.58

    assert stats["mean_price_diesel_a"] == 1.765
    assert stats["trend_price_diesel_a"] == -0.010
    assert stats["trend_percent_price_diesel_a"] == -0.56


def test_update_stations_dataset_pruning_and_merge():
    # Existing station with a 20-day-old entry and a 2-day-old entry
    existing_map = {
        "1001": {
            "id": "1001",
            "name": "PETROPRIX",
            "address": "CALLE REAL 1",
            "locality": "VALENCIA",
            "municipality": "Valencia",
            "postal_code": "46001",
            "latitude": 39.4699,
            "longitude": -0.3763,
            "schedule": "L-D: 24H",
            "data": [
                {
                    "date": "2026-08-20",  # > 7 days old -> should be pruned
                    "price_gasoline_95": 1.600,
                    "price_diesel_a": 1.500,
                    "price_gasoline_98": None,
                    "price_diesel_premium": None,
                },
                {
                    "date": "2026-09-10",  # 2 days old -> should be kept
                    "price_gasoline_95": 1.650,
                    "price_diesel_a": 1.550,
                    "price_gasoline_98": None,
                    "price_diesel_premium": None,
                },
            ],
        }
    }

    scraped = [
        {
            "id": "1001",
            "name": "PETROPRIX",
            "address": "CALLE REAL 1",
            "locality": "VALENCIA",
            "municipality": "Valencia",
            "postal_code": "46001",
            "latitude": 39.4699,
            "longitude": -0.3763,
            "schedule": "L-D: 24H",
            "price_gasoline_95": 1.700,
            "price_diesel_a": 1.600,
            "price_gasoline_98": None,
            "price_diesel_premium": None,
        }
    ]

    result = update_stations_dataset(existing_map, scraped, date_str="2026-09-12", retention_days=7)

    assert len(result) == 1
    station = result[0]
    # Pruned the 2026-08-20 entry, kept 2026-09-10, added 2026-09-12
    assert len(station["data"]) == 2
    assert station["data"][0]["date"] == "2026-09-10"
    assert station["data"][1]["date"] == "2026-09-12"

    # Stats: (1.650 + 1.700) / 2 = 1.675
    assert station["stats"]["mean_price_gasoline_95"] == 1.675
    # Trend: 1.700 - 1.650 = +0.050
    assert station["stats"]["trend_price_gasoline_95"] == 0.050
    # Percent: (0.050 / 1.650) * 100 = 3.03%
    assert station["stats"]["trend_percent_price_gasoline_95"] == 3.03
