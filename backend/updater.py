#!/usr/bin/env python3
"""
MITECO Gas Price Data Pipeline (updater.py)
Fetches daily fuel prices for gas stations in the province of Valencia (Spain),
cleans and parses the data, updates a rolling 7-day history, calculates
statistics (trends, averages, cheapest stations), and exports JSON files.
"""

import os
import json
import urllib.request
from datetime import datetime, timezone

# Configuration
PROVINCE_ID = "46" # Valencia
MITECO_URL = f"https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/{PROVINCE_ID}"
RETENTION_DAYS = 7

# Setup Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "frontend", "public", "data")
LATEST_JSON_PATH = os.path.join(DATA_DIR, "latest.json")
HISTORY_JSON_PATH = os.path.join(DATA_DIR, "history.json")


def fetch_data(url):
    """
    Fetches the JSON data from the MITECO API.
    Attempts to use the requests library if available; otherwise falls back to urllib.
    """
    print(f"[{datetime.now().isoformat()}] Fetching data from: {url}")
    try:
        import requests
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json()
    except ImportError:
        print("requests library not found. Falling back to urllib.request...")
        req = urllib.request.Request(
            url, 
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
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
            "price_diesel_premium": price_da_premium
        })

    print(f"Processed raw stations. Success: {len(clean_list)}, Skipped (Invalid Coords): {skipped_coords}, Skipped (No valid prices): {skipped_no_price}")
    return clean_list


def main():
    # 1. Fetch raw data
    try:
        raw_data = fetch_data(MITECO_URL)
    except Exception as e:
        print(f"Error fetching data: {e}")
        return

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
        return

    # 2. Clean and parse data
    clean_stations = clean_station_data(raw_stations)
    if not clean_stations:
        print("No valid stations remaining after cleaning.")
        return

    # 3. History Management & Rolling Window
    # Create directories if they do not exist
    os.makedirs(DATA_DIR, exist_ok=True)

    history_entries = []
    if os.path.exists(HISTORY_JSON_PATH):
        try:
            with open(HISTORY_JSON_PATH, "r", encoding="utf-8") as f:
                history_data = json.load(f)
                if isinstance(history_data, dict) and "history" in history_data:
                    history_entries = history_data["history"]
                elif isinstance(history_data, list):
                    history_entries = history_data
                print(f"Loaded {len(history_entries)} entries from existing history.json")
        except Exception as e:
            print(f"Warning: Could not read existing history.json: {e}")

    # Calculate current day's averages
    valid_g95 = [s["price_gasoline_95"] for s in clean_stations if s["price_gasoline_95"] is not None]
    valid_da = [s["price_diesel_a"] for s in clean_stations if s["price_diesel_a"] is not None]

    avg_g95 = round(sum(valid_g95) / len(valid_g95), 3) if valid_g95 else 0.0
    avg_da = round(sum(valid_da) / len(valid_da), 3) if valid_da else 0.0

    print(f"Current Averages - Gasoline 95: {avg_g95:.3f} EUR, Diesel A: {avg_da:.3f} EUR")

    # Update or append current day's record
    existing_entry = next((e for e in history_entries if e.get("date") == date_str), None)
    if existing_entry:
        print(f"Updating existing record for date: {date_str}")
        existing_entry["avg_gasoline_95"] = avg_g95
        existing_entry["avg_diesel_a"] = avg_da
    else:
        print(f"Appending new record for date: {date_str}")
        history_entries.append({
            "date": date_str,
            "avg_gasoline_95": avg_g95,
            "avg_diesel_a": avg_da
        })

    # Sort history entries by date ascending
    history_entries.sort(key=lambda x: x.get("date", ""))

    # Retain only the last RETENTION_DAYS
    if len(history_entries) > RETENTION_DAYS:
        print(f"Enforcing retention limit of {RETENTION_DAYS} days. Removing {len(history_entries) - RETENTION_DAYS} old records.")
        history_entries = history_entries[-RETENTION_DAYS:]

    # 4. Statistics Calculation
    # Trend comparison with oldest record in rolling window
    trend_g95 = 0.0
    trend_da = 0.0
    if len(history_entries) > 1:
        oldest_entry = history_entries[0]
        old_avg_g95 = oldest_entry.get("avg_gasoline_95", 0.0)
        old_avg_da = oldest_entry.get("avg_diesel_a", 0.0)
        
        if old_avg_g95 > 0:
            trend_g95 = round(((avg_g95 - old_avg_g95) / old_avg_g95) * 100, 2)
        if old_avg_da > 0:
            trend_da = round(((avg_da - old_avg_da) / old_avg_da) * 100, 2)

    print(f"Trend - Gasoline 95: {trend_g95:+.2f}%, Diesel A: {trend_da:+.2f}% (compared to oldest record: {history_entries[0]['date']})")

    # Top 5 cheapest gas stations overall (for G95 and Diesel A)
    g95_stations = [s for s in clean_stations if s["price_gasoline_95"] is not None]
    g95_sorted = sorted(g95_stations, key=lambda x: x["price_gasoline_95"])
    cheapest_g95 = []
    for s in g95_sorted[:5]:
        cheapest_g95.append({
            "id": s["id"],
            "name": s["name"],
            "address": s["address"],
            "price": s["price_gasoline_95"],
            "latitude": s["latitude"],
            "longitude": s["longitude"]
        })

    da_stations = [s for s in clean_stations if s["price_diesel_a"] is not None]
    da_sorted = sorted(da_stations, key=lambda x: x["price_diesel_a"])
    cheapest_da = []
    for s in da_sorted[:5]:
        cheapest_da.append({
            "id": s["id"],
            "name": s["name"],
            "address": s["address"],
            "price": s["price_diesel_a"],
            "latitude": s["latitude"],
            "longitude": s["longitude"]
        })

    # Prepare outputs
    latest_output = clean_stations
    history_output = {
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": {
            "avg_gasoline_95": avg_g95,
            "avg_diesel_a": avg_da,
            "trend_gasoline_95": trend_g95,
            "trend_diesel_a": trend_da,
            "cheapest_gasoline_95": cheapest_g95,
            "cheapest_diesel_a": cheapest_da
        },
        "history": history_entries
    }

    # 5. Export JSON files
    print(f"Saving data to {LATEST_JSON_PATH}")
    with open(LATEST_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(latest_output, f, indent=2, ensure_ascii=False)

    print(f"Saving data to {HISTORY_JSON_PATH}")
    with open(HISTORY_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(history_output, f, indent=2, ensure_ascii=False)

    print("Pipeline update complete successfully.")


if __name__ == "__main__":
    main()
