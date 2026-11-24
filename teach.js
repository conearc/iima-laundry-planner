/* "How the methods work" tab: step-by-step pictures of each method on a small example. */
(function () {
  'use strict';
  var E = window.LaundryEngine, UI = window.LaundryUI, R = window.RESULTS, net = UI.net;
  var cssVar = UI.cssVar, esc = UI.esc, fmt = UI.fmt;
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  var LET = 'ABCDEFGHIJKL';
  var FIXED = [
    ['D40', 2, '204', 18], ['D37', 1, '112', 15], ['D38', 3, '309', 20], ['D21', 0, '006', 12], ['D24', 2, '215', 22],
    ['D27', 1, '118', 16], ['D32', 3, '307', 14], ['MSH5', 1, 'Flat 3', 20], ['MSH12', 2, 'Flat 5', 18], ['D19', 1, '104', 10]
  ];
  var ex, ctx, method = 'DIJ', steps = [], idx = 0, timer = null, inited = false, dijTarget = 'MSH12';

  var META = {
    DIJ: { title: 'Walking distances: Dijkstra\'s shortest path', src: 'From class · Session 7 · every method uses it',
      how: ['Start at the van with distance 0; every other point is still unknown.',
            'Fix the closest point that is not fixed yet. Its distance is now final.',
            'From that point, check each neighbour: is it shorter to go through here? If yes, update the neighbour.',
            'Repeat until the target is fixed, then follow the links back to read the path.'] },
    NN: { title: 'Nearest-neighbour', src: 'From class · tour-building heuristic (Sessions 1–4)',
      how: ['Start at the van.', 'Go to the nearest pickup whose clothes still fit in your arms.',
            'When nothing else fits, walk back to the van, unload, and start a new trip.', 'Finally, untangle each trip with 2-opt.'] },
    SWEEP: { title: 'Sweep', src: 'From class · Session 9',
      how: ['Picture a clock hand turning around the van.', 'Take pickups in the order the hand passes them.',
            'When the next one won\'t fit, close the trip and start a new one.', 'Put the stops inside each trip in a sensible order, then 2-opt.'] },
    CW: { title: 'Clarke–Wright savings', src: 'From class · Sessions 8–9',
      how: ['Start with one trip per pickup: van → pickup → van.',
            'For every pair i, j: saving = (van→i) + (van→j) − (i→j). That is the walking saved by doing both in one trip.',
            'Go down the list from the biggest saving. Join the two trips if i and j are at the ends of their trips and the clothes fit.',
            'Finally, 2-opt each trip.'] },
    OURS: { title: 'Our method: tour-split + smart chaining', src: 'Known split idea (Beasley 1983, Prins 2004) + Clarke–Wright + our on-the-day rule',
      how: ['Make one long walk through every pickup: nearest-neighbour, then straightened with 2-opt and Or-opt.',
            'Cut that walk into armloads at the best places. This is a shortest-path problem.',
            'Also try Clarke–Wright\'s trips joined into one walk, cut the same way, and keep the better result.',
            'Move or swap pickups between trips while it saves time.',
            'On the day, after each trip: go back to the van or carry on, whichever is expected to be quicker.'] }
  };

  // ------------------------------------------------------------------ example
  function setExample(list) {
    ex = list.map(function (o, i) { return { id: 'X' + i, name: LET[i], building: o[0], floor: o[1], room: o[2], pieces: o[3] }; });
    ctx = E.buildContext(net, ex, { capacity: 60 }, 0);
  }
  function L(j) { return LET[j]; }
  function lab(j) { return '<b>' + L(j) + '</b> (' + ex[j].building + ', ' + ex[j].pieces + ' clothes)'; }
  function where(cur) { return cur === 0 ? 'the van' : '<b>' + L(cur - 1) + '</b>'; }
  function walkMin(ts) { return ts.reduce(function (s, t) { return s + E.tripLen(ctx, t); }, 0); }
  function load(t) { return t.reduce(function (s, j) { return s + ctx.q[j]; }, 0); }
  function copy(ts) { return ts.map(function (t) { return t.slice(); }); }

  // ------------------------------------------------------------------ map
  var minX = -32, maxX = 405, minY = 160, maxY = 378, VW = maxX - minX, VH = maxY - minY;
  function X(x) { return x - minX; } function Y(y) { return maxY - y; }
  function nodeXY(n) { return [net.nodes[n].x, net.nodes[n].y]; }
  function orderXY(j) {           // a badge next to its building; several orders in one building fan out
    var b = ctx.pt[j], same = [], k;
    for (k = 0; k < ctx.n; k++) if (ctx.pt[k] === b) same.push(k);
    var i = same.indexOf(j), p = nodeXY(b);
    return [p[0] + (i - (same.length - 1) / 2) * 11, p[1] + 13];
  }
  function walkPts(seq) {
    var pts = [];
    for (var i = 0; i < seq.length - 1; i++) { var seg = E.pathCoords(net, seq[i], seq[i + 1]); if (i > 0) seg = seg.slice(1); pts = pts.concat(seg); }
    return pts;
  }
  function tripSeq(t, closed) {
    var seq = [0];
    t.forEach(function (j) { var b = ctx.pt[j]; if (seq[seq.length - 1] !== b) seq.push(b); });
    if (closed !== false) seq.push(0);
    return seq;
  }
  function poly(pts, col, w, dash, op) {
    return '<polyline points="' + pts.map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ') + '" fill="none" stroke="' + col +
      '" stroke-width="' + (w || 2) + '" stroke-linejoin="round" stroke-linecap="round"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + ' opacity="' + (op || 0.9) + '"/>';
  }
  function line(a, b, col, w, dash, op) { return poly([a, b], col, w, dash, op); }
  function col(i) { return UI.workerColor(i); }

  function render(st) {
    var s = '<svg viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="Step-by-step example on the campus map">';
    s += '<polygon points="' + CAMPUS.outline.map(function (p) { return X(p[0]) + ',' + Y(p[1]); }).join(' ') + '" fill="' + cssVar('--map-campus') + '" stroke="' + cssVar('--map-line') + '" stroke-width="1.5"/>';
    var drawn = {};
    net.adj.forEach(function (lst, a) {
      lst.forEach(function (e) {
        var b = e[0], key = a < b ? a + '_' + b : b + '_' + a; if (drawn[key]) return; drawn[key] = 1;
        s += line(nodeXY(a), nodeXY(b), cssVar('--map-line'), 0.5, '2 2', st.dij ? 0.9 : 0.5);
      });
    });
    // --- Dijkstra layer
    if (st.dij) {
      var D = st.dij;
      D.tree.forEach(function (e) { s += line(nodeXY(e[0]), nodeXY(e[1]), cssVar('--s1'), 1.6, null, 0.8); });
      D.frontier.forEach(function (n) { s += '<circle cx="' + X(net.nodes[n].x) + '" cy="' + Y(net.nodes[n].y) + '" r="3" fill="none" stroke="' + cssVar('--s4') + '" stroke-width="1.4"/>'; });
      D.settled.forEach(function (n) { s += '<circle cx="' + X(net.nodes[n].x) + '" cy="' + Y(net.nodes[n].y) + '" r="2.6" fill="' + cssVar('--s1') + '"/>'; });
      if (D.cur !== undefined) s += '<circle cx="' + X(net.nodes[D.cur].x) + '" cy="' + Y(net.nodes[D.cur].y) + '" r="5" fill="none" stroke="' + cssVar('--s2') + '" stroke-width="2"/>';
      if (D.path) s += poly(D.path.map(nodeXY), cssVar('--s2'), 3.2, null, 0.95);
      var t = net.nodes[net.bIndex[dijTarget]];
      s += '<circle cx="' + X(t.x) + '" cy="' + Y(t.y) + '" r="7" fill="none" stroke="' + cssVar('--s2') + '" stroke-width="1.2" stroke-dasharray="2 2"/>';
    }
    var used = {}; ex.forEach(function (o) { used[o.building] = 1; });
    CAMPUS.buildings.forEach(function (b) {
      var msh = b.kind === 'msh', w = msh ? 10 : 18, h = msh ? 7 : 12;
      s += '<rect x="' + (X(b.x) - w / 2) + '" y="' + (Y(b.y) - h / 2) + '" width="' + w + '" height="' + h + '" rx="2" fill="' + cssVar(used[b.name] ? '--map-bld-on' : '--map-bld') +
        '" stroke="' + cssVar('--map-line') + '" stroke-width="0.8" opacity="' + (st.dij ? 0.7 : used[b.name] ? 1 : 0.55) + '"/>' +
        '<text x="' + X(b.x) + '" y="' + (Y(b.y) + 2.6) + '" font-size="' + (msh ? 5 : 6.5) + '" text-anchor="middle" fill="' + cssVar('--ink2') + '">' + (msh ? b.name.replace('MSH', 'M') : b.name) + '</text>';
    });
    // --- sweep rays
    (st.rays || []).forEach(function (r) {
      var p = orderXY(r.j), v = nodeXY(0);
      s += line(v, p, r.color || cssVar('--muted'), r.bold ? 1.6 : 0.8, r.bold ? null : '3 3', 0.9);
    });
    // --- star (one trip per pickup)
    (st.star || []).forEach(function (j) { s += poly(walkPts(tripSeq([j])), cssVar('--muted'), 1.1, '3 3', 0.7); });
    // --- tour (one long walk)
    if (st.tour) s += poly(walkPts(tripSeq(st.tour, true)), cssVar('--ink2'), 1.8, '5 3', 0.8);
    // --- trips
    (st.trips || []).forEach(function (t, i) { if (t.length) s += poly(walkPts(tripSeq(t, true)), col(st.colorOf ? st.colorOf[i] : i), 2.4, null, 0.9); });
    (st.open || []).forEach(function (o) { if (o.orders.length) s += poly(walkPts(tripSeq(o.orders, false)), col(o.color), 2.4, null, 0.9); });
    // --- candidates and pick
    if (st.cands) {
      var from = st.from === 0 ? nodeXY(0) : orderXY(st.from - 1);
      st.cands.forEach(function (j) { s += line(from, orderXY(j), cssVar('--muted'), 0.9, '2 3', 0.9); });
      if (st.pick !== undefined && st.pick >= 0) s += line(from, orderXY(st.pick), cssVar('--s2'), 2.6, null, 1);
    }
    if (st.pair) s += line(orderXY(st.pair[0]), orderXY(st.pair[1]), cssVar(st.pairOk ? '--s3' : '--s8'), 2.6, '4 2', 1);
    // --- van
    var v = nodeXY(0);
    s += '<rect x="' + (X(v[0]) - 13) + '" y="' + (Y(v[1]) - 6) + '" width="26" height="12" rx="3" fill="' + cssVar('--ink') + '"/><text x="' + X(v[0]) + '" y="' + (Y(v[1]) + 3) +
      '" font-size="7" font-weight="700" text-anchor="middle" fill="' + cssVar('--surface') + '">VAN</text>';
    // --- pickup badges
    if (!st.dij) ex.forEach(function (o, j) {
      var p = orderXY(j), c = st.badge && st.badge[j] !== undefined ? col(st.badge[j]) : cssVar('--ink2');
      var hl = (st.pick === j) || (st.pair && st.pair.indexOf(j) >= 0);
      s += '<circle cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="' + (hl ? 6.4 : 5.4) + '" fill="' + c + '" stroke="' + cssVar('--surface') + '" stroke-width="1.2"/>' +
        '<text x="' + X(p[0]) + '" y="' + (Y(p[1]) + 2.4) + '" font-size="6.5" font-weight="700" text-anchor="middle" fill="#fff">' + L(j) + '</text>';
      if (st.order && st.order[j] !== undefined) s += '<text x="' + (X(p[0]) + 7) + '" y="' + (Y(p[1]) - 5) + '" font-size="6" font-weight="700" fill="' + cssVar('--ink') + '">' + st.order[j] + '</text>';
    });
    $('#learnMap').innerHTML = s + '</svg>';
  }

  // ------------------------------------------------------------------ traces
  function badgeFrom(trips) { var b = {}; trips.forEach(function (t, i) { t.forEach(function (j) { b[j] = i; }); }); return b; }

  function traceDij() {
    var adj = net.adj, N = net.nodes.length, dist = [], pred = [], done = [], i, out = [];
    for (i = 0; i < N; i++) { dist.push(Infinity); pred.push(-1); done.push(false); }
    dist[0] = 0;
    var target = net.bIndex[dijTarget], settled = [], tree = [];
    function nm(n) { var t = net.nodes[n]; return t.type === 'depot' ? 'the van' : t.type === 'waypoint' ? 'path point ' + t.name.replace('W', '') : t.name; }
    out.push({ dij: { settled: [], tree: [], frontier: [0] }, text: 'Find the shortest walk from the van to <b>' + dijTarget + '</b>. The van starts at 0 m; everything else is unknown (∞). Dashed grey lines are the footpaths.' });
    for (;;) {
      var u = -1, best = Infinity;
      for (i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = true; settled.push(u); if (pred[u] >= 0) tree.push([pred[u], u]);
      var upd = [];
      adj[u].forEach(function (e) {
        var v = e[0], nd = dist[u] + e[1];
        if (!done[v] && nd < dist[v] - 1e-9) { dist[v] = nd; pred[v] = u; upd.push(v); }
      });
      var frontier = []; for (i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity) frontier.push(i);
      var text = 'Closest unfixed point: <b>' + nm(u) + '</b> at <b>' + fmt(dist[u]) + ' m</b>' + (pred[u] >= 0 ? ' (reached from ' + nm(pred[u]) + ')' : '') +
        '. Fix it. ' + (upd.length ? 'Updated ' + upd.length + ' neighbour' + (upd.length > 1 ? 's' : '') + ' (orange rings) with shorter distances.' : 'No neighbour gets shorter.');
      if (u === target) {
        var path = [], v2 = u; while (v2 >= 0) { path.unshift(v2); v2 = pred[v2]; }
        out.push({ dij: { settled: settled.slice(), tree: tree.slice(), frontier: frontier, cur: u, path: path },
          text: '<b>' + dijTarget + '</b> is fixed: the shortest walk is <b>' + fmt(dist[u]) + ' m</b>, about <b>' + fmt(dist[u] / 60, 1) + ' min</b> (orange). ' +
            'The app does this from every block, so all methods know the true walking time between any two places, not the straight-line distance.' });
        break;
      }
      out.push({ dij: { settled: settled.slice(), tree: tree.slice(), frontier: frontier, cur: u }, text: text });
    }
    return out;
  }

  function traceNN() {
    var n = ctx.n, left = [], cnt = n, trips = [], out = [], j;
    for (j = 0; j < n; j++) left.push(true);
    out.push({ trips: [], text: 'Ten pickups (A–J) are waiting; the numbers below are each one\'s clothes. Arms hold 60 clothes. Start at the van with empty arms.' });
    while (cnt) {
      var trip = [], ld = 0, cur = 0;
      for (;;) {
        var cands = [], best = -1, bd = Infinity;
        for (j = 0; j < n; j++) if (left[j] && ld + ctx.q[j] <= ctx.cap) { cands.push(j); var d = E.cost(ctx, cur, j + 1); if (d < bd) { bd = d; best = j; } }
        if (best < 0) break;
        out.push({ trips: copy(trips), open: [{ orders: trip.slice(), color: trips.length }], from: cur, cands: cands, pick: best, badge: Object.assign(badgeFrom(trips), (function () { var b = {}; trip.forEach(function (x) { b[x] = trips.length; }); return b; })()),
          text: 'From ' + where(cur) + ', the nearest pickup that still fits is ' + lab(best) + ', ' + fmt(bd, 1) + ' min away. Arms: ' + ld + ' → <b>' + (ld + ctx.q[best]) + '</b> of 60.' });
        trip.push(best); left[best] = false; cnt--; ld += ctx.q[best]; cur = best + 1;
      }
      trips.push(trip);
      var rest = []; for (j = 0; j < n; j++) if (left[j]) rest.push(j);
      out.push({ trips: copy(trips), badge: badgeFrom(trips), text: rest.length ?
        'Nothing left fits: the smallest remaining pickup has ' + Math.min.apply(null, rest.map(function (x) { return ctx.q[x]; })) + ' clothes and only ' + (60 - ld) +
          ' more fit. Walk back to the van and unload. <b>Trip ' + trips.length + '</b>: ' + trip.map(L).join(' → ') + ', ' + ld + ' clothes.'
        : 'All collected. <b>Trip ' + trips.length + '</b>: ' + trip.map(L).join(' → ') + '.' });
    }
    var fin = trips.map(function (t) { return E.twoOpt(ctx, t); });
    out.push({ trips: fin, badge: badgeFrom(fin), text: 'Finally, 2-opt untangles each trip. Result: <b>' + fin.length + ' trips, ' + fmt(walkMin(fin), 1) + ' min</b> of walking and stairs. ' +
      'Quick and simple, but each choice only looks one step ahead, so later trips are left with scattered leftovers.' });
    return out;
  }

  function traceSweep() {
    var n = ctx.n, d0 = net.nodes[0], idx = [], i, out = [];
    for (i = 0; i < n; i++) idx.push(i);
    function ang(j) { var b = net.nodes[ctx.pt[j]]; return Math.atan2(b.y - d0.y, b.x - d0.x); }
    idx.sort(function (a, b) { return (ang(a) - ang(b)) || (ctx.pt[a] - ctx.pt[b]) || (ctx.fl[b] - ctx.fl[a]); });
    var order = {}; idx.forEach(function (j, k) { order[j] = k + 1; });
    out.push({ rays: idx.map(function (j) { return { j: j }; }), order: order, text: 'A clock hand turns around the van, starting from the south. The small numbers show the order in which it meets the pickups.' });
    var trips = [], trip = [], ld = 0;
    idx.forEach(function (j, k) {
      var close = trip.length && ld + ctx.q[j] > ctx.cap, msg = '';
      if (close) { trips.push(trip); msg = '<b>' + L(j) + '</b> would make ' + (ld + ctx.q[j]) + ' > 60, so close <b>trip ' + trips.length + '</b> (' + trip.map(L).join(', ') + ', ' + ld + ' clothes) and start a new one. '; trip = []; ld = 0; }
      trip.push(j); ld += ctx.q[j];
      var all = trips.concat([trip]), b = badgeFrom(all);
      out.push({ rays: idx.map(function (x) { return { j: x, color: b[x] !== undefined ? col(b[x]) : null, bold: b[x] !== undefined }; }), order: order, badge: b, pick: j,
        text: msg + 'Hand reaches ' + lab(j) + ': add it to <b>trip ' + (trips.length + 1) + '</b>. Arms: <b>' + ld + '</b> of 60.' });
    });
    trips.push(trip);
    var fin = E.sweep(ctx).map(function (t) { return E.twoOpt(ctx, t); });
    out.push({ trips: fin, badge: badgeFrom(fin), text: 'Each group gets a sensible order inside, then 2-opt. Result: <b>' + fin.length + ' trips, ' + fmt(walkMin(fin), 1) + ' min</b>. ' +
      'Sweep is good when stops surround the depot. Our van sits in a corner, so slices of the "clock" mix near and far blocks.' });
    return out;
  }

  var cwTable = [];
  function traceCW() {
    var n = ctx.n, i, j, out = [], sav = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) sav.push({ i: i, j: j, s: E.cost(ctx, 0, i + 1) + E.cost(ctx, 0, j + 1) - E.cost(ctx, i + 1, j + 1) });
    sav.sort(function (a, b) { return b.s - a.s; });
    cwTable = sav;
    var routeOf = [], routes = {}, ld = {};
    for (i = 0; i < n; i++) { routeOf.push(i); routes[i] = [i]; ld[i] = ctx.q[i]; }
    function state(extra) {
      var keys = Object.keys(routes), multi = [], singles = [], colorOf = [];
      keys.forEach(function (k) { if (routes[k].length > 1) { multi.push(routes[k].slice()); colorOf.push(multi.length - 1); } else singles.push(routes[k][0]); });
      var b = {}; multi.forEach(function (t, q) { t.forEach(function (x) { b[x] = colorOf[q] % 8; }); });
      return Object.assign({ trips: multi, colorOf: colorOf.map(function (c) { return c % 8; }), star: singles, badge: b }, extra);
    }
    out.push(state({ text: 'Start with one trip per pickup (dashed): van → pickup → van. That is ' + n + ' trips, ' + fmt(walkMin(Object.keys(routes).map(function (k) { return routes[k]; })), 1) + ' min. The table on the right lists the savings, biggest first.', row: -1 }));
    var skipped = [];
    sav.forEach(function (p, r) {
      if (p.s <= 1e-9) return;
      i = p.i; j = p.j;
      var ri = routeOf[i], rj = routeOf[j], why = '';
      if (ri === rj) why = 'already in the same trip';
      else if (ld[ri] + ld[rj] > ctx.cap) why = 'clothes would be ' + (ld[ri] + ld[rj]) + ' > 60';
      else {
        var Ri = routes[ri], Rj = routes[rj];
        if (Ri[Ri.length - 1] !== i) { if (Ri[0] === i) Ri = Ri.slice().reverse(); else why = L(i) + ' is in the middle of its trip'; }
        if (!why && Rj[0] !== j) { if (Rj[Rj.length - 1] === j) Rj = Rj.slice().reverse(); else why = L(j) + ' is in the middle of its trip'; }
        if (!why) {
          var merged = Ri.concat(Rj), pre = skipped.length ? 'Skipped ' + skipped.length + ' pair' + (skipped.length > 1 ? 's' : '') + ' (' + skipped.slice(0, 3).join('; ') + (skipped.length > 3 ? '; …' : '') + '). ' : '';
          routes[ri] = merged; ld[ri] += ld[rj]; delete routes[rj]; delete ld[rj];
          merged.forEach(function (x) { routeOf[x] = ri; });
          out.push(state({ pair: [i, j], pairOk: true, row: r, text: pre + 'Saving ' + L(i) + '–' + L(j) + ' = <b>' + fmt(p.s, 1) + ' min</b>. Join the two trips: ' + merged.map(L).join(' → ') +
            ', ' + ld[ri] + ' of 60 clothes.' }));
          skipped = [];
          return;
        }
      }
      skipped.push(L(i) + '–' + L(j) + ': ' + why);
    });
    var fin = E.clarkeWright(ctx).map(function (t) { return E.twoOpt(ctx, t); });
    out.push({ trips: fin, badge: badgeFrom(fin), row: -1, text: 'No more useful joins. After 2-opt: <b>' + fin.length + ' trips, ' + fmt(walkMin(fin), 1) + ' min</b>. ' +
      'Savings look at pairs, not single steps, so far pickups get grouped well. That is why Clarke–Wright beats the greedy rules.' });
    return out;
  }

  var dagTour = null, finalPlan = null;
  function traceOurs() {
    var n = ctx.n, out = [], j;
    // 1a: nearest-neighbour long walk
    var left = [], t = [], cur = 0;
    for (j = 0; j < n; j++) left.push(true);
    for (var k = 0; k < n; k++) { var b = -1, bd = Infinity; for (j = 0; j < n; j++) if (left[j]) { var d = E.cost(ctx, cur, j + 1); if (d < bd) { bd = d; b = j; } } t.push(b); left[b] = false; cur = b + 1; }
    function ordMap(tt) { var o = {}; tt.forEach(function (x, q) { o[x] = q + 1; }); return o; }
    function tourLen(tt) { return E.tripLen(ctx, tt); }
    out.push({ tour: t, order: ordMap(t), text: '<b>Step 1.</b> Ignore arm space for now and make one long walk through all 10 pickups, always going to the nearest next one (dashed). Length: ' + fmt(tourLen(t), 1) + ' min.' });
    var g = E.giantTour(ctx);
    out.push({ tour: g, order: ordMap(g), text: '<b>Step 1, continued.</b> Straighten the walk with 2-opt (swap two links) and Or-opt (move one stop). Length now: ' + fmt(tourLen(g), 1) + ' min. The small numbers are the visiting order.' });
    // 2: split
    var s1 = E.splitTour(ctx, g);
    dagTour = g;
    out.push({ trips: s1, badge: badgeFrom(s1), order: ordMap(g), dag: g, text: '<b>Step 2.</b> Now cut the long walk into armloads. Every way of cutting is a path in the diagram below the map. The <b>cheapest path</b> (a shortest-path problem, like Dijkstra) gives ' +
      s1.length + ' trips, ' + fmt(walkMin(s1), 1) + ' min of walking and stairs (plus 1 min of unloading per trip in the diagram).' });
    // 3: CW seed
    var cwT = E.concatTrips(ctx, E.clarkeWright(ctx).map(function (x) { return E.twoOpt(ctx, x); }));
    var s2 = E.splitTour(ctx, cwT), better = walkMin(s2) < walkMin(s1) - 1e-9;
    out.push({ trips: better ? s2 : s1, badge: badgeFrom(better ? s2 : s1), tour: cwT, dag: better ? cwT : g, text: '<b>Step 3.</b> Also take Clarke–Wright\'s trips, join them into one long walk (dashed) and cut it the same way: ' + fmt(walkMin(s2), 1) + ' min. ' +
      (better ? 'That is better, so we keep it.' : 'Not better than step 2, so we keep step 2\'s trips.') + ' Because the cut can always copy Clarke–Wright\'s own trips, our method never does worse than Clarke–Wright.' });
    if (better) dagTour = cwT;
    // 4: local search
    var pl = E.plan(net, ex, 'GTS+', { capacity: 60 }, 0), fin = pl.trips;
    finalPlan = pl;
    var before = Math.min(walkMin(s1), walkMin(s2));
    out.push({ trips: fin, badge: badgeFrom(fin), dag: dagTour, text: '<b>Step 4.</b> Try moving one pickup to another trip, or swapping two pickups between trips, whenever both armloads still fit and the walk gets shorter. ' +
      (walkMin(fin) < before - 0.05 ? 'This saves ' + fmt(before - walkMin(fin), 1) + ' min.' : 'Here no move helps: the trips are already tight.') + ' Final plan: <b>' + fin.length + ' trips, ' + fmt(walkMin(fin), 1) + ' min</b>.' });
    out.push({ trips: fin, badge: badgeFrom(fin), dag: dagTour, calc: true, text: '<b>Step 5, on the day.</b> Students are sometimes out, so arms come back lighter than planned. After each trip the app compares two options: walk back to the van, or carry on straight to the next trip. ' +
      'Try it with the calculator below the map.' });
    return out;
  }

  // ------------------------------------------------------------------ side panels
  function renderSide(st) {
    var side = $('#learnSide'), html = '';
    if (method === 'CW') {
      var rows = cwTable.slice(0, 12).map(function (p, r) {
        return '<tr class="' + (r === st.row ? 'best' : '') + '"><td>' + L(p.i) + '–' + L(p.j) + '</td><td class="num">' + fmt(E.cost(ctx, 0, p.i + 1), 1) + ' + ' + fmt(E.cost(ctx, 0, p.j + 1), 1) +
          ' − ' + fmt(E.cost(ctx, p.i + 1, p.j + 1), 1) + '</td><td class="num"><b>' + fmt(p.s, 1) + '</b></td></tr>';
      }).join('');
      html = '<h3>Savings list (top 12, minutes)</h3><div class="tablewrap"><table class="data"><thead><tr><th>Pair</th><th class="num">van→i + van→j − i→j</th><th class="num">Saving</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    } else if (method === 'NN' || method === 'SWEEP') {
      html = '<h3>The example</h3><div class="tablewrap"><table class="data"><thead><tr><th></th><th>Block</th><th>Floor</th><th class="num">Clothes</th><th class="num">From van (min)</th></tr></thead><tbody>' +
        ex.map(function (o, j) { return '<tr><td><b>' + L(j) + '</b></td><td>' + o.building + '</td><td>' + UI.floorName(o.floor) + '</td><td class="num">' + o.pieces + '</td><td class="num">' + fmt(E.cost(ctx, 0, j + 1), 1) + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    } else if (method === 'DIJ') {
      html = '<p class="small">Blue dots: fixed points (final distance known). Blue lines: the shortest-path tree so far. Orange rings: points with a tentative distance, waiting to be fixed.</p>';
    }
    side.innerHTML = html;
    $('#learnOurs').classList.toggle('hidden', method !== 'OURS');
    if (method === 'OURS') { drawDag(st.dag || null); calc(); }
  }

  // shortest-path split diagram
  function drawDag(t) {
    var host = $('#dagWrap');
    if (!t) { host.innerHTML = '<p class="small muted">Appears at step 2.</p>'; return; }
    var n = t.length, W = 640, base = 200, padX = 26, gap = (W - 2 * padX) / n, arcs = [], V = [0], P = [0], i, j;
    for (i = 1; i <= n; i++) { V.push(Infinity); P.push(0); }
    for (i = 0; i < n; i++) {
      var ld = 0, cost = 0;
      for (j = i + 1; j <= n; j++) {
        var o = t[j - 1]; ld += ctx.q[o]; if (ld > ctx.cap) break;
        cost = j === i + 1 ? E.cost(ctx, 0, o + 1) : cost - E.cost(ctx, t[j - 2] + 1, 0) + E.cost(ctx, t[j - 2] + 1, o + 1);
        cost += E.cost(ctx, o + 1, 0);
        var c = cost + ctx.opt.unloadMin;
        arcs.push({ i: i, j: j, c: c });
        if (V[i] + c < V[j]) { V[j] = V[i] + c; P[j] = i; }
      }
    }
    var best = {}, k = n, cuts = [];
    while (k > 0) { best[P[k] + '_' + k] = 1; cuts.unshift([P[k], k]); k = P[k]; }
    function xx(q) { return padX + q * gap; }
    var s = '<svg viewBox="0 0 ' + W + ' ' + (base + 40) + '" role="img" aria-label="Shortest-path split diagram">';
    arcs.forEach(function (a) {
      var h = 14 + 26 * (a.j - a.i), mx = (xx(a.i) + xx(a.j)) / 2, isB = best[a.i + '_' + a.j];
      if (isB) return;
      s += '<path d="M' + xx(a.i) + ',' + base + ' Q' + mx + ',' + (base - 2 * h) + ' ' + xx(a.j) + ',' + base + '" fill="none" stroke="' + cssVar('--map-line') + '" stroke-width="1"/>';
    });
    cuts.forEach(function (cpair, q) {
      var a = arcs.filter(function (z) { return z.i === cpair[0] && z.j === cpair[1]; })[0], h = 14 + 26 * (a.j - a.i), mx = (xx(a.i) + xx(a.j)) / 2;
      s += '<path d="M' + xx(a.i) + ',' + base + ' Q' + mx + ',' + (base - 2 * h) + ' ' + xx(a.j) + ',' + base + '" fill="none" stroke="' + col(q) + '" stroke-width="3"/>' +
        '<text x="' + mx + '" y="' + (base - h - 4) + '" font-size="12" font-weight="700" text-anchor="middle" fill="' + cssVar('--ink') + '">' + fmt(a.c, 1) + ' min</text>';
    });
    for (i = 0; i <= n; i++) {
      s += '<circle cx="' + xx(i) + '" cy="' + base + '" r="5" fill="' + cssVar('--ink') + '"/><text x="' + xx(i) + '" y="' + (base + 16) + '" font-size="11" text-anchor="middle" fill="' + cssVar('--ink2') + '">' + i + '</text>';
      if (i > 0) s += '<text x="' + (xx(i) - gap / 2) + '" y="' + (base + 32) + '" font-size="12" font-weight="700" text-anchor="middle" fill="' + cssVar('--ink') + '">' + L(t[i - 1]) + '</text>';
    }
    s += '</svg>';
    host.innerHTML = s + '<p class="small">Letters under the line are the pickups in tour order. ' + arcs.length + ' possible trips (arcs); the cheapest path from 0 to ' + n + ' totals <b>' + fmt(V[n], 1) + ' min</b> (including 1 min of unloading per trip).</p>';
  }

  // go-back-or-carry-on calculator (Bayes + expected minutes)
  function calc() {
    if (!finalPlan) return;
    var seen = +$('#cSeen').value, outEl = $('#cOut');
    outEl.max = seen; if (+outEl.value > seen) outEl.value = seen;
    var out = +outEl.value, ld = +$('#cLoad').value;
    $('#cSeenV').textContent = seen; $('#cOutV').textContent = out; $('#cLoadV').textContent = ld;
    var pr = UI.prior(), post = pr.map(function (h) {
      var like = Math.pow(h.p, out) * Math.pow(1 - h.p, seen - out); if (h.p === 0 && out > 0) like = 0; return h.w * like;
    }), tot = post.reduce(function (a, b) { return a + b; }, 0) || 1;
    post = post.map(function (x) { return x / tot; });
    var pHat = pr.reduce(function (s, h, i) { return s + post[i] * h.p; }, 0);
    var asg = E.assignTrips(finalPlan, 1), list = asg.lists[0];
    if (list.length < 2) { $('#calcOut').innerHTML = '<p class="small">This example has only one trip.</p>'; return; }
    var tA = finalPlan.trips[list[0]], tB = finalPlan.trips[list[1]], cur = tA[tA.length - 1] + 1;
    var ev = E.expectedContinue(ctx, cur, ld, tB, pHat), go = ev.cont < ev.back - 1e-9, mx = Math.max(ev.back, ev.cont);
    function bar(label, v, c) { return '<div class="cbar"><span>' + label + '</span><div class="track"><div style="width:' + (100 * v / mx).toFixed(1) + '%;background:' + c + '"></div></div><b>' + fmt(v, 1) + ' min</b></div>'; }
    var hyp = pr.map(function (h, i) {
      return '<div class="cbar"><span>' + Math.round(100 * h.p) + '% out</span><div class="track two"><div style="width:' + (100 * h.w).toFixed(1) + '%;background:' + cssVar('--map-line') + '"></div><div style="width:' + (100 * post[i]).toFixed(1) + '%;background:' + cssVar('--s1') + '"></div></div><b>' + fmt(100 * post[i]) + '%</b></div>';
    }).join('');
    $('#calcOut').innerHTML =
      '<p class="small"><b>What kind of day is it?</b> Grey = belief before any knock (the case probabilities); blue = after ' + seen + ' knocks with ' + out + ' empty. Expected share out now: <b>' + fmt(100 * pHat) + '%</b>.</p>' + hyp +
      '<p class="small" style="margin-top:10px"><b>End of trip 1 (' + tA.map(L).join(', ') + ').</b> Next trip: ' + tB.map(L).join(', ') + ' (' + load(tB) + ' clothes ordered). Expected minutes to finish trip 2:</p>' +
      bar('Walk back first', ev.back, cssVar('--s1')) + bar('Carry on now', ev.cont, cssVar('--s2')) +
      '<div class="verdict ' + (go ? 'go' : 'back') + '">' + (go ? 'Carry on: saves about ' + fmt(ev.back - ev.cont, 1) + ' min on average.' : 'Walk back to the van: carrying on would cost about ' + fmt(ev.cont - ev.back, 1) + ' min more on average.') + '</div>' +
      '<p class="small">"Carry on" includes the risk that arms fill up mid-trip and you must walk back anyway. It is worked out exactly over every possible armload.</p>';
  }
  ['#cSeen', '#cOut', '#cLoad'].forEach(function (id) { $(id).addEventListener('input', calc); });

  // ------------------------------------------------------------------ player
  function build() {
    stop();
    steps = method === 'DIJ' ? traceDij() : method === 'NN' ? traceNN() : method === 'SWEEP' ? traceSweep() : method === 'CW' ? traceCW() : traceOurs();
    if (method !== 'OURS') { finalPlan = finalPlan || E.plan(net, ex, 'GTS+', { capacity: 60 }, 0); }
    idx = 0; show();
    var m = META[method];
    $('#learnTitle').textContent = m.title; $('#learnSource').textContent = m.src;
    $('#learnHow').innerHTML = m.how.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('');
    $('#learnMapTitle').textContent = method === 'DIJ' ? 'Shortest walk on the footpath network' : 'Example: 10 pickups, 60 clothes per trip';
    var tg = $('#learnTarget');
    if (method === 'DIJ') {
      var opts = ex.map(function (o) { return o.building; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (opts.indexOf(dijTarget) < 0) dijTarget = opts[opts.length - 1];
      tg.innerHTML = 'Walk to <select id="dijSel">' + opts.map(function (b) { return '<option' + (b === dijTarget ? ' selected' : '') + '>' + b + '</option>'; }).join('') + '</select>';
      $('#dijSel').addEventListener('change', function () { dijTarget = this.value; build(); });
    } else tg.innerHTML = '';
    $('#learnLegend').innerHTML = method === 'DIJ' ? '' : 'Coloured lines = trips (each colour is one trip, van → stops → van). Dashed grey = options being considered. Letters are pickups; small numbers are visiting order.';
  }
  function show() {
    var st = steps[idx];
    render(st);
    $('#learnStep').innerHTML = st.text;
    $('#lCount').textContent = 'Step ' + (idx + 1) + ' of ' + steps.length;
    $('#lPrev').disabled = idx === 0; $('#lNext').disabled = idx === steps.length - 1;
    renderSide(st);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } $('#lPlay').textContent = '▶ Play'; }
  $('#lNext').addEventListener('click', function () { stop(); if (idx < steps.length - 1) { idx++; show(); } });
  $('#lPrev').addEventListener('click', function () { stop(); if (idx > 0) { idx--; show(); } });
  $('#lReset').addEventListener('click', function () { stop(); idx = 0; show(); });
  $('#lPlay').addEventListener('click', function () {
    if (timer) return stop();
    if (idx >= steps.length - 1) idx = 0;
    $('#lPlay').textContent = '❚❚ Pause';
    timer = setInterval(function () { if (idx >= steps.length - 1) return stop(); idx++; show(); }, method === 'DIJ' ? 450 : 1300);
  });
  $('#lNewEx').addEventListener('click', function () {
    var r = E.randomOrders(CAMPUS, 10, Math.floor(Math.random() * 1e6) + 1).map(function (o) { return [o.building, o.floor, o.room, Math.min(30, o.pieces)]; });
    setExample(r); finalPlan = null; build(); summary();
  });
  $$('#learnPick button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#learnPick button').forEach(function (x) { x.classList.toggle('active', x === b); });
      method = b.dataset.m; build();
    });
  });

  // ------------------------------------------------------------------ summary table
  function summary() {
    var sc = R.scenarios, keys = [['NN', 'Nearest-neighbour', 'Class (Sessions 1–4)', 'Always go to the nearest pickup that fits'],
      ['SWEEP', 'Sweep', 'Class (Session 9)', 'Group pickups by direction from the van'],
      ['CW', 'Clarke–Wright savings', 'Class (Sessions 8–9)', 'Join trips that save the most walking'],
      ['GTS+', 'Our method', 'Known split method + our day rule', 'Cut one long walk optimally, improve, then decide go-back-or-carry-on on the day']];
    $('#learnSummary thead').innerHTML = '<tr><th>Method</th><th>Source</th><th>Idea</th><th class="num">Walking, normal day (min)</th><th class="num">Expected cost (Rs/day)</th><th class="num">Exact best in small tests</th></tr>';
    $('#learnSummary tbody').innerHTML = keys.map(function (k) {
      var exp = sc.reduce(function (s, x) { return s + x.prob * R.methods[x.id][k[0]].cost; }, 0);
      return '<tr class="' + (k[0] === 'GTS+' ? 'best' : '') + '"><td><b>' + k[1] + '</b></td><td>' + k[2] + '</td><td>' + k[3] + '</td><td class="num">' + fmt(R.methods.S0[k[0]].walkMin) +
        '</td><td class="num">' + fmt(exp) + '</td><td class="num">' + fmt(100 * R.validation[k[0]].optimalShare) + '%</td></tr>';
    }).join('');
    var n50 = R.methods.N50;
    $('#learnSummaryNote').innerHTML = 'Where our saving comes from, on a day when half the students are out: Clarke–Wright costs Rs ' + fmt(n50.CW.cost) + '; our routing alone Rs ' + fmt(n50['GTS+ routing only'].cost) +
      '; our routing plus smart chaining Rs ' + fmt(n50['GTS+'].cost) + '. Most of the gain on bad days comes from smart chaining. It works on top of any route: Clarke–Wright plus our chaining rule costs Rs ' + fmt(n50['CW + smart chaining'].cost) + '. ' +
      'Averages over ' + R.meta.days + ' simulated days per case.';
  }

  function init() {
    if (inited) return; inited = true;
    setExample(FIXED); summary();
    var h = location.hash, m = /[&#]m=(\w+)/.exec(h), s = /[&#]step=(\d+)/.exec(h);
    if (m && META[m[1]]) { method = m[1]; $$('#learnPick button').forEach(function (x) { x.classList.toggle('active', x.dataset.m === method); }); }
    build();
    if (s) { idx = Math.min(steps.length - 1, Math.max(0, +s[1] - 1)); show(); }
  }
  document.addEventListener('tabshown', function (e) { if (e.detail === 'learn') init(); });
  if ($('#tab-learn').classList.contains('active')) init();
})();
