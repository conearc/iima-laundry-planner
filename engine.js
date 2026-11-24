/*
 * IIMA Laundry Pickup — routing engine
 * Runs in the browser (website) and in JavaScriptCore (evaluation scripts).
 *
 * Problem: one laundry van parks near D42. A team of k people walks from the
 * van to students' rooms, climbs stairs, counts clothes, and walks back when
 * their arms are full (capacity C pieces per trip). Plan the trips so the
 * team finishes as early and as cheaply as possible, knowing that some
 * students will not be in when the team knocks.
 *
 * Algorithms compared (all finish with 2-opt, all split trips across the team
 * with the Least-Utilised-Bin rule):
 *   NN     Nearest-first greedy                      (classic construction heuristic)
 *   SF     Smallest-first greedy                     (fill trips with many small orders)
 *   SWEEP  Sweep heuristic                           (Session 9)
 *   CW     Clarke–Wright savings                     (Sessions 8–9)
 *   FFB    Farthest-First Bang-for-buck greedy       (our own heuristic)
 * Each can plan for the full ordered load, or "risk-aware": plan for the load
 * expected after no-shows, with a safety margin (chance constraint).
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    workers: 3,             // people walking (vendor + helpers)
    capacity: 60,           // pieces one person carries per trip
    shiftMin: 240,          // planned working minutes on campus
    setupMin: 20,           // drive in, park, unload at the end (fixed per day)
    walkMPerMin: 60,        // walking speed
    stairMinPerFloor: 0.4,  // one way, per floor
    serviceMin: 1.0,        // knock, bag, note-down per present order
    countSecPerPiece: 8,    // counting clothes with the student
    noShowWaitMin: 2.0,     // knock, wait, leave when nobody is in
    unloadMin: 1.0,         // drop the armload at the van
    teamRatePerHour: 100,   // Rs per person-hour (opportunity cost)
    overtimeMult: 1.5,      // minutes beyond the shift cost 1.5x
    pricePerPiece: 20,      // Rs charged to students
    detourFactor: 1.15,     // footpaths are 15% longer than straight lines between nodes
    linkRadius: 70,         // metres: nodes closer than this are joined by a footpath
    linkNearest: 3,         // ...and every node is joined to its 3 nearest neighbours
    riskZ: 1.0,             // safety margin (std devs) for risk-aware planning
    mshOrderMultiplier: 1.5 // families order more often
  };

  // The four methods shown on the website: three from class, one of our own.
  // (Smallest-first, farthest-first bang-for-buck and plain GTS are still in this file,
  //  but they lost in testing, so the site no longer shows them.)
  var ALGOS = [
    { id: 'NN', name: 'Nearest-neighbour', short: 'Nearest-neighbour', source: 'Class: TSP construction heuristic (Sessions 1–4)' },
    { id: 'SWEEP', name: 'Sweep', short: 'Sweep', source: 'Class: Session 9' },
    { id: 'CW', name: 'Clarke–Wright savings', short: 'Clarke–Wright', source: 'Class: Sessions 8–9' },
    { id: 'GTS+', name: 'Our method: tour-split + smart chaining', short: 'Our method', source: 'Ours: Dijkstra + shortest-path split + local search + Bayesian chaining' }
  ];

  // ------------------------------------------------------------------ utils
  function extend(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in (b || {})) o[k] = b[k]; return o; }
  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(rng, mean) {
    var L = Math.exp(-mean), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  // ------------------------------------------------- 1. walking network (Dijkstra, Session 7)
  function buildNetwork(campus, opt) {
    opt = extend(DEFAULTS, opt);
    var nodes = [{ name: campus.depot.name, x: campus.depot.x, y: campus.depot.y, type: 'depot' }];
    var bIndex = {};
    campus.buildings.forEach(function (b) { bIndex[b.name] = nodes.length; nodes.push(extend(b, { type: 'building' })); });
    campus.waypoints.forEach(function (w) { nodes.push({ name: w.name, x: w.x, y: w.y, type: 'waypoint' }); });
    var N = nodes.length, adj = [], i, j;
    for (i = 0; i < N; i++) adj.push([]);
    function d(a, b) { return Math.sqrt(Math.pow(nodes[a].x - nodes[b].x, 2) + Math.pow(nodes[a].y - nodes[b].y, 2)); }
    var linked = {};
    function link(a, b) {
      var key = a < b ? a + '_' + b : b + '_' + a;
      if (linked[key] || a === b) return;
      linked[key] = 1;
      var w = d(a, b) * opt.detourFactor;
      adj[a].push([b, w]); adj[b].push([a, w]);
    }
    for (i = 0; i < N; i++) {
      var near = [];
      for (j = 0; j < N; j++) if (j !== i) near.push([d(i, j), j]);
      near.sort(function (p, q) { return p[0] - q[0]; });
      for (j = 0; j < near.length; j++) {
        if (j < opt.linkNearest || near[j][0] <= opt.linkRadius) link(i, near[j][1]);
      }
    }
    // Dijkstra from the depot and every building
    var P = 1 + campus.buildings.length;   // routable points: depot + buildings
    var W = [], pred = [];
    for (i = 0; i < P; i++) {
      var r = dijkstra(adj, i, N);
      W.push(r.dist.slice(0, P)); pred.push(r.pred);
    }
    return { nodes: nodes, adj: adj, W: W, pred: pred, P: P, bIndex: bIndex, edges: Object.keys(linked).length };
  }

  function dijkstra(adj, src, N) {
    var dist = new Array(N), pred = new Array(N), done = new Array(N), i;
    for (i = 0; i < N; i++) { dist[i] = Infinity; pred[i] = -1; done[i] = false; }
    dist[src] = 0;
    // binary heap
    var heap = [[0, src]];
    function push(item) {
      heap.push(item); var c = heap.length - 1;
      while (c > 0) { var p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; var t = heap[p]; heap[p] = heap[c]; heap[c] = t; c = p; }
    }
    function pop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; var c = 0;
        for (;;) {
          var l = 2 * c + 1, r = l + 1, m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break;
          var t = heap[m]; heap[m] = heap[c]; heap[c] = t; c = m;
        }
      }
      return top;
    }
    while (heap.length) {
      var it = pop(), u = it[1];
      if (done[u]) continue;
      done[u] = true;
      for (var k = 0; k < adj[u].length; k++) {
        var v = adj[u][k][0], nd = dist[u] + adj[u][k][1];
        if (nd < dist[v]) { dist[v] = nd; pred[v] = u; push([nd, v]); }
      }
    }
    return { dist: dist, pred: pred };
  }

  // polyline (node coordinates) of the walking path between two routable points
  function pathCoords(net, a, b) {
    var pts = [], v = b, guard = 0;
    while (v !== -1 && guard++ < 500) { pts.push([net.nodes[v].x, net.nodes[v].y]); if (v === a) break; v = net.pred[a][v]; }
    return pts.reverse();
  }

  // ------------------------------------------------- 2. orders and the cost matrix
  // order: { id, building, floor, pieces, room, name }
  function buildContext(net, orders, opt, planP) {
    opt = extend(DEFAULTS, opt);
    var n = orders.length, sp = opt.walkMPerMin, st = opt.stairMinPerFloor;
    var pt = new Int32Array(n), fl = new Float64Array(n), q = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      pt[i] = net.bIndex[orders[i].building];
      if (pt[i] === undefined) throw new Error('Unknown building ' + orders[i].building);
      fl[i] = orders[i].floor || 0;
      q[i] = Math.min(orders[i].pieces, opt.capacity);
    }
    // C[(a)*(n+1)+(b)] minutes; index 0 = van, i+1 = order i
    var M = n + 1, C = new Float64Array(M * M);
    for (var a = 0; a < M; a++) {
      for (var b = 0; b < M; b++) {
        if (a === b) continue;
        var v;
        if (a === 0) v = net.W[0][pt[b - 1]] / sp + st * fl[b - 1];
        else if (b === 0) v = net.W[pt[a - 1]][0] / sp + st * fl[a - 1];
        else if (pt[a - 1] === pt[b - 1]) v = st * Math.abs(fl[a - 1] - fl[b - 1]);
        else v = st * fl[a - 1] + net.W[pt[a - 1]][pt[b - 1]] / sp + st * fl[b - 1];
        C[a * M + b] = v;
      }
    }
    // planning loads: full (planP = 0) or expected after no-shows with variance
    planP = planP || 0;
    var mu = new Float64Array(n), va = new Float64Array(n);
    for (i = 0; i < n; i++) { mu[i] = q[i] * (1 - planP); va[i] = q[i] * q[i] * planP * (1 - planP); }
    return { n: n, M: M, C: C, pt: pt, fl: fl, q: q, mu: mu, va: va, cap: opt.capacity,
             z: planP > 0 ? opt.riskZ : 0, opt: opt, net: net, orders: orders };
  }

  function fits(ctx, m, v, i) {
    var mm = m + ctx.mu[i], vv = v + ctx.va[i];
    return mm + ctx.z * Math.sqrt(vv) <= ctx.cap + 1e-9;
  }
  function cst(ctx, a, b) { return ctx.C[a * ctx.M + b]; }   // a, b in 0..n (0 = van)

  // ------------------------------------------------- 3. construction heuristics
  function greedyBy(ctx, pick) {
    var n = ctx.n, left = new Uint8Array(n), cnt = n, trips = [];
    for (var i = 0; i < n; i++) left[i] = 1;
    while (cnt > 0) {
      var trip = [], m = 0, v = 0, cur = 0;
      for (;;) {
        var best = -1, bestKey = Infinity;
        for (var j = 0; j < n; j++) {
          if (!left[j] || !fits(ctx, m, v, j)) continue;
          var key = pick(cur, j);
          if (key < bestKey) { bestKey = key; best = j; }
        }
        if (best < 0) break;
        trip.push(best); left[best] = 0; cnt--; m += ctx.mu[best]; v += ctx.va[best]; cur = best + 1;
      }
      if (!trip.length) { // safety: an order larger than capacity rules
        for (j = 0; j < n; j++) if (left[j]) { trip.push(j); left[j] = 0; cnt--; break; }
      }
      trips.push(trip);
    }
    return trips;
  }
  function nearestFirst(ctx) { return greedyBy(ctx, function (cur, j) { return cst(ctx, cur, j + 1); }); }
  function smallestFirst(ctx) { return greedyBy(ctx, function (cur, j) { return ctx.q[j] * 1000 + cst(ctx, cur, j + 1); }); }

  function sweep(ctx) {
    var n = ctx.n, net = ctx.net, d0 = net.nodes[0], idx = [], i;
    for (i = 0; i < n; i++) idx.push(i);
    function ang(i) { var b = net.nodes[ctx.pt[i]]; return Math.atan2(b.y - d0.y, b.x - d0.x); }
    idx.sort(function (a, b) { return (ang(a) - ang(b)) || (ctx.pt[a] - ctx.pt[b]) || (ctx.fl[b] - ctx.fl[a]); });
    var trips = [], trip = [], m = 0, v = 0;
    idx.forEach(function (j) {
      if (trip.length && !fits(ctx, m, v, j)) { trips.push(trip); trip = []; m = 0; v = 0; }
      trip.push(j); m += ctx.mu[j]; v += ctx.va[j];
    });
    if (trip.length) trips.push(trip);
    // order each cluster by nearest neighbour before 2-opt
    return trips.map(function (t) {
      var left = t.slice(), seq = [], cur = 0;
      while (left.length) {
        var bi = 0;
        for (var k = 1; k < left.length; k++) if (cst(ctx, cur, left[k] + 1) < cst(ctx, cur, left[bi] + 1)) bi = k;
        cur = left[bi] + 1; seq.push(left[bi]); left.splice(bi, 1);
      }
      return seq;
    });
  }

  function clarkeWright(ctx) {
    var n = ctx.n, i, j, routeOf = new Int32Array(n), routes = {}, M = {}, V = {};
    for (i = 0; i < n; i++) { routeOf[i] = i; routes[i] = [i]; M[i] = ctx.mu[i]; V[i] = ctx.va[i]; }
    var cnt = n * (n - 1) / 2, S = new Float64Array(cnt), A = new Int32Array(cnt), B = new Int32Array(cnt), k = 0;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      S[k] = cst(ctx, 0, i + 1) + cst(ctx, 0, j + 1) - cst(ctx, i + 1, j + 1); A[k] = i; B[k] = j; k++;
    }
    var order = new Array(cnt);
    for (k = 0; k < cnt; k++) order[k] = k;
    order.sort(function (a, b) { return S[b] - S[a]; });
    for (var t = 0; t < cnt; t++) {
      k = order[t];
      if (S[k] <= 1e-9) break;
      i = A[k]; j = B[k];
      var ri = routeOf[i], rj = routeOf[j];
      if (ri === rj) continue;
      var mm = M[ri] + M[rj], vv = V[ri] + V[rj];
      if (mm + ctx.z * Math.sqrt(vv) > ctx.cap + 1e-9) continue;
      var Ri = routes[ri], Rj = routes[rj];
      if (Ri[Ri.length - 1] !== i) { if (Ri[0] === i) Ri = Ri.slice().reverse(); else continue; }
      if (Rj[0] !== j) { if (Rj[Rj.length - 1] === j) Rj = Rj.slice().reverse(); else continue; }
      var merged = Ri.concat(Rj);
      routes[ri] = merged; M[ri] = mm; V[ri] = vv;
      delete routes[rj]; delete M[rj]; delete V[rj];
      for (var c = 0; c < merged.length; c++) routeOf[merged[c]] = ri;
    }
    return Object.keys(routes).map(function (r) { return routes[r]; });
  }

  // Our heuristic, first version (FFB1, kept for the write-up): building-by-building
  //  1. Seed each trip at the building farthest from the van (Dijkstra metres) that
  //     still has orders: the long walks get full armloads.
  //  2. Take that building's orders top floor first while they fit.
  //  3. On the way back, add the building with the best bang-for-buck:
  //     (pieces gained) / (extra minutes of detour incl. stairs), as in the
  //     profit-tour rule of Session 9. Repeat until the armload is full.
  function farthestFirstBFB(ctx) {
    var n = ctx.n, net = ctx.net, sp = ctx.opt.walkMPerMin, st = ctx.opt.stairMinPerFloor;
    var left = new Uint8Array(n), cnt = n, i, byB = {};
    for (i = 0; i < n; i++) { left[i] = 1; (byB[ctx.pt[i]] = byB[ctx.pt[i]] || []).push(i); }
    Object.keys(byB).forEach(function (b) { byB[b].sort(function (a, c) { return ctx.fl[c] - ctx.fl[a] || ctx.q[c] - ctx.q[a]; }); });
    var bl = Object.keys(byB).map(Number);
    var trips = [];
    function take(b, m, v) {            // orders of building b that fit, top floor first
      var got = [], mm = m, vv = v, top = 0;
      byB[b].forEach(function (j) {
        if (!left[j]) return;
        if (mm + ctx.mu[j] + ctx.z * Math.sqrt(vv + ctx.va[j]) <= ctx.cap + 1e-9) {
          got.push(j); mm += ctx.mu[j]; vv += ctx.va[j]; if (ctx.fl[j] > top) top = ctx.fl[j];
        }
      });
      return { got: got, m: mm, v: vv, top: top };
    }
    while (cnt > 0) {
      var seed = -1, far = -1;
      bl.forEach(function (b) {
        var has = byB[b].some(function (j) { return left[j]; });
        if (has && net.W[0][b] > far) { far = net.W[0][b]; seed = b; }
      });
      var trip = [], m = 0, v = 0, r = take(seed, 0, 0);
      if (!r.got.length) { // single order above capacity: carry it alone
        var lone = byB[seed].filter(function (j) { return left[j]; })[0];
        r = { got: [lone], m: ctx.mu[lone], v: ctx.va[lone] };
      }
      r.got.forEach(function (j) { trip.push(j); left[j] = 0; cnt--; });
      m = r.m; v = r.v;
      var curB = seed;
      for (;;) {
        var best = null, bestRatio = -1;
        for (var t = 0; t < bl.length; t++) {
          var b = bl[t];
          var cand = take(b, m, v);
          if (!cand.got.length) continue;
          var gain = 0;
          cand.got.forEach(function (j) { gain += ctx.mu[j] + 1e-6; });
          var detour = b === curB ? 0 : (net.W[curB][b] + net.W[b][0] - net.W[curB][0]) / sp + 2 * st * cand.top;
          var ratio = gain / (Math.max(0, detour) + 0.5);
          if (ratio > bestRatio) { bestRatio = ratio; best = { b: b, c: cand }; }
        }
        if (!best) break;
        best.c.got.forEach(function (j) { trip.push(j); left[j] = 0; cnt--; });
        m = best.c.m; v = best.c.v; curB = best.b;
      }
      trips.push(trip);
    }
    return trips;
  }

  // Our heuristic, final version: Farthest-First Bang-for-buck with cheapest insertion
  //  1. Seed each trip with the remaining order that is farthest (walk + stairs) from the van.
  //  2. Repeatedly add the order with the highest bang-for-buck = pieces / extra minutes,
  //     where extra minutes = its cheapest insertion cost anywhere in the trip (Session 9's
  //     profit-tour rule, with "profit" = pieces collected).
  //  3. Stop when no remaining order fits the armload (or the risk-aware chance constraint).
  function farthestFirstInsertion(ctx) {
    var n = ctx.n, left = new Uint8Array(n), cnt = n, trips = [], i;
    for (i = 0; i < n; i++) left[i] = 1;
    while (cnt > 0) {
      var seed = -1, far = -1;
      for (i = 0; i < n; i++) if (left[i]) {
        var dd = cst(ctx, 0, i + 1) + 1e-6 * ctx.q[i];
        if (dd > far) { far = dd; seed = i; }
      }
      var trip = [seed], m = ctx.mu[seed], v = ctx.va[seed];
      left[seed] = 0; cnt--;
      for (;;) {
        var best = -1, bestRatio = -1, bestPos = 0;
        for (var j = 0; j < n; j++) {
          if (!left[j] || !fits(ctx, m, v, j)) continue;
          var minD = Infinity, pos = 0;
          for (var p = 0; p <= trip.length; p++) {
            var a = p === 0 ? 0 : trip[p - 1] + 1, b = p === trip.length ? 0 : trip[p] + 1;
            var d = cst(ctx, a, j + 1) + cst(ctx, j + 1, b) - cst(ctx, a, b);
            if (d < minD) { minD = d; pos = p; }
          }
          var ratio = (ctx.mu[j] + 1e-6) / (Math.max(0, minD) + 0.25);
          if (ratio > bestRatio) { bestRatio = ratio; best = j; bestPos = pos; }
        }
        if (best < 0) break;
        trip.splice(bestPos, 0, best); left[best] = 0; cnt--; m += ctx.mu[best]; v += ctx.va[best];
      }
      trips.push(trip);
    }
    return trips;
  }

  // Our algorithm (final): GTS = Giant Tour + Shortest-path Split
  //  1. One walking tour through every order from the van (nearest neighbour on the
  //     Dijkstra walking times, then 2-opt and Or-opt).
  //  2. Cut the tour into armload trips optimally. Node i = "first i orders of the tour
  //     are collected"; arc i->j = one trip carrying orders i+1..j (if they fit), cost =
  //     van -> those orders in tour order -> van. The cheapest path 0 -> n is the best
  //     set of cuts: a shortest-path problem on a DAG (Session 7's idea, solved by
  //     relaxing arcs in topological order, which is what Dijkstra does here).
  function giantTour(ctx) {
    var n = ctx.n, left = new Uint8Array(n), t = [], cur = 0, i, j;
    for (i = 0; i < n; i++) left[i] = 1;
    for (i = 0; i < n; i++) {
      var best = -1, bd = Infinity;
      for (j = 0; j < n; j++) if (left[j]) { var d = cst(ctx, cur, j + 1); if (d < bd) { bd = d; best = j; } }
      t.push(best); left[best] = 0; cur = best + 1;
    }
    // 2-opt on the closed tour van -> ... -> van
    var r = [0].concat(t.map(function (x) { return x + 1; })).concat([0]), improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (i = 1; i < r.length - 2; i++) for (j = i + 1; j < r.length - 1; j++) {
        var a = r[i - 1], b = r[i], c = r[j], e = r[j + 1];
        if (cst(ctx, a, c) + cst(ctx, b, e) < cst(ctx, a, b) + cst(ctx, c, e) - 1e-9) {
          var lo = i, hi = j;
          while (lo < hi) { var tmp = r[lo]; r[lo] = r[hi]; r[hi] = tmp; lo++; hi--; }
          improved = true;
        }
      }
      // Or-opt: move one order to a better place in the tour
      for (i = 1; i < r.length - 1; i++) {
        var x = r[i], p = r[i - 1], q2 = r[i + 1];
        var gainRemove = cst(ctx, p, x) + cst(ctx, x, q2) - cst(ctx, p, q2);
        var bestK = -1, bestAdd = gainRemove - 1e-9;
        for (var k = 0; k < r.length - 1; k++) {
          if (k === i || k === i - 1) continue;
          var add = cst(ctx, r[k], x) + cst(ctx, x, r[k + 1]) - cst(ctx, r[k], r[k + 1]);
          if (add < bestAdd) { bestAdd = add; bestK = k; }
        }
        if (bestK >= 0) {
          r.splice(i, 1);
          r.splice(bestK < i ? bestK + 1 : bestK, 0, x);
          improved = true;
        }
      }
    }
    return r.slice(1, -1).map(function (x) { return x - 1; });
  }

  function splitTour(ctx, t) {
    var n = t.length, V = new Float64Array(n + 1), P = new Int32Array(n + 1), i, j;
    for (i = 1; i <= n; i++) V[i] = Infinity;
    for (i = 0; i < n; i++) {
      if (V[i] === Infinity) continue;
      var m = 0, v = 0, cost = 0;
      for (j = i + 1; j <= n; j++) {
        var o = t[j - 1];
        if (j > i + 1 && !fits(ctx, m, v, o)) break;
        m += ctx.mu[o]; v += ctx.va[o];
        cost = j === i + 1 ? cst(ctx, 0, o + 1) : cost - cst(ctx, t[j - 2] + 1, 0) + cst(ctx, t[j - 2] + 1, o + 1);
        cost += cst(ctx, o + 1, 0);
        var val = V[i] + cost + ctx.opt.unloadMin;
        if (val < V[j]) { V[j] = val; P[j] = i; }
      }
    }
    var trips = [], k = n;
    while (k > 0) { trips.unshift(t.slice(P[k], k)); k = P[k]; }
    return trips;
  }
  function giantTourSplit(ctx) { return splitTour(ctx, giantTour(ctx)); }

  // Inter-trip local search (Session 9: "move node(s) from one route to another"):
  // relocate one order to another trip, or swap two orders between trips, whenever it
  // shortens the total walk and both armloads still fit.
  function tripCost(ctx, t) {
    if (!t.length) return 0;
    var s = cst(ctx, 0, t[0] + 1);
    for (var i = 1; i < t.length; i++) s += cst(ctx, t[i - 1] + 1, t[i] + 1);
    return s + cst(ctx, t[t.length - 1] + 1, 0) + ctx.opt.unloadMin;
  }
  function bestInsert(ctx, t, x) {
    var best = Infinity, pos = 0;
    for (var p = 0; p <= t.length; p++) {
      var a = p === 0 ? 0 : t[p - 1] + 1, b = p === t.length ? 0 : t[p] + 1;
      var d = cst(ctx, a, x + 1) + cst(ctx, x + 1, b) - cst(ctx, a, b);
      if (d < best) { best = d; pos = p; }
    }
    return { d: best, pos: pos };
  }
  function loadOf(ctx, t) { var m = 0, v = 0; t.forEach(function (j) { m += ctx.mu[j]; v += ctx.va[j]; }); return [m, v]; }
  function okLoad(ctx, mv) { return mv[0] + ctx.z * Math.sqrt(mv[1]) <= ctx.cap + 1e-9; }
  function interTripSearch(ctx, trips) {
    trips = trips.map(function (t) { return t.slice(); });
    var cost = trips.map(function (t) { return tripCost(ctx, t); });
    var improved = true, passes = 0;
    while (improved && passes++ < 30) {
      improved = false;
      // relocate
      for (var a = 0; a < trips.length; a++) {
        for (var i = 0; i < trips[a].length; i++) {
          var x = trips[a][i];
          var ta = trips[a].slice(0, i).concat(trips[a].slice(i + 1));
          var gain = cost[a] - tripCost(ctx, ta);
          var bestB = -1, bestD = gain - 1e-6, bestPos = 0;
          for (var b = 0; b < trips.length; b++) {
            if (b === a || !trips[b].length) continue;
            var l = loadOf(ctx, trips[b]); l[0] += ctx.mu[x]; l[1] += ctx.va[x];
            if (!okLoad(ctx, l)) continue;
            var ins = bestInsert(ctx, trips[b], x);
            if (ins.d < bestD) { bestD = ins.d; bestB = b; bestPos = ins.pos; }
          }
          if (bestB >= 0) {
            trips[bestB].splice(bestPos, 0, x); trips[a] = ta;
            cost[bestB] = tripCost(ctx, trips[bestB]); cost[a] = tripCost(ctx, ta);
            improved = true; i--;
          }
        }
      }
      // swap
      for (a = 0; a < trips.length; a++) for (var b2 = a + 1; b2 < trips.length; b2++) {
        for (i = 0; i < trips[a].length; i++) for (var j = 0; j < trips[b2].length; j++) {
          var ta2 = trips[a].slice(), tb2 = trips[b2].slice(), xa = ta2[i], xb = tb2[j];
          ta2.splice(i, 1); tb2.splice(j, 1);
          var la = loadOf(ctx, ta2), lb = loadOf(ctx, tb2);
          la[0] += ctx.mu[xb]; la[1] += ctx.va[xb]; lb[0] += ctx.mu[xa]; lb[1] += ctx.va[xa];
          if (!okLoad(ctx, la) || !okLoad(ctx, lb)) continue;
          var ia = bestInsert(ctx, ta2, xb), ib = bestInsert(ctx, tb2, xa);
          ta2.splice(ia.pos, 0, xb); tb2.splice(ib.pos, 0, xa);
          var ca = tripCost(ctx, ta2), cb = tripCost(ctx, tb2);
          if (ca + cb < cost[a] + cost[b2] - 1e-6) {
            trips[a] = ta2; trips[b2] = tb2; cost[a] = ca; cost[b2] = cb; improved = true;
          }
        }
      }
      trips = trips.filter(function (t) { return t.length; });
      cost = trips.map(function (t) { return tripCost(ctx, t); });
    }
    return trips;
  }
  function totalCost(ctx, trips) { return trips.reduce(function (s, t) { return s + tripCost(ctx, t); }, 0); }
  // join trips into one tour: trips ordered by the bearing of their centre from the van,
  // each turned the way that makes the link to the next trip shortest
  function concatTrips(ctx, trips) {
    var net = ctx.net, d0 = net.nodes[0];
    function bearing(t) {
      var sx = 0, sy = 0;
      t.forEach(function (j) { var b = net.nodes[ctx.pt[j]]; sx += b.x; sy += b.y; });
      return Math.atan2(sy / t.length - d0.y, sx / t.length - d0.x);
    }
    var ts = trips.slice().sort(function (a, b) { return bearing(a) - bearing(b); }), out = [], last = 0;
    ts.forEach(function (t) {
      var fw = cst(ctx, last, t[0] + 1), bw = cst(ctx, last, t[t.length - 1] + 1);
      var tt = bw < fw ? t.slice().reverse() : t;
      out = out.concat(tt); last = tt[tt.length - 1] + 1;
    });
    return out;
  }
  // GTS+ (our final method): best of two seeds, then split <-> local search until stable
  function gtsPlus(ctx) {
    var seeds = [giantTour(ctx), concatTrips(ctx, clarkeWright(ctx).map(function (t) { return twoOpt(ctx, t); }))];
    var best = null, bestC = Infinity;
    seeds.forEach(function (tour) {
      var trips = splitTour(ctx, tour), c = totalCost(ctx, trips);
      for (var round = 0; round < 4; round++) {
        trips = interTripSearch(ctx, trips).map(function (t) { return twoOpt(ctx, t); });
        var re = splitTour(ctx, concatTrips(ctx, trips)).map(function (t) { return twoOpt(ctx, t); });
        var c2 = Math.min(totalCost(ctx, trips), totalCost(ctx, re));
        if (totalCost(ctx, re) < totalCost(ctx, trips)) trips = re;
        if (c2 > c - 1e-6) { c = Math.min(c, c2); break; }
        c = c2;
      }
      c = totalCost(ctx, trips);
      if (c < bestC) { bestC = c; best = trips; }
    });
    return best;
  }

  // ------------------------------------------------- 4. improvement: 2-opt within each trip
  function tripLen(ctx, t) {
    if (!t.length) return 0;
    var s = cst(ctx, 0, t[0] + 1);
    for (var i = 1; i < t.length; i++) s += cst(ctx, t[i - 1] + 1, t[i] + 1);
    return s + cst(ctx, t[t.length - 1] + 1, 0);
  }
  function twoOpt(ctx, t) {
    var r = [0].concat(t.map(function (x) { return x + 1; })).concat([0]), improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (var i = 1; i < r.length - 2; i++) for (var j = i + 1; j < r.length - 1; j++) {
        var a = r[i - 1], b = r[i], c = r[j], d = r[j + 1];
        if (cst(ctx, a, c) + cst(ctx, b, d) < cst(ctx, a, b) + cst(ctx, c, d) - 1e-9) {
          var seg = r.slice(i, j + 1).reverse();
          for (var k = 0; k < seg.length; k++) r[i + k] = seg[k];
          improved = true;
        }
      }
    }
    return r.slice(1, -1).map(function (x) { return x - 1; });
  }

  // ------------------------------------------------- 5. plan = trips (+ 2-opt)
  function plan(net, orders, algoId, opt, planP) {
    var ctx = buildContext(net, orders, opt, planP || 0), trips;
    if (!orders.length) return { algo: algoId, trips: [], ctx: ctx, planP: planP || 0 };
    if (algoId === 'NN') trips = nearestFirst(ctx);
    else if (algoId === 'SF') trips = smallestFirst(ctx);
    else if (algoId === 'SWEEP') trips = sweep(ctx);
    else if (algoId === 'CW') trips = clarkeWright(ctx);
    else if (algoId === 'GTS') trips = giantTourSplit(ctx);
    else if (algoId === 'GTS+') trips = gtsPlus(ctx);
    else if (algoId === 'CW+LS') trips = interTripSearch(ctx, clarkeWright(ctx).map(function (t) { return twoOpt(ctx, t); }));
    else if (algoId === 'FFB') trips = farthestFirstInsertion(ctx);
    else if (algoId === 'FFB1') trips = farthestFirstBFB(ctx);
    else throw new Error('Unknown algorithm ' + algoId);
    trips = trips.filter(function (t) { return t.length; }).map(function (t) { return twoOpt(ctx, t); });
    return { algo: algoId, trips: trips, ctx: ctx, planP: planP || 0 };
  }

  // ------------------------------------------------- 6. executing a plan on the day
  // Morning: trips are given to team members by the Least-Utilised-Bin rule (Session 8)
  // on their PLANNED durations (everyone assumed in), and each person's trips are put in
  // bearing order so that consecutive trips are close to each other.
  // On the day: present[i] says who is in. A walker who meets an empty room knocks,
  // waits and moves on. If an armload would overflow (possible only with risk-aware
  // plans), they walk back to the van, unload, and return.
  // chain = 'none' : always walk back to the van after each trip.
  // chain = 'safe' : (our dynamic rule) if what they already carry plus the NEXT trip's
  //                  full ordered load still fits, go straight to the next trip.
  function plannedTripMinutes(ctx, t) {
    var o = ctx.opt, s = tripCost(ctx, t);
    t.forEach(function (j) { s += o.serviceMin + o.countSecPerPiece * ctx.q[j] / 60; });
    return s;
  }
  function assignTrips(pl, workers) {
    var ctx = pl.ctx, net = ctx.net, d0 = net.nodes[0];
    var planned = pl.trips.map(function (t) { return plannedTripMinutes(ctx, t); });
    var loads = [], lists = [], w;
    for (w = 0; w < workers; w++) { loads.push(0); lists.push([]); }
    planned.map(function (_, i) { return i; }).sort(function (a, b) { return planned[b] - planned[a]; })
      .forEach(function (ti) {
        var best = 0;
        for (var x = 1; x < workers; x++) if (loads[x] < loads[best]) best = x;
        loads[best] += planned[ti]; lists[best].push(ti);
      });
    function bearing(t) {
      var sx = 0, sy = 0;
      t.forEach(function (j) { var b = net.nodes[ctx.pt[j]]; sx += b.x; sy += b.y; });
      return Math.atan2(sy / t.length - d0.y, sx / t.length - d0.x);
    }
    lists.forEach(function (l) { l.sort(function (a, b) { return bearing(pl.trips[a]) - bearing(pl.trips[b]); }); });
    return { lists: lists, plannedLoads: loads, planned: planned };
  }
  // Expected extra minutes of carrying on into trip t with `load` already in hand,
  // versus walking back to the van first. Each student is in with probability 1 - p.
  // Exact dynamic programme over the armload (0..capacity): whenever the next present
  // student's clothes would not fit, the walker goes back to unload and returns.
  function expectedContinue(ctx, cur, load, t, p) {
    var cap = Math.round(ctx.cap), o = ctx.opt;
    var dist = {}; dist[Math.round(load)] = 1;
    var exp = cst(ctx, cur, t[0] + 1), prev = cur;
    for (var k = 0; k < t.length; k++) {
      var j = t[k], q = Math.round(ctx.q[j]), nd = {};
      if (k > 0) exp += cst(ctx, prev, j + 1);
      var extra = cst(ctx, prev, 0) + o.unloadMin + cst(ctx, 0, j + 1) - cst(ctx, prev, j + 1);
      Object.keys(dist).forEach(function (Ls) {
        var L = +Ls, pr = dist[Ls];
        nd[L] = (nd[L] || 0) + pr * p;                            // student out
        if (L + q <= cap) nd[L + q] = (nd[L + q] || 0) + pr * (1 - p);
        else { exp += pr * (1 - p) * extra; nd[q] = (nd[q] || 0) + pr * (1 - p); }
      });
      dist = nd; prev = j + 1;
    }
    var back = cst(ctx, cur, 0) + o.unloadMin + cst(ctx, 0, t[0] + 1);
    for (k = 1; k < t.length; k++) back += cst(ctx, t[k - 1] + 1, t[k] + 1);
    // trips planned on the full load never overflow when started empty
    return { cont: exp, back: back };
  }
  function execute(pl, present, k, chain, prior) {
    var ctx = pl.ctx, o = ctx.opt, workers = k || o.workers;
    chain = chain || 'none';
    var asg = assignTrips(pl, workers);
    var tot = { walk: 0, service: 0, wasted: 0, overflowReturns: 0, collected: 0, pieces: 0, noShows: 0, chained: 0 };
    var personMin = [], legs = [];
    asg.lists.forEach(function (list, w) {
      var time = 0, cur = 0, load = 0, steps = [], seen = 0, out = 0;
      list.forEach(function (ti, n) {
        var t = pl.trips[ti];
        t.forEach(function (j) {
          var leg = cst(ctx, cur, j + 1);
          if (present[j]) {
            if (load + ctx.q[j] > ctx.cap + 1e-9) {
              leg = cst(ctx, cur, 0) + o.unloadMin + cst(ctx, 0, j + 1); load = 0; tot.overflowReturns++;
              steps.push({ type: 'unload' });
            }
            load += ctx.q[j];
            var sv = o.serviceMin + o.countSecPerPiece * ctx.q[j] / 60;
            time += leg + sv; tot.walk += leg; tot.service += sv; tot.collected += ctx.q[j];
            steps.push({ type: 'pickup', order: j }); seen++;
          } else {
            time += leg + o.noShowWaitMin; tot.walk += leg; tot.wasted += o.noShowWaitMin; tot.noShows++;
            steps.push({ type: 'noshow', order: j }); seen++; out++;
          }
          tot.pieces += ctx.q[j];
          cur = j + 1;
        });
        var next = list[n + 1];
        var canChain = false;
        if (next !== undefined && chain === 'safe') {
          var nextLoad = 0; pl.trips[next].forEach(function (j) { nextLoad += ctx.q[j]; });
          canChain = load + nextLoad <= ctx.cap + 1e-9;
        } else if (next !== undefined && chain === 'smart') {
          var pNow = typeof prior === 'number' ? prior : posteriorNoShow(prior || [{ p: 0, w: 1 }], seen, out);
          var ev = expectedContinue(ctx, cur, load, pl.trips[next], pNow);
          canChain = ev.cont < ev.back - 1e-9;
        }
        if (canChain) { tot.chained++; steps.push({ type: 'chain' }); }
        else {
          var back = cst(ctx, cur, 0);
          time += back + o.unloadMin; tot.walk += back; cur = 0; load = 0;
          steps.push({ type: 'unload' });
        }
      });
      if (cur !== 0) { var b2 = cst(ctx, cur, 0); time += b2 + o.unloadMin; tot.walk += b2; steps.push({ type: 'unload' }); }
      personMin.push(time); legs.push(steps);
    });
    var work = personMin.reduce(function (s, x) { return s + x; }, 0);
    var makespan = pl.trips.length ? Math.max.apply(null, personMin) : 0;
    var day = o.setupMin + makespan;
    var ot = Math.max(0, day - o.shiftMin);
    var rate = o.teamRatePerHour / 60;
    var cost = rate * workers * day + rate * (o.overtimeMult - 1) * workers * ot;
    return {
      lists: asg.lists, steps: legs, personMin: personMin, workers: workers, chainMode: chain,
      workMin: work, walkMin: tot.walk, serviceMin: tot.service, wastedMin: tot.wasted,
      idleMin: workers * makespan - work, makespan: makespan, dayMin: day, overtimeMin: ot,
      overflowReturns: tot.overflowReturns, chained: tot.chained, trips: pl.trips.length,
      piecesCollected: tot.collected, piecesOrdered: tot.pieces, noShows: tot.noShows, cost: cost,
      costPerPiece: tot.collected ? cost / tot.collected : 0,
      revenueForgone: o.pricePerPiece * (tot.pieces - tot.collected)
    };
  }

  // ------------------------------------------------- 7. scenarios and Monte Carlo
  // One vendor's share of campus demand: each student orders about once a week and this
  // vendor serves about a third of campus -> about 60 pickups on a normal day.
  var SCENARIOS = [
    { id: 'S0', name: 'Base: normal day, everyone in', group: 'Base case', rate: 0.045, pieces: 12, p: 0.0, prob: 0.10 },
    { id: 'N10', name: 'No-shows: 10% out', group: 'No-show', rate: 0.045, pieces: 12, p: 0.10, prob: 0.30 },
    { id: 'N30', name: 'No-shows: 30% out', group: 'No-show', rate: 0.045, pieces: 12, p: 0.30, prob: 0.25 },
    { id: 'N50', name: 'No-shows: 50% out', group: 'No-show', rate: 0.045, pieces: 12, p: 0.50, prob: 0.10 },
    { id: 'DHI', name: 'Busy day: about 100 pickups, bigger bags', group: 'Demand variation', rate: 0.075, pieces: 14, p: 0.10, prob: 0.15 },
    { id: 'DLO', name: 'Quiet day: about 30 pickups', group: 'Demand variation', rate: 0.0225, pieces: 12, p: 0.10, prob: 0.10 }
  ];

  // Exactly n pickup requests from distinct rooms (for the request page's sample button).
  // Rooms are drawn without replacement; MSH flats are 1.5x as likely (families order more).
  function randomOrders(campus, n, seed, opt) {
    opt = extend(DEFAULTS, opt);
    var rng = mulberry32(seed * 104729 + 3), rooms = [];
    campus.buildings.forEach(function (b) {
      var perFloor = Math.ceil(b.rooms / b.floors), w = b.kind === 'msh' ? opt.mshOrderMultiplier : 1;
      for (var r = 0; r < b.rooms; r++) {
        var floor = Math.floor(r / perFloor);
        rooms.push({ key: Math.pow(rng(), 1 / w), building: b.name, floor: floor,
                     room: b.kind === 'msh' ? 'Flat ' + (r + 1) : ('00' + (floor * 100 + (r % perFloor) + 1)).slice(-3) });
      }
    });
    rooms.sort(function (a, b) { return b.key - a.key; });
    return rooms.slice(0, Math.min(n, rooms.length)).map(function (r, i) {
      var pcs = Math.max(3, Math.min(40, Math.min(opt.capacity, poisson(rng, 12))));
      return { id: 'R' + (i + 1), building: r.building, floor: r.floor, room: r.room, pieces: pcs, name: 'Student ' + (i + 1) };
    });
  }

  // Prior over today's no-show rate = the scenario probabilities, grouped by rate.
  function noShowPrior(scen) {
    var m = {};
    scen.forEach(function (x) { m[x.p] = (m[x.p] || 0) + x.prob; });
    var tot = 0; Object.keys(m).forEach(function (k) { tot += m[k]; });
    return Object.keys(m).map(function (k) { return { p: +k, w: m[k] / (tot || 1) }; });
  }
  // Posterior mean no-show rate after seeing `out` empty rooms in `seen` knocks (Bayes' rule).
  function posteriorNoShow(prior, seen, out) {
    var num = 0, den = 0;
    prior.forEach(function (h) {
      var like = Math.pow(h.p, out) * Math.pow(1 - h.p, seen - out);
      if (h.p === 0 && out > 0) like = 0;
      num += h.w * like * h.p; den += h.w * like;
    });
    return den > 0 ? num / den : 0;
  }
  function expectedNoShow(scen) {
    var s = 0, w = 0;
    scen.forEach(function (x) { s += x.prob * x.p; w += x.prob; });
    return w ? s / w : 0;
  }

  // One random day. The same seed gives the same students, pieces and absences
  // in every scenario and for every algorithm (common random numbers).
  function randomDay(campus, sc, seed, opt) {
    opt = extend(DEFAULTS, opt);
    var rng = mulberry32(seed * 7919 + 17), orders = [], present = [], id = 0;
    campus.buildings.forEach(function (b) {
      var perFloor = Math.ceil(b.rooms / b.floors);
      for (var r = 0; r < b.rooms; r++) {
        var uo = rng(), up = rng(), base = poisson(rng, 12), extra = rng();
        var rate = sc.rate * (b.kind === 'msh' ? opt.mshOrderMultiplier : 1);
        if (uo < rate) {
          var pcs = Math.round(base * sc.pieces / 12 + (extra - 0.5));
          pcs = Math.max(3, Math.min(40, Math.min(opt.capacity, pcs)));
          var floor = Math.floor(r / perFloor);
          orders.push({ id: 'R' + (++id), building: b.name, floor: floor,
                        room: b.kind === 'msh' ? 'Flat ' + (r + 1) : ('00' + (floor * 100 + (r % perFloor) + 1)).slice(-3),
                        pieces: pcs, name: 'Student ' + id });
          present.push(up >= sc.p);
        }
      }
    });
    return { orders: orders, present: present };
  }

  // ------------------------------------------------- 8. exact CVRP for small instances (validation)
  function exactSmall(ctx) {
    var n = ctx.n, N = 1 << n, INF = 1e18, m, i, j;
    var dp = new Float64Array(N * n); for (i = 0; i < N * n; i++) dp[i] = INF;
    for (i = 0; i < n; i++) dp[(1 << i) * n + i] = cst(ctx, 0, i + 1);
    for (m = 1; m < N; m++) for (i = 0; i < n; i++) {
      var val = dp[m * n + i]; if (val >= INF) continue;
      for (j = 0; j < n; j++) if (!(m & (1 << j))) {
        var m2 = m | (1 << j), c = val + cst(ctx, i + 1, j + 1);
        if (c < dp[m2 * n + j]) dp[m2 * n + j] = c;
      }
    }
    var tsp = new Float64Array(N), dem = new Float64Array(N);
    for (m = 1; m < N; m++) {
      var best = INF, d = 0;
      for (i = 0; i < n; i++) if (m & (1 << i)) { d += ctx.q[i]; var c2 = dp[m * n + i] + cst(ctx, i + 1, 0); if (c2 < best) best = c2; }
      tsp[m] = best; dem[m] = d;
    }
    var part = new Float64Array(N); for (m = 1; m < N; m++) part[m] = INF;
    for (m = 1; m < N; m++) {
      var low = m & -m;
      for (var sub = m; sub; sub = (sub - 1) & m) {
        if ((sub & low) && dem[sub] <= ctx.cap + 1e-9) { var cc = tsp[sub] + part[m ^ sub]; if (cc < part[m]) part[m] = cc; }
      }
    }
    return part[N - 1];
  }

  var API = {
    DEFAULTS: DEFAULTS, ALGOS: ALGOS, SCENARIOS: SCENARIOS,
    buildNetwork: buildNetwork, pathCoords: pathCoords, buildContext: buildContext,
    plan: plan, execute: execute, expectedContinue: expectedContinue, assignTrips: assignTrips,
    cost: cst, tripCost: tripCost, plannedTripMinutes: plannedTripMinutes, tripLen: tripLen, randomDay: randomDay,
    expectedNoShow: expectedNoShow, noShowPrior: noShowPrior, randomOrders: randomOrders,
    giantTour: giantTour, splitTour: splitTour, clarkeWright: clarkeWright, twoOpt: twoOpt, interTripSearch: interTripSearch,
    totalCost: totalCost, concatTrips: concatTrips, fits: fits, nearestFirst: nearestFirst, sweep: sweep, dijkstra: dijkstra, posteriorNoShow: posteriorNoShow, mulberry32: mulberry32, exactSmall: exactSmall, extend: extend
  };
  root.LaundryEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
