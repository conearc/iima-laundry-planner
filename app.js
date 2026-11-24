/* IIMA Laundry Route Planner — website logic (no external libraries) */
(function () {
  'use strict';
  var E = window.LaundryEngine, R = window.RESULTS;
  var net = E.buildNetwork(CAMPUS);
  var METHODS = [  // the four methods on the site: three from class + ours
    { key: 'NN', algo: 'NN', chain: 'none', label: 'Nearest-neighbour', src: 'from class' },
    { key: 'SWEEP', algo: 'SWEEP', chain: 'none', label: 'Sweep', src: 'from class' },
    { key: 'CW', algo: 'CW', chain: 'none', label: 'Clarke–Wright savings', src: 'from class' },
    { key: 'GTS+', algo: 'GTS+', chain: 'smart', label: 'Our method', src: 'ours' }
  ];
  var BLD = {}; CAMPUS.buildings.forEach(function (b) { BLD[b.name] = b; });

  // ---------------------------------------------------------------- helpers
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmt(x, d) { return (x === undefined || isNaN(x)) ? '–' : Number(x).toLocaleString('en-IN', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }); }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage blocked */ } }
  function read(key, dflt) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function workerColor(i) { return cssVar('--s' + ((i % 8) + 1)); }
  function setMsg(el, text, cls) { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }
  function floorName(f) { return f === 0 ? 'ground' : (f === 1 ? '1st' : f === 2 ? '2nd' : f === 3 ? '3rd' : f + 'th'); }
  function Floor(f) { var s = floorName(f); return s.charAt(0).toUpperCase() + s.slice(1); }
  function roomLabel(r) { r = String(r); return /^flat/i.test(r) ? r : 'room ' + r; }
  function clock(startHHMM, plusMin) {
    var p = (startHHMM || '09:30').split(':'), t = (+p[0]) * 60 + (+p[1]) + Math.round(plusMin);
    var h = Math.floor(t / 60) % 24, m = t % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function mins(x) { x = Math.round(x); return x < 60 ? x + ' min' : Math.floor(x / 60) + ' h ' + (x % 60) + ' min'; }

  // ---------------------------------------------------------------- state
  var ORDERS_KEY = 'iimaLaundry.orders.v2', PROB_KEY = 'iimaLaundry.probs.v2';
  var orders = read(ORDERS_KEY, []);
  var probs = read(PROB_KEY, null) || E.SCENARIOS.map(function (s) { return s.prob; });
  if (probs.length !== E.SCENARIOS.length) probs = E.SCENARIOS.map(function (s) { return s.prob; });
  var last = null;

  function scenariosWithProbs() {
    var tot = probs.reduce(function (a, b) { return a + b; }, 0) || 1;
    return E.SCENARIOS.map(function (s, i) { return E.extend(s, { prob: probs[i] / tot }); });
  }
  function prior() { return E.noShowPrior(scenariosWithProbs()); }

  // shared with teach.js
  window.LaundryUI = { net: net, cssVar: cssVar, workerColor: workerColor, esc: esc, fmt: fmt, prior: prior, floorName: floorName };

  // ---------------------------------------------------------------- tabs
  function showTab(id) {
    $$('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === id); });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.id === 'tab-' + id); });
    if (id === 'walker') prepareWalker();
    document.dispatchEvent(new CustomEvent('tabshown', { detail: id }));
    window.scrollTo(0, 0);
  }
  $$('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-goto]');
    if (g) { e.preventDefault(); showTab(g.dataset.goto); }
  });

  // ================================================================ 1. STUDENT
  var fB = $('#fBuilding'), fF = $('#fFloor');
  (function fillBuildings() {
    var groups = {};
    CAMPUS.buildings.forEach(function (b) { (groups[b.group] = groups[b.group] || []).push(b); });
    ['D19-D27', 'D28-D35', 'D36-D43', 'MSH 1-19'].forEach(function (g) {
      var og = document.createElement('optgroup'); og.label = g.replace('-', '–');
      groups[g].sort(function (a, b) { return parseInt(a.name.replace(/\D/g, ''), 10) - parseInt(b.name.replace(/\D/g, ''), 10); })
        .forEach(function (b) { var o = document.createElement('option'); o.value = b.name; o.textContent = b.name.replace('MSH', 'MSH '); og.appendChild(o); });
      fB.appendChild(og);
    });
    fB.value = 'D42';
  })();
  function fillFloors() {
    var b = BLD[fB.value]; fF.innerHTML = '';
    for (var f = 0; f < b.floors; f++) { var o = document.createElement('option'); o.value = f; o.textContent = Floor(f); fF.appendChild(o); }
  }
  fB.addEventListener('change', fillFloors); fillFloors();
  $('#fRoom').addEventListener('input', function () {
    var n = parseInt(this.value, 10), b = BLD[fB.value];
    if (!isNaN(n) && n >= 100 && b.kind === 'dorm') { var f = Math.floor(n / 100); if (f < b.floors) fF.value = f; }
  });
  $('#orderForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#fName').value.trim(), room = $('#fRoom').value.trim(), pcs = parseInt($('#fPieces').value, 10), msg = $('#formMsg');
    if (!name || !room) return setMsg(msg, 'Please fill in your name and room.', 'err');
    if (!(pcs >= 1 && pcs <= 40)) return setMsg(msg, 'Number of clothes must be between 1 and 40.', 'err');
    if (orders.length >= 100) return setMsg(msg, 'Today\'s list is full (100 requests).', 'err');
    var dup = orders.some(function (o) { return o.building === fB.value && String(o.room) === room; });
    if (dup) return setMsg(msg, 'A pickup for ' + fB.value + ' room ' + room + ' is already booked today.', 'err');
    var id = 'Q' + Date.now().toString(36).slice(-5).toUpperCase();
    orders.push({ id: id, name: name, building: fB.value, floor: +fF.value, room: room, pieces: pcs });
    store(ORDERS_KEY, orders); renderOrders();
    setMsg(msg, 'Booked: ' + pcs + ' clothes from ' + fB.value + ', room ' + room + '. Reference ' + id + '.', 'ok');
    $('#fRoom').value = ''; $('#fName').focus(); last = null;
  });
  function renderOrders() {
    var tb = $('#orderTable tbody'), pcs = 0;
    tb.innerHTML = orders.map(function (o, i) {
      pcs += o.pieces;
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(o.name) + '</td><td>' + esc(o.building) + '</td><td>' + Floor(o.floor) +
        '</td><td>' + esc(o.room) + '</td><td class="num">' + o.pieces + '</td><td><button class="x" data-del="' + i + '" aria-label="Remove">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted">No requests yet. Book one, or make some sample requests.</td></tr>';
    $('#orderStats').textContent = orders.length + ' requests · ' + pcs + ' clothes';
  }
  $('#orderTable').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]'); if (!b) return;
    orders.splice(+b.dataset.del, 1); store(ORDERS_KEY, orders); renderOrders(); last = null;
  });
  function makeSample(n, seed) {
    n = Math.max(1, Math.min(100, Math.round(n) || 40));
    $('#sampleN').value = n;
    orders = E.randomOrders(CAMPUS, n, seed).map(function (o) { return { id: o.id, name: o.name, building: o.building, floor: o.floor, room: o.room, pieces: o.pieces }; });
    store(ORDERS_KEY, orders); renderOrders(); last = null;
  }
  $('#btnSample').addEventListener('click', function () {
    if (orders.length && !confirm('Replace the ' + orders.length + ' current requests with a new sample?')) return;
    makeSample(parseInt($('#sampleN').value, 10), Math.floor(Math.random() * 1e6) + 1);
  });
  $('#sampleN').addEventListener('change', function () { var v = parseInt(this.value, 10); this.value = Math.max(1, Math.min(100, v || 40)); });
  $('#btnClear').addEventListener('click', function () {
    if (orders.length && !confirm('Remove all ' + orders.length + ' requests?')) return;
    orders = []; store(ORDERS_KEY, orders); renderOrders(); last = null;
  });
  renderOrders();

  // ================================================================ 2. PARTNER
  function partnerOpt() {
    return {
      workers: Math.max(1, Math.min(8, parseInt($('#pWorkers').value, 10) || 3)),
      capacity: Math.max(40, Math.min(150, parseInt($('#pCap').value, 10) || 60)),
      shiftMin: Math.max(60, Math.min(600, parseInt($('#pShift').value, 10) || 240))
    };
  }
  function engineOrders() { return orders.map(function (o) { return { id: o.id, name: o.name, building: o.building, floor: o.floor, room: o.room, pieces: o.pieces }; }); }

  function evaluateToday(opt) {
    var ords = engineOrders(), k = opt.workers, pr = prior(), plans = {};
    METHODS.forEach(function (m) { var t0 = performance.now(); plans[m.algo] = E.plan(net, ords, m.algo, opt, 0); plans[m.algo].ms = performance.now() - t0; });
    var allIn = ords.map(function () { return true; });
    var S = 150, rng = E.mulberry32(20261124), draws = [];
    for (var s = 0; s < S; s++) {
      var u = rng(), acc = 0, p = pr[pr.length - 1].p;
      for (var h = 0; h < pr.length; h++) { acc += pr[h].w; if (u <= acc) { p = pr[h].p; break; } }
      draws.push(ords.map(function () { return rng() >= p; }));
    }
    var rows = METHODS.map(function (m) {
      var pl = plans[m.algo], base = E.execute(pl, allIn, k, 'none'), sd = 0, sc = 0, sw = 0;
      draws.forEach(function (pres) { var r = E.execute(pl, pres, k, m.chain, pr); sd += r.dayMin; sc += r.cost; sw += r.walkMin; });
      return { m: m, trips: pl.trips.length, walkAllIn: base.walkMin, dayAllIn: base.dayMin, expDay: sd / S, expCost: sc / S, expWalk: sw / S, ms: pl.ms };
    });
    var best = rows.reduce(function (a, b) { return b.expCost < a.expCost - 1e-9 ? b : a; });
    return { rows: rows, best: best, plans: plans, orders: ords, opt: opt, prior: pr };
  }

  $('#btnPlan').addEventListener('click', function () {
    var msg = $('#planMsg');
    if (!orders.length) { setMsg(msg, 'No requests yet: add some on the first tab, or make sample requests.', 'err'); return; }
    setMsg(msg, 'Planning ' + orders.length + ' pickups…');
    setTimeout(function () {
      last = evaluateToday(partnerOpt()); renderPlan();
      setMsg(msg, 'Done. ' + orders.length + ' pickups, ' + orders.reduce(function (s, o) { return s + o.pieces; }, 0) + ' clothes, team of ' + last.opt.workers + '.', 'ok');
    }, 30);
  });
  $('#pStart').addEventListener('change', function () { if (last) renderSheets(); });
  $('#btnPrint').addEventListener('click', function () { window.print(); });

  function renderPlan() {
    $('#planOut').classList.remove('hidden');
    var L = last, best = L.best, pl = L.plans[best.m.algo];
    var asg = E.assignTrips(pl, L.opt.workers);
    L.shown = { plan: pl, asg: asg, m: best.m };
    renderSheets();
    var worst = L.rows.reduce(function (a, b) { return b.expCost > a.expCost ? b : a; });
    $('#recoText').innerHTML = '<b>' + esc(best.m.label) + '</b> has the lowest expected cost today (Rs ' + fmt(best.expCost) + '), ' +
      fmt(100 * (worst.expCost / best.expCost - 1), 1) + '% below ' + esc(worst.m.label) + '.';
    $('#rankTable thead').innerHTML = '<tr><th>Method</th><th class="num">Trips</th><th class="num">Walking (min)</th><th class="num">Expected cost (Rs)</th><th class="num">vs best</th></tr>';
    $('#rankTable tbody').innerHTML = L.rows.slice().sort(function (a, b) { return a.expCost - b.expCost; }).map(function (r) {
      return '<tr class="' + (r === best ? 'best' : '') + '"><td>' + esc(r.m.label) + ' <span class="small">(' + r.m.src + ')</span></td><td class="num">' + r.trips +
        '</td><td class="num">' + fmt(r.expWalk) + '</td><td class="num">' + fmt(r.expCost) +
        '</td><td class="num">' + (r === best ? 'best' : '+' + fmt(100 * (r.expCost / best.expCost - 1), 1) + '%') + '</td></tr>';
    }).join('');
    var sel = $('#mapWorker'); sel.innerHTML = '<option value="all">everyone</option>';
    for (var w = 0; w < L.opt.workers; w++) sel.innerHTML += '<option value="' + w + '">Person ' + (w + 1) + '</option>';
    drawMap($('#mapWrap'), pl, asg, 'all');
  }
  $('#mapWorker').addEventListener('change', function () { if (last && last.shown) drawMap($('#mapWrap'), last.shown.plan, last.shown.asg, this.value); });

  // ---- the plain-words route sheet, one card per person
  function renderSheets() {
    var L = last, pl = L.shown.plan, asg = L.shown.asg, ctx = pl.ctx, o = ctx.opt, start = $('#pStart').value || '09:30';
    var sp = o.walkMPerMin, tot = 0, endMax = 0;
    var cards = asg.lists.map(function (list, w) {
      var t = 0, pcsAll = 0, html = '';
      list.forEach(function (ti, n) {
        var trip = pl.trips[ti], prevB = 0, prevF = 0, steps = [], load = 0, tripStart = t;
        trip.forEach(function (j) {
          var ord = ctx.orders[j], b = ctx.pt[j], f = ctx.fl[j];
          if (b !== prevB) {
            var walk = net.W[prevB][b] / sp;
            steps.push('<li class="go">Walk ' + (prevB === 0 ? 'from the van ' : '') + 'to <b>' + esc(ord.building) + '</b> <span class="small">(about ' + Math.max(1, Math.round(walk)) + ' min)</span></li>');
            prevF = 0;
          }
          var move = f === prevF ? (f === 0 ? 'On the ground floor' : 'On the same floor') : (f > prevF ? 'Go up to the ' + floorName(f) + ' floor' : 'Come down to the ' + floorName(f) + ' floor');
          steps.push('<li>' + move + ': <b>' + esc(roomLabel(ord.room)) + '</b> · ' + esc(ord.name) + ' · collect <b>' + ctx.q[j] + ' clothes</b></li>');
          load += ctx.q[j]; prevB = b; prevF = f;
        });
        var back = net.W[prevB][0] / sp;
        steps.push('<li class="go">Walk back to the <b>van</b> <span class="small">(about ' + Math.max(1, Math.round(back)) + ' min)</span> and unload.</li>');
        t += asg.planned[ti]; pcsAll += load;
        html += '<div class="trip"><div class="triphead"><b>Trip ' + (n + 1) + '</b> · ' + load + ' clothes · about ' + mins(asg.planned[ti]) +
          ' · start about ' + clock(start, tripStart) + '</div><ol>' + steps.join('') + '</ol></div>';
      });
      endMax = Math.max(endMax, t); tot += pcsAll;
      return '<div class="person"><div class="personhead"><span class="dot" style="background:' + workerColor(w) + '"></span><div><div class="pname">Person ' + (w + 1) +
        '</div><div class="small">' + list.length + ' trip' + (list.length === 1 ? '' : 's') + ' · ' + pcsAll + ' clothes · back at the van by about <b>' + clock(start, t) + '</b></div></div></div>' +
        (list.length ? html : '<p class="muted">No trips today: help at the van.</p>') + '</div>';
    });
    $('#personSheets').innerHTML = cards.join('');
    $('#ruleCap').textContent = ctx.cap;
    $('#sheetLead').innerHTML = '<b>' + asg.lists.length + ' people</b> collect <b>' + tot + ' clothes</b> from <b>' + ctx.n + ' rooms</b>. Start walking at ' +
      clock(start, 0) + '; everyone should be back at the van by about <b>' + clock(start, endMax) + '</b> if all students are in (earlier when some are out). ' +
      '<span class="small">Plan made with: ' + esc(L.shown.m.label) + '.</span>';
  }

  // ---------------------------------------------------------------- map
  var tip = document.createElement('div'); tip.className = 'maptip hidden'; document.body.appendChild(tip);
  function drawMap(host, pl, asg, only) {
    var minX = -32, maxX = 405, minY = 160, maxY = 378, W = maxX - minX, H = maxY - minY;
    function X(x) { return (x - minX).toFixed(1); } function Y(y) { return (maxY - y).toFixed(1); }
    var counts = {}, pieces = {};
    if (pl) pl.ctx.orders.forEach(function (o) { counts[o.building] = (counts[o.building] || 0) + 1; pieces[o.building] = (pieces[o.building] || 0) + o.pieces; });
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Campus map with collection routes">';
    s += '<polygon points="' + CAMPUS.outline.map(function (p) { return X(p[0]) + ',' + Y(p[1]); }).join(' ') + '" fill="' + cssVar('--map-campus') + '" stroke="' + cssVar('--map-line') + '" stroke-width="1.5"/>';
    var drawn = {};
    net.adj.forEach(function (lst, a) {
      lst.forEach(function (e) {
        var b = e[0], key = a < b ? a + '_' + b : b + '_' + a; if (drawn[key]) return; drawn[key] = 1;
        s += '<line x1="' + X(net.nodes[a].x) + '" y1="' + Y(net.nodes[a].y) + '" x2="' + X(net.nodes[b].x) + '" y2="' + Y(net.nodes[b].y) + '" stroke="' + cssVar('--map-line') + '" stroke-width="0.5" stroke-dasharray="2 2" opacity="0.7"/>';
      });
    });
    CAMPUS.landmarks.forEach(function (l) {
      if (/Activity|Sports|G2/.test(l.name)) return;
      s += '<text x="' + X(l.x) + '" y="' + Y(l.y) + '" font-size="8" fill="' + cssVar('--muted') + '" text-anchor="middle">' + esc(l.name) + '</text>';
    });
    if (pl && asg) {
      asg.lists.forEach(function (list, w) {
        if (only !== 'all' && +only !== w) return;
        var off = (w - (asg.lists.length - 1) / 2) * 1.4, col = workerColor(w);
        list.forEach(function (ti) {
          var t = pl.trips[ti], seq = [0];
          t.forEach(function (j) { var b = pl.ctx.pt[j]; if (seq[seq.length - 1] !== b) seq.push(b); });
          seq.push(0);
          var pts = [];
          for (var i = 0; i < seq.length - 1; i++) { var seg = E.pathCoords(net, seq[i], seq[i + 1]); if (i > 0) seg = seg.slice(1); pts = pts.concat(seg); }
          s += '<polyline points="' + pts.map(function (p) { return X(p[0] + off) + ',' + Y(p[1] + off); }).join(' ') +
            '" fill="none" stroke="' + col + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
        });
      });
    }
    CAMPUS.buildings.forEach(function (b) {
      var msh = b.kind === 'msh', w = msh ? 10 : 18, h = msh ? 7 : 12, on = counts[b.name];
      s += '<g class="bld" data-b="' + b.name + '"><rect x="' + (X(b.x) - w / 2) + '" y="' + (Y(b.y) - h / 2) + '" width="' + w + '" height="' + h + '" rx="2" fill="' +
        cssVar(on ? '--map-bld-on' : '--map-bld') + '" stroke="' + cssVar('--map-line') + '" stroke-width="0.8"/>' +
        '<text x="' + X(b.x) + '" y="' + (+Y(b.y) + 2.6) + '" font-size="' + (msh ? 5 : 7) + '" text-anchor="middle" fill="' + cssVar('--ink') + '" font-weight="600">' +
        (msh ? b.name.replace('MSH', 'M') : b.name) + '</text></g>';
    });
    s += '<g><rect x="' + (X(CAMPUS.depot.x) - 13) + '" y="' + (Y(CAMPUS.depot.y) - 6) + '" width="26" height="12" rx="3" fill="' + cssVar('--ink') + '"/>' +
      '<text x="' + X(CAMPUS.depot.x) + '" y="' + (+Y(CAMPUS.depot.y) + 3) + '" font-size="7" font-weight="700" text-anchor="middle" fill="' + cssVar('--surface') + '">VAN</text></g>';
    s += '<line x1="' + (W - 8 - 100) + '" y1="' + (H - 14) + '" x2="' + (W - 8) + '" y2="' + (H - 14) + '" stroke="' + cssVar('--ink2') + '" stroke-width="1.5"/>';
    s += '<text x="' + (W - 58) + '" y="' + (H - 18) + '" font-size="8" text-anchor="middle" fill="' + cssVar('--ink2') + '">100 m</text></svg>';
    host.innerHTML = s;
    $$('.bld', host).forEach(function (g) {
      g.addEventListener('mousemove', function (e) {
        var b = g.dataset.b;
        tip.innerHTML = '<b>' + b + '</b> · ' + BLD[b].group.replace('-', '–') + '<br>' + (counts[b] ? counts[b] + ' pickups, ' + pieces[b] + ' clothes' : 'no pickups today') +
          '<br><span class="small">' + fmt(net.W[0][net.bIndex[b]]) + ' m walk from the van</span>';
        tip.classList.remove('hidden'); tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
      });
      g.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
    });
    var lg = $('#mapLegend');
    if (lg && asg) lg.innerHTML = asg.lists.map(function (_, w) { return '<span><span class="sw" style="background:' + workerColor(w) + '"></span>Person ' + (w + 1) + '</span>'; }).join('') +
      '<span>Blue blocks have pickups · hover a block · traced from IIMA\'s official campus map (±20%), north up</span>';
  }

  // ================================================================ 3. WALKER
  var WK = null;
  function prepareWalker() {
    var sel = $('#wWorker'), msg = $('#walkerMsg');
    if (!last) {
      if (!orders.length) { setMsg(msg, 'Plan a round on tab 2 first (or make sample requests on tab 1).', 'err'); sel.innerHTML = ''; return; }
      last = evaluateToday(partnerOpt()); renderPlan();
    }
    var n = last.shown.asg.lists.length;
    sel.innerHTML = '';
    for (var w = 0; w < n; w++) sel.innerHTML += '<option value="' + w + '">Person ' + (w + 1) + ' (' + last.shown.asg.lists[w].length + ' trips)</option>';
    setMsg(msg, 'Using today\'s plan (' + last.shown.m.label + ').');
  }
  function startWalker(auto) {
    if (!last) prepareWalker(); if (!last) return;
    var w = +$('#wWorker').value || 0, pl = last.shown.plan, list = last.shown.asg.lists[w];
    WK = { w: w, pl: pl, ctx: pl.ctx, list: list, ti: 0, pos: 0, cur: 0, load: 0, time: 0, seen: 0, out: 0, collected: 0, auto: auto, pr: prior() };
    if (auto) { var u = Math.random(), acc = 0; WK.trueP = WK.pr[WK.pr.length - 1].p; for (var h = 0; h < WK.pr.length; h++) { acc += WK.pr[h].w; if (u <= acc) { WK.trueP = WK.pr[h].p; break; } } }
    $('#walkerOut').classList.remove('hidden'); $('#wCap').textContent = WK.ctx.cap; $('#wLog').innerHTML = '';
    logW('Start at the van near D42. ' + list.length + ' trips planned.');
    stepWalker();
  }
  function logW(t) { var li = document.createElement('li'); li.textContent = '[' + fmt(WK.time, 1) + ' min] ' + t; $('#wLog').appendChild(li); li.scrollIntoView({ block: 'nearest' }); }
  function refreshStats() {
    $('#wLoad').textContent = Math.round(WK.load); $('#wTime').textContent = fmt(WK.time);
    $('#wP').textContent = fmt(100 * E.posteriorNoShow(WK.pr, WK.seen, WK.out)) + '%';
  }
  function stepWalker() {
    refreshStats();
    var ctx = WK.ctx, o = ctx.opt, now = $('#wNow'), btns = $('#wButtons');
    now.className = 'now';
    if (WK.ti >= WK.list.length) {
      if (WK.cur !== 0) { WK.time += E.cost(ctx, WK.cur, 0) + o.unloadMin; WK.cur = 0; logW('Back at the van, unloaded. Round finished.'); }
      refreshStats();
      now.innerHTML = '<div class="big">Round finished</div>' + fmt(WK.collected) + ' clothes collected in ' + fmt(WK.time) + ' min; ' + WK.out + ' of ' + WK.seen + ' rooms were empty.';
      btns.innerHTML = ''; return;
    }
    var t = WK.pl.trips[WK.list[WK.ti]];
    if (WK.pos < t.length) {
      var j = t[WK.pos], ord = ctx.orders[j], leg = E.cost(ctx, WK.cur, j + 1);
      now.innerHTML = '<div class="small">Trip ' + (WK.ti + 1) + ' of ' + WK.list.length + ' · stop ' + (WK.pos + 1) + ' of ' + t.length + '</div><div class="big">' +
        esc(ord.building) + ', ' + floorName(ord.floor) + ' floor, ' + esc(roomLabel(ord.room)) + '</div>' + esc(ord.name) + ' · ' + ctx.q[j] + ' clothes · about ' + fmt(leg, 1) + ' min away';
      btns.innerHTML = '<button class="in" id="bIn">In: collected</button><button class="out" id="bOut">Not in</button>';
      $('#bIn').onclick = function () { knock(true); }; $('#bOut').onclick = function () { knock(false); };
      if (WK.auto) setTimeout(function () { knock(Math.random() >= WK.trueP); }, 260);
      return;
    }
    var next = WK.list[WK.ti + 1];
    if (next === undefined) { WK.ti++; return stepWalker(); }
    var pNow = E.posteriorNoShow(WK.pr, WK.seen, WK.out), ev = E.expectedContinue(ctx, WK.cur, WK.load, WK.pl.trips[next], pNow), go = ev.cont < ev.back - 1e-9;
    now.className = 'now decision';
    now.innerHTML = '<div class="small">Trip ' + (WK.ti + 1) + ' done · carrying ' + Math.round(WK.load) + ' of ' + ctx.cap + '</div><div class="big">' +
      (go ? 'Go straight on to your next trip' : 'Walk back to the van and unload') + '</div>' +
      (go ? 'Saves about ' + fmt(ev.back - ev.cont, 1) + ' min on average, even counting the chance your arms fill up on the way.' : 'Carrying on would cost about ' + fmt(ev.cont - ev.back, 1) + ' min more on average.') +
      ' <span class="small">(App estimates ' + fmt(100 * pNow) + '% of students are out today.)</span>';
    btns.innerHTML = '<button class="primary" id="bOk">OK</button>';
    $('#bOk').onclick = function () {
      if (go) logW('Went straight on with ' + Math.round(WK.load) + ' clothes.');
      else { WK.time += E.cost(ctx, WK.cur, 0) + o.unloadMin; WK.cur = 0; WK.load = 0; logW('Walked back to the van and unloaded.'); }
      WK.ti++; WK.pos = 0; stepWalker();
    };
    if (WK.auto) setTimeout(function () { $('#bOk') && $('#bOk').onclick(); }, 420);
  }
  function knock(isIn) {
    var ctx = WK.ctx, o = ctx.opt, t = WK.pl.trips[WK.list[WK.ti]], j = t[WK.pos], ord = ctx.orders[j], leg = E.cost(ctx, WK.cur, j + 1);
    WK.seen++;
    if (isIn) {
      if (WK.load + ctx.q[j] > ctx.cap) { leg = E.cost(ctx, WK.cur, 0) + o.unloadMin + E.cost(ctx, 0, j + 1); WK.load = 0; logW('Arms full: back to the van to unload, then to ' + ord.building + '.'); }
      WK.load += ctx.q[j]; WK.collected += ctx.q[j]; WK.time += leg + o.serviceMin + o.countSecPerPiece * ctx.q[j] / 60;
      logW('Collected ' + ctx.q[j] + ' from ' + ord.building + ', ' + roomLabel(ord.room) + '.');
    } else { WK.out++; WK.time += leg + o.noShowWaitMin; logW('Nobody at ' + ord.building + ', ' + roomLabel(ord.room) + '.'); }
    WK.cur = j + 1; WK.pos++; stepWalker();
  }
  $('#btnWalkerStart').addEventListener('click', function () { startWalker(false); });
  $('#btnWalkerAuto').addEventListener('click', function () { startWalker(true); });

  // ================================================================ 4. COMPARE
  function renderProbTable() {
    $('#probTable tbody').innerHTML = E.SCENARIOS.map(function (s, i) {
      return '<tr><td>' + esc(s.group) + '</td><td>' + esc(s.name) + '</td><td class="num">' + fmt(R.orders[s.id]) + '</td><td class="num">' + fmt(100 * s.p) +
        '%</td><td class="num"><input type="number" min="0" max="100" step="1" data-p="' + i + '" value="' + Math.round(100 * probs[i]) + '"> %</td></tr>';
    }).join('');
    $$('#probTable input').forEach(function (inp) {
      inp.addEventListener('input', function () { probs[+inp.dataset.p] = Math.max(0, parseFloat(inp.value) || 0) / 100; store(PROB_KEY, probs); renderAnalysis(); last = null; });
    });
  }
  function renderAnalysis() {
    var sc = scenariosWithProbs(), raw = probs.reduce(function (a, b) { return a + b; }, 0);
    setMsg($('#probSum'), 'Probabilities add up to ' + fmt(100 * raw) + '%' + (Math.abs(raw - 1) > 0.005 ? ' (rescaled to 100%).' : '.') +
      ' Expected share of students out: ' + fmt(100 * E.expectedNoShow(sc), 1) + '%.', Math.abs(raw - 1) > 0.005 ? 'err' : '');
    var rows = METHODS.map(function (m) {
      var exp = 0, day = 0, walk = 0, per = {};
      sc.forEach(function (s) { var r = R.methods[s.id][m.key]; per[s.id] = r.cost; exp += s.prob * r.cost; day += s.prob * r.dayMin; walk += s.prob * r.walkMin; });
      return { m: m, exp: exp, day: day, walk: walk, per: per };
    });
    var best = rows.reduce(function (a, b) { return b.exp < a.exp ? b : a; });
    rows.forEach(function (r) { r.regret = 0; sc.forEach(function (s) { var mn = Math.min.apply(null, rows.map(function (x) { return x.per[s.id]; })); r.regret = Math.max(r.regret, r.per[s.id] - mn); }); });
    $('#bestPill').textContent = 'Best: ' + best.m.label;
    var nn = rows[0], cw = rows[2];
    $('#anaLead').innerHTML = 'With these probabilities, <b>' + esc(best.m.label) + '</b> has the lowest expected cost: <b>Rs ' + fmt(best.exp) + ' a day</b>. That is ' +
      fmt(100 * (1 - best.exp / cw.exp), 1) + '% below Clarke–Wright and ' + fmt(100 * (1 - best.exp / nn.exp), 1) + '% below nearest-neighbour. It walks ' +
      fmt(100 * (1 - best.walk / nn.walk)) + '% less than nearest-neighbour.';
    var sorted = rows.slice().sort(function (a, b) { return a.exp - b.exp; });
    $('#anaTable thead').innerHTML = '<tr><th>Method</th>' + sc.map(function (s) { return '<th class="num">' + esc(s.id) + '<div class="small">' + fmt(100 * s.prob) + '%</div></th>'; }).join('') +
      '<th class="num">Expected (Rs/day)</th><th class="num">Expected day (min)</th><th class="num">Worst-case regret (Rs)</th></tr>';
    $('#anaTable tbody').innerHTML = sorted.map(function (r) {
      return '<tr class="' + (r === best ? 'best' : '') + '"><td>' + esc(r.m.label) + ' <span class="small">(' + r.m.src + ')</span></td>' +
        sc.map(function (s) { return '<td class="num">' + fmt(r.per[s.id]) + '</td>'; }).join('') +
        '<td class="num"><b>' + fmt(r.exp) + '</b></td><td class="num">' + fmt(r.day) + '</td><td class="num">' + fmt(r.regret) + '</td></tr>';
    }).join('');
    $('#anaNote').textContent = 'Pre-computed: ' + R.meta.days + ' simulated days per case, the same students for every method, a team of ' + R.meta.workers +
      ', 60 clothes per trip. Cost = team time at Rs 100 per person-hour, plus 50% for overtime past 240 minutes. Class methods walk back to the van after every trip, as taught; our method also uses smart chaining.';
    barChart($('#anaChart'), sorted.map(function (r) { return { label: r.m.label, v: r.exp, best: r === best }; }));
    $('#walkTable thead').innerHTML = '<tr><th>Method</th>' + E.SCENARIOS.map(function (s) { return '<th class="num">' + s.id + '</th>'; }).join('') + '</tr>';
    $('#walkTable tbody').innerHTML = METHODS.map(function (m) {
      return '<tr><td>' + esc(m.label) + '</td>' + E.SCENARIOS.map(function (s) {
        var mn = Math.min.apply(null, METHODS.map(function (x) { return R.methods[s.id][x.key].walkMin; })), v = R.methods[s.id][m.key].walkMin;
        return '<td class="num">' + fmt(v) + (v > mn + 0.5 ? ' <span class="small">+' + fmt(100 * (v / mn - 1)) + '%</span>' : '') + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var wf = [];
    for (var k = 1; k <= 6; k++) {
      var c2 = 0, d2 = 0, ok = 0;
      sc.forEach(function (s) { var r = R.workforce[s.id][k]; c2 += s.prob * r.cost; d2 += s.prob * r.dayMin; ok += s.prob * r.withinShift; });
      wf.push({ k: k, cost: c2, day: d2, ok: ok });
    }
    var bestK = wf.reduce(function (a, b) { return b.cost < a.cost ? b : a; });
    $('#wfTable thead').innerHTML = '<tr><th>Team size</th><th class="num">Expected day (min)</th><th class="num">Days within 240 min</th><th class="num">Expected cost (Rs)</th></tr>';
    $('#wfTable tbody').innerHTML = wf.map(function (r) {
      return '<tr class="' + (r === bestK ? 'best' : '') + '"><td>' + r.k + (r.k === 1 ? ' person' : ' people') + '</td><td class="num">' + fmt(r.day) + '</td><td class="num">' + fmt(100 * r.ok) + '%</td><td class="num">' + fmt(r.cost) + '</td></tr>';
    }).join('');
    $('#wfLead').textContent = 'With our method. The cheapest team is ' + bestK.k + ' people. With fewer, the day runs into overtime. With more, people stand idle waiting for the longest trip to finish.';
    $('#valTable thead').innerHTML = '<tr><th>Method</th><th class="num">Mean gap</th><th class="num">Worst gap</th><th class="num">Solved optimally</th></tr>';
    $('#valTable tbody').innerHTML = METHODS.map(function (m) {
      var v = R.validation[m.key];
      return '<tr><td>' + esc(m.label) + '</td><td class="num">' + fmt(100 * v.meanGap, 2) + '%</td><td class="num">' + fmt(100 * v.maxGap, 1) + '%</td><td class="num">' + fmt(100 * v.optimalShare) + '%</td></tr>';
    }).join('');
    $('#valNote').textContent = R.validation.NN.n + ' small cases of 8 pickups, solved exactly by trying every possibility (Held–Karp tours plus the best split into armloads). Gap = extra walking against the true optimum.';
  }
  function barChart(host, data) {
    var W = 1000, rowH = 30, padL = 230, padR = 100, H = data.length * rowH + 16, max = Math.max.apply(null, data.map(function (d) { return d.v; }));
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Expected daily cost by method">';
    data.forEach(function (d, i) {
      var y = 6 + i * rowH, w = (W - padL - padR) * d.v / max;
      s += '<text x="' + (padL - 12) + '" y="' + (y + 17) + '" font-size="14" text-anchor="end" fill="' + cssVar('--ink2') + '">' + esc(d.label) + '</text>';
      s += '<rect x="' + padL + '" y="' + (y + 5) + '" width="' + w.toFixed(1) + '" height="17" rx="3" fill="' + cssVar(d.best ? '--s3' : '--s1') + '"><title>' + esc(d.label) + ': Rs ' + fmt(d.v) + '</title></rect>';
      s += '<text x="' + (padL + w + 8) + '" y="' + (y + 18) + '" font-size="14" fill="' + cssVar('--ink') + '">Rs ' + fmt(d.v) + '</text>';
    });
    host.innerHTML = s + '</svg>';
  }
  renderProbTable(); renderAnalysis();

  // ================================================================ ASSUMPTIONS
  (function assumptions() {
    var D = E.DEFAULTS, sc = E.SCENARIOS;
    var rows = [
      ['Pickups per day', 'About ' + fmt(R.orders.S0) + ' on a normal day, ' + fmt(R.orders.DHI) + ' on a busy day, ' + fmt(R.orders.DLO) + ' on a quiet day', 'Students order about once a week and one laundry partner serves about a third of campus'],
      ['Who orders', 'Any room is equally likely; MSH families are ' + D.mshOrderMultiplier + '× as likely', 'Families wash more often'],
      ['Clothes per order', 'About 12 on average (3–40); about 14 on busy days', 'Varies at random in the simulation'],
      ['Clothes one person carries per trip', D.capacity + ' (editable)', 'One armload or one large bag'],
      ['Walking speed', D.walkMPerMin + ' metres per minute', 'Normal pace while carrying a load'],
      ['Footpaths', '15% longer than a straight line; map distances accurate to about ±20%', 'Paths bend around buildings'],
      ['Stairs', D.stairMinPerFloor + ' min per floor, each way', 'No lifts'],
      ['Time at each room', D.serviceMin + ' min to knock and bag, plus ' + D.countSecPerPiece + ' seconds per piece to count with the student', ''],
      ['Room where nobody answers', D.noShowWaitMin + ' min lost (knock, wait, move on)', 'The order is lost for that day'],
      ['Students out', 'Each student is out independently of the others', 'In reality a class can empty many rooms at once'],
      ['Chance a student is out', sc.map(function (s) { return Math.round(100 * s.p) + '%'; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ') + ' depending on the kind of day (about ' + fmt(100 * E.expectedNoShow(sc), 0) + '% on average)', 'Editable on the Compare tab'],
      ['How often each kind of day happens', sc.map(function (s) { return s.id + ' ' + Math.round(100 * s.prob) + '%'; }).join(' · '), 'Our judgement; editable on the Compare tab'],
      ['Cost of a trip', 'No fixed charge; a trip costs its minutes, plus ' + D.unloadMin + ' min to unload at the van', ''],
      ['Fixed time each day', D.setupMin + ' min to drive in, park and leave', 'Same for every method'],
      ['Shift', D.shiftMin + ' minutes', ''],
      ['Cost of the team\'s time', 'Rs ' + D.teamRatePerHour + ' per person-hour; overtime past the shift costs ' + D.overtimeMult + '×', 'What a helper\'s hour is worth to the vendor'],
      ['Who is paid', 'Everyone is paid until the last person is back at the van', 'So waiting time counts as a cost']
    ];

    $('#assumpTable tbody').innerHTML = rows.map(function (r) { return '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td class="small">' + esc(r[2]) + '</td></tr>'; }).join('');
  })();

  drawMap($('#mapWrap'), null, null, 'all');

  // demo links: index.html#demo&tab=partner  (add &fresh for a new sample, &n=60 for its size)
  (function demo() {
    var h = location.hash.slice(1); if (!/demo/.test(h)) return;
    var m = /tab=(\w+)/.exec(h), tab = m ? m[1] : 'partner', nm = /n=(\d+)/.exec(h);
    if (!orders.length || /fresh/.test(h)) makeSample(nm ? +nm[1] : 60, 11);
    if (tab === 'partner' || tab === 'walker') { last = evaluateToday(partnerOpt()); renderPlan(); }
    showTab(tab);
    if (tab === 'walker' && /auto/.test(h)) startWalker(true);
  })();
})();
