import argparse, csv, json, math, zipfile, io
from pathlib import Path

# Egyszerű becslés (idők nélkül): átlagos tömegközlekedési "sebesség"
TRANSIT_SPEED_MPS = 6.0   # ~21.6 km/h (durva átlag)
STOP_PENALTY_SEC = 20     # megállónkénti büntetés

# Megjegyzés:
# - Ez egy "menetrend nélküli" gráf (csak topológia).
# - A cél: útvonal-vázlat + járatszám(ok) megjelenítése a StreetCrowd Plannerben,
#   nem pedig pontos indulási idők számítása.

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.pi/180.0
    dlat = (lat2-lat1)*p
    dlon = (lon2-lon1)*p
    a = math.sin(dlat/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(a))

def read_csv_from_zip(zf: zipfile.ZipFile, name: str):
    b = zf.read(name)
    # BKK GTFS-eknél tipikusan UTF-8, de előfordulhat BOM
    try:
        s = b.decode("utf-8-sig")
    except:
        s = b.decode("latin-1")
    f = io.StringIO(s)
    r = csv.DictReader(f)
    for row in r:
        yield row

def find_name(zf: zipfile.ZipFile, candidates):
    names = set(zf.namelist())
    for c in candidates:
        if c in names:
            return c
    # ha alkönyvtárban van
    for n in names:
        low = n.lower()
        for c in candidates:
            if low.endswith("/"+c.lower()) or low.endswith("\"+c.lower()) or low.endswith(c.lower()):
                return n
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, help="GTFS ZIP (BKK/Budapest)")
    ap.add_argument("--out", default="graph.json", help="Kimeneti graph.json")
    args = ap.parse_args()

    with zipfile.ZipFile(args.zip, "r") as zf:
        stops_name = find_name(zf, ["stops.txt"])
        st_name = find_name(zf, ["stop_times.txt"])
        trips_name = find_name(zf, ["trips.txt"])
        routes_name = find_name(zf, ["routes.txt"])

        if not stops_name or not st_name:
            raise SystemExit("Hiba: stops.txt vagy stop_times.txt nincs a zipben.")

        # -------- stops --------
        stops = []
        stop_index = {}
        for r in read_csv_from_zip(zf, stops_name):
            sid = r.get("stop_id")
            if not sid:
                continue
            try:
                lat = float(r.get("stop_lat", ""))
                lon = float(r.get("stop_lon", ""))
            except:
                continue
            name = (r.get("stop_name") or "").strip()
            stop_index[sid] = len(stops)
            stops.append({"id": sid, "name": name, "lat": lat, "lon": lon})

        # -------- route / trip mapping (járat info) --------
        trip_to_route = {}
        route_label = {}

        if trips_name and routes_name:
            # routes: route_id -> short/long name
            for r in read_csv_from_zip(zf, routes_name):
                rid = r.get("route_id")
                if not rid:
                    continue
                short = (r.get("route_short_name") or "").strip()
                long = (r.get("route_long_name") or "").strip()
                route_label[rid] = short or long or rid

            # trips: trip_id -> route_id
            for r in read_csv_from_zip(zf, trips_name):
                tid = r.get("trip_id")
                rid = r.get("route_id")
                if tid and rid:
                    trip_to_route[tid] = rid

        def line_for_trip(tid: str) -> str:
            rid = trip_to_route.get(tid)
            lab = route_label.get(rid) if rid else None
            return (lab or "BKV").strip() or "BKV"

        # -------- edges --------
        # (from_idx,to_idx) -> {"w": best_w, "lines": set([...])}
        edges = {}

        # STOP_TIMES feldolgozás idők nélkül:
        # csak trip_id + stop_sequence + stop_id kell.
        #
        # Feltételezés: a stop_times általában trip_id + stop_sequence szerint rendezett.
        last_by_trip = {}  # trip_id -> (last_seq, last_stop_id)

        for r in read_csv_from_zip(zf, st_name):
            tid = r.get("trip_id")
            sid = r.get("stop_id")
            seq = r.get("stop_sequence")
            if not tid or not sid or not seq:
                continue
            if sid not in stop_index:
                continue
            try:
                seqn = int(seq)
            except:
                continue

            prev = last_by_trip.get(tid)
            if prev:
                last_seq, last_sid = prev
                # Ha a sorok nincsenek rendezve, csak az előrehaladást fogjuk felvenni
                if seqn == last_seq + 1 and last_sid in stop_index:
                    ia = stop_index[last_sid]
                    ib = stop_index[sid]
                    a = stops[ia]
                    b = stops[ib]
                    dist = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
                    w = dist/TRANSIT_SPEED_MPS + STOP_PENALTY_SEC

                    line = line_for_trip(tid)

                    key = (ia, ib)
                    if key not in edges or w < edges[key]["w"]:
                        edges[key] = {"w": w, "lines": {line}}
                    else:
                        # ha azonos (vagy nagyon közeli) súly, gyűjtsük a járatokat
                        if abs(w - edges[key]["w"]) < 1e-6:
                            edges[key]["lines"].add(line)

            last_by_trip[tid] = (seqn, sid)

        # Limitáljuk a soronként tárolt járatokat (különben csomópontoknál túl sok lehet)
        out_edges = []
        for (fa, ta), info in edges.items():
            lines = sorted({x for x in info["lines"] if x})
            out_edges.append({
                "from": fa,
                "to": ta,
                "w": info["w"],
                "route": "BKV",
                "type": 3,
                "lines": lines[:8],
            })

        out = {
            "stops": stops,
            "edges": out_edges
        }

        out_path = Path(args.out)
        out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        print(f"Kész: {out_path} (stops={len(stops)}, edges={len(out_edges)})")

if __name__ == "__main__":
    main()
