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


def test_update_stations_dataset_user_scenario_retention_days():
    """
    Validates user requirement:
    - If ref_date is 2026-09-13 (or 2026-11-13) and RETENTION_DAYS is 7:
    - Yesterday's data (2026-09-12) MUST be preserved.
    - Data up to 7 days old (2026-09-06) MUST be preserved.
    - Data strictly older than 7 days (e.g. 2026-09-05, 2026-09-04, anterior al 6) MUST be pruned.
    - Subsequent runs on the same date update today's prices without erasing yesterday's data.
    """
    existing_map = {
        "1001": {
            "id": "1001",
            "name": "REPSOL",
            "address": "AVENIDA DEL CID 10",
            "locality": "VALENCIA",
            "municipality": "Valencia",
            "postal_code": "46014",
            "latitude": 39.47,
            "longitude": -0.38,
            "schedule": "L-D: 24H",
            "data": [
                {"date": "2026-09-04", "price_gasoline_95": 1.500, "price_diesel_a": 1.400},  # 9 days old -> PRUNED
                {"date": "2026-09-05", "price_gasoline_95": 1.510, "price_diesel_a": 1.410},  # 8 days old (anterior al 6) -> PRUNED
                {"date": "2026-09-06", "price_gasoline_95": 1.520, "price_diesel_a": 1.420},  # 7 days old -> KEPT
                {"date": "2026-09-07", "price_gasoline_95": 1.530, "price_diesel_a": 1.430},  # 6 days old -> KEPT
                {"date": "2026-09-08", "price_gasoline_95": 1.540, "price_diesel_a": 1.440},  # 5 days old -> KEPT
                {"date": "2026-09-09", "price_gasoline_95": 1.550, "price_diesel_a": 1.450},  # 4 days old -> KEPT
                {"date": "2026-09-10", "price_gasoline_95": 1.560, "price_diesel_a": 1.460},  # 3 days old -> KEPT
                {"date": "2026-09-11", "price_gasoline_95": 1.570, "price_diesel_a": 1.470},  # 2 days old -> KEPT
                {"date": "2026-09-12", "price_gasoline_95": 1.580, "price_diesel_a": 1.480},  # 1 day old (ayer) -> KEPT
            ],
        }
    }

    scraped_today = [
        {
            "id": "1001",
            "name": "REPSOL",
            "address": "AVENIDA DEL CID 10",
            "locality": "VALENCIA",
            "municipality": "Valencia",
            "postal_code": "46014",
            "latitude": 39.47,
            "longitude": -0.38,
            "schedule": "L-D: 24H",
            "price_gasoline_95": 1.590,
            "price_diesel_a": 1.490,
            "price_gasoline_98": None,
            "price_diesel_premium": None,
        }
    ]

    # First run on 2026-09-13
    result = update_stations_dataset(existing_map, scraped_today, date_str="2026-09-13", retention_days=7)
    assert len(result) == 1
    station = result[0]

    # Dates present in data:
    result_dates = [d["date"] for d in station["data"]]

    # Assert 2026-09-04 and 2026-09-05 were PRUNED
    assert "2026-09-04" not in result_dates
    assert "2026-09-05" not in result_dates

    # Assert 2026-09-06 (7 days old) was KEPT
    assert "2026-09-06" in result_dates

    # Assert 2026-09-12 (ayer) was KEPT
    assert "2026-09-12" in result_dates
    yesterday_entry = next(d for d in station["data"] if d["date"] == "2026-09-12")
    assert yesterday_entry["price_gasoline_95"] == 1.580

    # Assert 2026-09-13 (hoy) was ADDED
    assert "2026-09-13" in result_dates
    today_entry = next(d for d in station["data"] if d["date"] == "2026-09-13")
    assert today_entry["price_gasoline_95"] == 1.590

    # Total entries: 2026-09-06 to 2026-09-13 (8 days)
    assert len(result_dates) == 8
    assert result_dates == [
        "2026-09-06",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-12",
        "2026-09-13",
    ]

    # Stats: oldest is 2026-09-06 (1.520), latest is 2026-09-13 (1.590)
    # Trend: 1.590 - 1.520 = 0.070
    assert station["stats"]["trend_price_gasoline_95"] == 0.070

    # Second run on the SAME DAY with updated price (e.g. afternoon price change to 1.595)
    scraped_afternoon = [
        {
            **scraped_today[0],
            "price_gasoline_95": 1.595,
        }
    ]
    # Update existing_map with previous run output
    updated_map = {station["id"]: station}
    result2 = update_stations_dataset(updated_map, scraped_afternoon, date_str="2026-09-13", retention_days=7)
    station2 = result2[0]

    # Assert still 8 entries, 2026-09-12 is STILL THERE, and 2026-09-13 was updated in place
    result_dates2 = [d["date"] for d in station2["data"]]
    assert len(result_dates2) == 8
    assert "2026-09-12" in result_dates2
    updated_today = next(d for d in station2["data"] if d["date"] == "2026-09-13")
    assert updated_today["price_gasoline_95"] == 1.595
