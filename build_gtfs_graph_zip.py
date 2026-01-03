import argparse, csv, json, math, zipfile, io
from pathlib import Path

# Egyszerű becslés (idők nélkül): átlagos tömegközlekedési "sebesség"
TRANSIT_SPEED_MPS = 6.0   # ~21.6 km/h (durva átlag)
STOP_PENALTY_SEC = 20     # megállónkénti büntetés

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.pi/180.0
    dlat = (lat2-lat1)*p
    dlon = (lon2-lon1)*p
    a = math.sin(dlat/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(a))

def read_csv_from_zip(zf: zipfile.ZipFile, name: str):
    with zf.open(name, "r") as f:
        # UTF-8 BOM kezelése
        text = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, help="GTFS zip fájl (pl. gtfs/bkk_gtfs.zip)")
    ap.add_argument("--out", required=True, help="Kimenet graph.json (pl. gtfs/graph.json)")
    args = ap.parse_args()

    zip_path = Path(args.zip)
    if not zip_path.exists():
        raise SystemExit(f"Nincs ilyen zip: {zip_path}")

    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())
        # néha mappában vannak a fájlok, ezért keressük meg a vége alapján
        def find_name(suffix):
            for n in names:
                if n.lower().endswith(suffix):
                    return n
            return None

        stops_name = find_name("stops.txt")
        st_name = find_name("stop_times.txt")
        if not stops_name or not st_name:
            raise SystemExit("A zip-ben kell stops.txt és stop_times.txt (nem kell kibontani).")

        # stops
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

        # edges: (from_idx,to_idx) -> best_w
        edges = {}

        # STOP_TIMES feldolgozás idők nélkül:
        # csak trip_id + stop_sequence + stop_id kell.
        #
        # Feltételezés: a stop_times általában trip_id + stop_sequence szerint rendezett
        # (BKK GTFS-eknél ez tipikusan így van). Ha mégsem, akkor ez a módszer hiányos lehet.
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
            if prev is None:
                last_by_trip[tid] = (seqn, sid)
                continue

            last_seq, last_sid = prev
            # Ha a sorrend "visszaugrik", új szekció (újraindítjuk)
            if seqn <= last_seq:
                last_by_trip[tid] = (seqn, sid)
                continue

            a = last_sid
            b = sid
            ia = stop_index[a]
            ib = stop_index[b]

            sa = stops[ia]
            sb = stops[ib]
            dist = haversine_m(sa["lat"], sa["lon"], sb["lat"], sb["lon"])
            w = int(dist / TRANSIT_SPEED_MPS + STOP_PENALTY_SEC)

            key = (ia, ib)
            if key not in edges or w < edges[key]:
                edges[key] = w

            last_by_trip[tid] = (seqn, sid)

        out = {
            "stops": stops,
            "edges": [{"from": k[0], "to": k[1], "w": w, "route": "BKV", "type": 3} for k, w in edges.items()]
        }

        out_path = Path(args.out)
        out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        print(f"Kész: {out_path} (stops={len(stops)}, edges={len(out['edges'])})")

if __name__ == "__main__":
    main()
