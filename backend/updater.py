#!/usr/bin/env python3
"""
MITECO Gas Price Data Pipeline (updater.py)
Fetches daily fuel prices for gas stations in the province of Valencia (Spain),
cleans and parses the data, maintains a per-station rolling 7-day historical record,
computes station-level statistics (mean, price trend, percentual trend), and exports
a single consolidated dataset to `stations.json`.
"""

import os
import sys
import json
import ssl
import urllib.request
from datetime import datetime, timezone

# Configuration
PROVINCE_ID = "46"  # Valencia
MITECO_URL = f"https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/{PROVINCE_ID}"
RETENTION_DAYS = 7

# Setup Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "frontend", "public", "data")
STATIONS_JSON_PATH = os.path.join(DATA_DIR, "stations.json")
DEPRECATED_FILES = [
    os.path.join(DATA_DIR, "latest.json"),
    os.path.join(DATA_DIR, "history.json"),
]


def fetch_data(url):
    """
    Fetches the JSON data from the MITECO API.
    Attempts to use requests with custom SSL context (SECLEVEL=1 required for legacy
    Spanish administration endpoints), falling back to urllib.request.
    """
    print(f"[{datetime.now().isoformat()}] Fetching data from: {url}")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
    }

    # Attempt 1: requests with SECLEVEL=1 adapter
    try:
        import requests
        from requests.adapters import HTTPAdapter
        from urllib3.util.ssl_ import create_urllib3_context

        class MitecoAdapter(HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                try:
                    kwargs["ssl_context"] = create_urllib3_context(ciphers="DEFAULT@SECLEVEL=1")
                except Exception:
                    pass
                return super().init_poolmanager(*args, **kwargs)

        session = requests.Session()
        session.mount("https://", MitecoAdapter())
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"requests fetch failed ({e}). Falling back to urllib.request...")

    # Attempt 2: urllib.request with SECLEVEL=1 SSL context
    ctx = ssl.create_default_context()
    try:
        ctx.set_ciphers("DEFAULT@SECLEVEL=1")
    except Exception:
        pass

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, context=ctx, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_float(val):
    """Converts a comma-decimal string (e.g., '1,739') or any other number representation to float."""
    if val is None:
        return None
    val_str = str(val).strip().replace(",", ".")
    if not val_str:
        return None
    try:
        return float(val_str)
    except ValueError:
        return None


def sanitize_string(val):
    """Trims whitespace and normalizes space separation in strings."""
    if not val:
        return ""
    return " ".join(str(val).split())


def is_valid_price(price):
    """Validates that a price is not an extreme outlier / error (between 0.50 and 3.50 EUR/L)."""
    return price is not None and 0.5 <= price <= 3.5


def clean_station_data(raw_stations):
    """Filters, cleans, and structures raw station records."""
    clean_list = []
    skipped_coords = 0
    skipped_no_price = 0

    for station in raw_stations:
        # Coordinates
        lat = parse_float(station.get("Latitud"))
        lng = parse_float(station.get("Longitud (WGS84)"))

        # Coordinate sanity check
        if lat is None or lng is None or lat == 0.0 or lng == 0.0:
            skipped_coords += 1
            continue

        # Extract and parse prices
        price_g95 = parse_float(station.get("Precio Gasolina 95 E5"))
        price_da = parse_float(station.get("Precio Gasoleo A"))
        price_g98 = parse_float(station.get("Precio Gasolina 98 E5"))
        price_da_premium = parse_float(station.get("Precio Gasoleo Premium"))

        # Price validation
        if price_g95 is not None and not is_valid_price(price_g95):
            price_g95 = None
        if price_da is not None and not is_valid_price(price_da):
            price_da = None
        if price_g98 is not None and not is_valid_price(price_g98):
            price_g98 = None
        if price_da_premium is not None and not is_valid_price(price_da_premium):
            price_da_premium = None

        # Filter out stations with no relevant prices at all
        if all(p is None for p in [price_g95, price_da, price_g98, price_da_premium]):
            skipped_no_price += 1
            continue

        clean_list.append({
            "id": sanitize_string(station.get("IDEESS")),
            "name": sanitize_string(station.get("Rótulo")),
            "address": sanitize_string(station.get("Dirección")),
            "locality": sanitize_string(station.get("Localidad")),
            "municipality": sanitize_string(station.get("Municipio")),
            "postal_code": sanitize_string(station.get("C.P.")),
            "latitude": lat,
            "longitude": lng,
            "schedule": sanitize_string(station.get("Horario")),
            "price_gasoline_95": price_g95,
            "price_diesel_a": price_da,
            "price_gasoline_98": price_g98,
            "price_diesel_premium": price_da_premium,
        })

    print(f"Processed raw stations. Success: {len(clean_list)}, Skipped (Invalid Coords): {skipped_coords}, Skipped (No valid prices): {skipped_no_price}")
    return clean_list


def compute_station_stats(data_entries):
    """
    Computes rolling statistics (mean, price change trend, and percentual trend)
    for each fuel type over the rolling window of daily observations.
    """
    fuels = ["gasoline_95", "diesel_a", "gasoline_98", "diesel_premium"]
    stats = {}

    for fuel in fuels:
        price_key = f"price_{fuel}"
        prices = [d[price_key] for d in data_entries if d.get(price_key) is not None]

        if not prices:
            stats[f"mean_{price_key}"] = None
            stats[f"trend_{price_key}"] = None
            stats[f"trend_percent_{price_key}"] = None
        elif len(prices) == 1:
            stats[f"mean_{price_key}"] = round(prices[0], 3)
            stats[f"trend_{price_key}"] = 0.0
            stats[f"trend_percent_{price_key}"] = 0.0
        else:
            oldest = prices[0]
            latest = prices[-1]
            mean_val = round(sum(prices) / len(prices), 3)
            trend_val = round(latest - oldest, 3)
            trend_pct = round(((latest - oldest) / oldest) * 100, 2) if oldest > 0 else 0.0

            stats[f"mean_{price_key}"] = mean_val
            stats[f"trend_{price_key}"] = trend_val
            stats[f"trend_percent_{price_key}"] = trend_pct

    return stats


def parse_date_str(date_val):
    """
    Parses a date string supporting ISO (YYYY-MM-DD) and common formats (DD/MM/YYYY, DD-MM-YYYY).
    Returns a datetime.date object or None.
    """
    if not date_val:
        return None
    if isinstance(date_val, datetime):
        return date_val.date()
    val_str = str(date_val).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(val_str, fmt).date()
        except ValueError:
            continue
    return None


def update_stations_dataset(existing_stations_map, clean_scraped_stations, date_str, retention_days=RETENTION_DAYS):
    """
    Merges newly scraped station data with existing rolling historical data,
    pruning observations strictly older than retention_days (calendar difference),
    and updating station-level statistics.
    """
    ref_date = parse_date_str(date_str) or datetime.now(timezone.utc).date()
    normalized_today_str = ref_date.strftime("%Y-%m-%d")

    # Normalize station ID keys to string for robust matching
    existing_map = {str(k): v for k, v in existing_stations_map.items()}
    scraped_map = {str(s["id"]): s for s in clean_scraped_stations}
    all_station_ids = set(existing_map.keys()).union(scraped_map.keys())

    updated_stations = []

    for s_id in all_station_ids:
        scraped_st = scraped_map.get(s_id)
        existing_st = existing_map.get(s_id)

        source = scraped_st or existing_st
        station_record = {
            "id": str(source["id"]),
            "name": source["name"],
            "address": source["address"],
            "locality": source["locality"],
            "municipality": source["municipality"],
            "postal_code": source["postal_code"],
            "latitude": source["latitude"],
            "longitude": source["longitude"],
            "schedule": source["schedule"],
        }

        # Retrieve and index existing historical observations by normalized date
        entries_by_date = {}
        for entry in (existing_st.get("data", []) if existing_st else []):
            e_date = parse_date_str(entry.get("date"))
            if not e_date:
                continue
            diff_days = (ref_date - e_date).days
            # Prune only observations older than retention_days (diff_days > retention_days)
            # Retain observations where diff_days <= retention_days
            if diff_days <= retention_days:
                date_key = e_date.strftime("%Y-%m-%d")
                entries_by_date[date_key] = {
                    "date": date_key,
                    "price_gasoline_95": parse_float(entry.get("price_gasoline_95")),
                    "price_diesel_a": parse_float(entry.get("price_diesel_a")),
                    "price_gasoline_98": parse_float(entry.get("price_gasoline_98")),
                    "price_diesel_premium": parse_float(entry.get("price_diesel_premium")),
                }

        # If station was observed today, update or set today's entry
        if scraped_st:
            entries_by_date[normalized_today_str] = {
                "date": normalized_today_str,
                "price_gasoline_95": scraped_st["price_gasoline_95"],
                "price_diesel_a": scraped_st["price_diesel_a"],
                "price_gasoline_98": scraped_st["price_gasoline_98"],
                "price_diesel_premium": scraped_st["price_diesel_premium"],
            }

        # Sort entries chronologically
        valid_entries = [entries_by_date[d] for d in sorted(entries_by_date.keys())]

        # If no entries remain within the window, drop station
        if not valid_entries:
            continue

        station_record["data"] = valid_entries
        station_record["stats"] = compute_station_stats(valid_entries)
        updated_stations.append(station_record)

    # Sort deterministically by municipality, then name, then id
    updated_stations.sort(key=lambda s: (s.get("municipality", ""), s.get("name", ""), s.get("id", "")))
    return updated_stations


def main():
    # 1. Fetch raw data
    try:
        raw_data = fetch_data(MITECO_URL)
    except Exception as e:
        print(f"Error fetching data: {e}")
        sys.exit(1)

    # Extract date from response (format: "dd/mm/yyyy hh:mm:ss")
    fecha_raw = raw_data.get("Fecha", "")
    date_str = ""
    if fecha_raw:
        try:
            date_part = fecha_raw.split(" ")[0]
            day, month, year = date_part.split("/")
            date_str = f"{year}-{month:0>2}-{day:0>2}"
            print(f"Data reference date from MITECO: {date_str}")
        except Exception as e:
            print(f"Error parsing date string '{fecha_raw}': {e}")

    if not date_str:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        print(f"Falling back to system date: {date_str}")

    raw_stations = raw_data.get("ListaEESSPrecio", [])
    if not raw_stations:
        print("No stations found in the API response.")
        sys.exit(1)

    # 2. Clean and parse data
    clean_stations = clean_station_data(raw_stations)
    if not clean_stations:
        print("No valid stations remaining after cleaning.")
        sys.exit(1)

    # 3. Load existing dataset
    os.makedirs(DATA_DIR, exist_ok=True)
    existing_stations_map = {}

    if os.path.exists(STATIONS_JSON_PATH):
        try:
            with open(STATIONS_JSON_PATH, "r", encoding="utf-8") as f:
                loaded_list = json.load(f)
                if isinstance(loaded_list, list):
                    for st in loaded_list:
                        if isinstance(st, dict) and "id" in st:
                            existing_stations_map[str(st["id"])] = st
            print(f"Loaded {len(existing_stations_map)} existing station records from stations.json")
        except Exception as e:
            print(f"Warning: Could not read existing stations.json: {e}")

    # 4. Merge rolling history & calculate per-station statistics
    updated_stations = update_stations_dataset(existing_stations_map, clean_stations, date_str)
    print(f"Updated stations dataset: {len(updated_stations)} active stations.")

    # 5. Export consolidated stations.json
    print(f"Saving data to {STATIONS_JSON_PATH}")
    with open(STATIONS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(updated_stations, f, indent=2, ensure_ascii=False)

    # 6. Remove redundant deprecated files if present
    for old_file in DEPRECATED_FILES:
        if os.path.exists(old_file):
            try:
                os.remove(old_file)
                print(f"Cleaned up deprecated file: {old_file}")
            except OSError as e:
                print(f"Warning: Could not remove {old_file}: {e}")

    print("Pipeline update complete successfully.")


if __name__ == "__main__":
    main()
