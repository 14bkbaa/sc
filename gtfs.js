/* GTFS helper (opcionális)
   Cél: időpontok nélkül, csak útvonal-háló, hogy két pont között
   (gyalog->megálló, háló, megálló->gyalog) becsült időt lehessen adni.

   A böngészőben a teljes GTFS text parsing mobilon nehéz, ezért
   ez a modul egy ELŐKÉSZÍTETT fájlt vár:

     /gtfs/graph.json

   Ezt egy egyszeri pre-process scriptből érdemes legyártani
   (lásd build_gtfs_graph.py a csomagban).

   Ha graph.json nincs, a BKV mód automatikusan KI marad.

   graph.json minimális formátuma:
   {
     "stops": [{"id":"...", "name":"...", "lat":47..., "lon":19...}, ...],
     "edges": [{"from":0,"to":123,"w":180,"route":"4-6","type":0}, ...],
     "routeTypes": { "0": "tram", "3":"bus", ... } // opcionális
   }

   where:
   - from/to: stops index
   - w: seconds (estimated in preprocessing)
*/
(() => {
  'use strict';

  const GTFS = {
    _ready: false,
    _stops: null,
    _edges: null,
    _adj: null,

    async init() {
      try {
        const r = await fetch('./gtfs/graph.json', { cache: 'force-cache' });
        if (!r.ok) return false;
        const j = await r.json();
        if (!j || !Array.isArray(j.stops) || !Array.isArray(j.edges)) return false;

        GTFS._stops = j.stops;
        GTFS._edges = j.edges;

        // adjacency
        GTFS._adj = Array.from({ length: GTFS._stops.length }, () => []);
        for (const e of GTFS._edges) {
          if (typeof e.from !== 'number' || typeof e.to !== 'number' || typeof e.w !== 'number') continue;
          GTFS._adj[e.from].push(e);
        }

        GTFS._ready = true;
        return true;
      } catch {
        return false;
      }
    },

    isReady() { return GTFS._ready; },

    // Return nearest stop indices to a point.
    nearestStops(pt, k = 6, maxM = 1200) {
      if (!GTFS._ready) return [];
      const res = [];
      for (let i = 0; i < GTFS._stops.length; i++) {
        const s = GTFS._stops[i];
        const d = haversineM(pt.lat, pt.lng, s.lat, s.lon);
        if (d <= maxM) res.push({ i, d });
      }
      res.sort((a,b)=>a.d-b.d);
      return res.slice(0, k);
    },

    // Plan with a basic Dijkstra between nearby stops (no times).
    // Returns geometry as straight lines between stops (since shapes are not used).
    async plan(from, to, opt = {}) {
      if (!GTFS._ready) return null;

      const maxWalk = opt.maxWalkToStopM ?? 900;
      const startStops = GTFS.nearestStops(from, 6, maxWalk);
      const endStops = GTFS.nearestStops(to, 6, maxWalk);

      if (!startStops.length || !endStops.length) return null;

      // walking speed (m/s) and transfer penalty
      const walkSpeed = 1.25; // ~4.5 km/h
      const walkCost = (m) => m / walkSpeed;

      // Dijkstra from multiple sources
      const N = GTFS._stops.length;
      const dist = new Float64Array(N);
      const prev = new Int32Array(N);
      const prevEdge = Array.from({ length: N }, () => null);
      for (let i=0;i<N;i++){ dist[i]=Infinity; prev[i]=-1; }

      // simple binary heap
      const heap = [];
      const push = (d, i) => { heap.push([d,i]); siftUp(heap.length-1); };
      const pop = () => {
        if (!heap.length) return null;
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) { heap[0]=last; siftDown(0); }
        return top;
      };
      const siftUp = (idx) => {
        while (idx>0){
          const p=(idx-1)>>1;
          if (heap[p][0] <= heap[idx][0]) break;
          [heap[p],heap[idx]]=[heap[idx],heap[p]];
          idx=p;
        }
      };
      const siftDown = (idx) => {
        for(;;){
          const l=idx*2+1, r=l+1;
          let s=idx;
          if (l<heap.length && heap[l][0] < heap[s][0]) s=l;
          if (r<heap.length && heap[r][0] < heap[s][0]) s=r;
          if (s===idx) break;
          [heap[s],heap[idx]]=[heap[idx],heap[s]];
          idx=s;
        }
      };

      for (const ss of startStops) {
        dist[ss.i] = walkCost(ss.d);
        push(dist[ss.i], ss.i);
      }

      const endSet = new Set(endStops.map(x => x.i));
      let bestEnd = null;

      while (heap.length) {
        const [d,u] = pop();
        if (d !== dist[u]) continue;
        if (endSet.has(u)) { bestEnd = u; break; }
        for (let ei=0; ei<GTFS._adj[u].length; ei++){
          const e = GTFS._adj[u][ei];
          const nd = d + e.w;
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prev[e.to] = u;
            prevEdge[e.to] = e;
            push(nd, e.to);
          }
        }
      }

      if (bestEnd == null) return null;

      // add final walking to destination
      const endChoice = endStops.reduce((a,x)=> (x.i===bestEnd && x.d < (a?.d ?? Infinity)) ? x : a, null)
        || endStops[0];
      const total = dist[bestEnd] + walkCost(endChoice.d);

      // Build polyline: from->nearest startStop line, then stop chain, then to
      const chain = [];
      const edgeChainRev = [];
      let cur = bestEnd;
      chain.push(cur);
      while (prev[cur] !== -1) {
        edgeChainRev.push(prevEdge[cur]);
        cur = prev[cur];
        chain.push(cur);
      }
      chain.reverse();
      const edgeChain = edgeChainRev.reverse();

      // Collect line/járat info from used edges (if available in graph.json)
      const edgeLines = [];
      for (const e of edgeChain) {
        const ls = Array.isArray(e?.lines) ? e.lines :
                   (typeof e?.line === 'string' ? [e.line] :
                   (typeof e?.route === 'string' ? [e.route] : []));
        for (const x of (ls || [])) if (x) edgeLines.push(String(x));
      }
      const uniqLines = Array.from(new Set(edgeLines)).sort();

      // Group into "legs" by first line name
      const legs = [];
      let curLeg = null;
      for (let i = 0; i < edgeChain.length; i++) {
        const e = edgeChain[i];
        const ls = Array.isArray(e?.lines) ? e.lines :
                   (typeof e?.line === 'string' ? [e.line] :
                   (typeof e?.route === 'string' ? [e.route] : []));
        const first = Array.from(new Set((ls || []).filter(Boolean))).map(String).sort()[0] || null;
        const fromN = GTFS._stops[chain[i]].name;
        const toN = GTFS._stops[chain[i+1]].name;

        if (!curLeg || curLeg.line !== first) {
          if (curLeg) legs.push(curLeg);
          curLeg = { line: first, fromStop: fromN, toStop: toN, stops: 1 };
        } else {
          curLeg.toStop = toN;
          curLeg.stops += 1;
        }
      }
      if (curLeg) legs.push(curLeg);

const geometry = [];
      geometry.push({ lat: from.lat, lng: from.lng });

      // connect to first stop
      const s0 = GTFS._stops[chain[0]];
      geometry.push({ lat: s0.lat, lng: s0.lon });

      for (let k=1;k<chain.length;k++){
        const s = GTFS._stops[chain[k]];
        geometry.push({ lat: s.lat, lng: s.lon });
      }

      geometry.push({ lat: to.lat, lng: to.lng });

      return {
        totalDuration: total,
        totalDistance: null,
        geometry,
        meta: {
          startStop: s0.name,
          endStop: GTFS._stops[bestEnd].name,
          stops: chain.length,
          lines: uniqLines,
          legs
        }
      };
    }
  };

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => d*Math.PI/180;
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }

  window.GTFS = GTFS;
})();
