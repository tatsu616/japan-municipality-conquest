(function () {
  'use strict';

  const STORAGE_KEY = 'jp_muni_conquest_save_v1';

  // Region groupings by prefecture code (1..47)
  const REGION_MAP = {
    REG_HOKKAIDO: [1],
    REG_TOHOKU: [2, 3, 4, 5, 6, 7],
    REG_KANTO: [8, 9, 10, 11, 12, 13, 14],
    REG_CHUBU: [15, 16, 17, 18, 19, 20, 21, 22, 23],
    REG_KINKI: [24, 25, 26, 27, 28, 29, 30],
    REG_CHUGOKU: [31, 32, 33, 34, 35],
    REG_SHIKOKU: [36, 37, 38, 39],
    REG_KYUSHU: [40, 41, 42, 43, 44, 45, 46, 47],
  };

  // Distinct vibrant palette for 47 prefectures
  const PREF_COLORS = [
    '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d',
    '#ea580c', '#4f46e5', '#0d9488', '#ca8a04', '#9333ea', '#e11d48', '#0284c7', '#16a34a',
    '#d97706', '#4f46e5', '#0d9488', '#ca8a04', '#9333ea', '#e11d48', '#0284c7', '#16a34a',
    '#ea580c', '#7c3aed', '#0891b2', '#65a30d', '#db2777', '#2563eb', '#dc2626', '#059669',
    '#d97706', '#7c3aed', '#0284c7', '#16a34a', '#ea580c', '#9333ea', '#0d9488', '#e11d48',
    '#2563eb', '#ca8a04', '#10b981', '#f97316', '#8b5cf6', '#ec4899', '#06b6d4'
  ];

  // Camera presets: [centerLon, centerLat, zoomScaleMultiplier]
  const CAMERA_PRESETS = {
    HOKKAIDO: { lon: 142.8, lat: 43.5, k: 3.3 },
    TOHOKU: { lon: 140.4, lat: 39.2, k: 3.8 },
    KANTO: { lon: 139.8, lat: 35.9, k: 5.5 },
    CHUBU: { lon: 137.8, lat: 36.2, k: 4.2 },
    KINKI: { lon: 135.5, lat: 34.7, k: 5.2 },
    CHUGOKU_SHIKOKU: { lon: 133.2, lat: 34.4, k: 4.5 },
    KYUSHU: { lon: 130.8, lat: 32.5, k: 4.5 },
    OKINAWA: { lon: 127.7, lat: 26.3, k: 6.5 }
  };

  // Phonetic normalization helper for Kana similarity
  const VOICED_TO_BASE_MAP = {
    'が': 'か', 'ぎ': 'き', 'ぐ': 'く', 'げ': 'け', 'ご': 'こ',
    'ざ': 'さ', 'じ': 'し', 'ず': 'す', 'ぜ': 'せ', 'ぞ': 'そ',
    'だ': 'た', 'ぢ': 'ち', 'づ': 'つ', 'で': 'て', 'ど': 'と',
    'ば': 'は', 'び': 'ひ', 'ぶ': 'ふ', 'べ': 'へ', 'ぼ': 'ほ',
    'ぱ': 'は', 'ぴ': 'ひ', 'ぷ': 'ふ', 'ぺ': 'へ', 'ぽ': 'ほ',
    'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ'
  };

  function stripSuffixKana(k, t) {
    if (t === '市' && k.endsWith('し')) return k.slice(0, -1);
    if (t === '区' && k.endsWith('く')) return k.slice(0, -1);
    if (t === '町') {
      if (k.endsWith('ちょう')) return k.slice(0, -3);
      if (k.endsWith('まち')) return k.slice(0, -2);
    }
    if (t === '村') {
      if (k.endsWith('むら')) return k.slice(0, -2);
      if (k.endsWith('そん')) return k.slice(0, -2);
    }
    return k;
  }

  function toBaseKana(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      out += VOICED_TO_BASE_MAP[ch] || ch;
    }
    return out;
  }

  // All 1,747 municipalities from data.js
  const muniList = window.JAPAN_MUNI_LIST || [];
  const muniByCode = new Map();
  const munisByPref = new Map();
  const prefNames = new Map();

  // Precompute stem reading and base reading on each municipality for fast similarity scoring
  muniList.forEach((m) => {
    m.stemKana = stripSuffixKana(m.k, m.t);
    m.baseKana = toBaseKana(m.stemKana);
    m.stemKanji = m.n.length > 1 ? m.n.slice(0, -1) : m.n;

    muniByCode.set(m.c, m);
    if (!munisByPref.has(m.p)) {
      munisByPref.set(m.p, []);
      prefNames.set(m.p, m.pn);
    }
    munisByPref.get(m.p).push(m);
  });

  // Game State
  const state = {
    conquered: new Set(),
    streak: 0,
    maxStreak: 0,
    totalAnswered: 0,
    totalCorrect: 0,
    recentCodes: [],
    recentAskedPrefs: [],
    lastAskedCode: null,
    lastConqueredCode: null,
    questionMode: 'mixed', // 'mixed' | 'kanji2kana' | 'kana2kanji'
    regionFilter: 'ALL',
    attackOrder: 'random', // 'random' | 'neighbor' | 'north_to_south'
    colorTheme: 'pref', // 'pref' | 'crimson' | 'emerald' | 'royal'
    autoZoom: true,
    soundEnabled: true,
    currentQuiz: null, // { muni, direction, choices, correctIndex, answered }
    autoNextTimer: null
  };

  // Web Audio Synthesizer for crisp feedback
  let audioCtx = null;
  function playSound(type) {
    if (!state.soundEnabled) return;
    try {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const now = audioCtx.currentTime;
      if (type === 'correct') {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, i) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + i * 0.06);
          gain.gain.setValueAtTime(0.14, now + i * 0.06);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.22);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now + i * 0.06);
          osc.stop(now + i * 0.06 + 0.24);
        });
      } else if (type === 'wrong') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.linearRampToValueAtTime(135, now + 0.25);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === 'fanfare') {
        const chord = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        chord.forEach((freq, i) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.08);
          gain.gain.setValueAtTime(0.16, now + i * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.55);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now + i * 0.08);
          osc.stop(now + i * 0.08 + 0.6);
        });
      }
    } catch (e) {
      // Ignore audio errors
    }
  }

  // Persistence
  const ALLOWED_QUESTION_MODES = ['mixed', 'kanji2kana', 'kana2kanji'];
  const ALLOWED_COLOR_THEMES = ['pref', 'crimson', 'emerald', 'royal'];

  function applyParsedSaveData(data) {
    if (!data || typeof data !== 'object') return false;
    state.conquered.clear();
    if (Array.isArray(data.c)) {
      data.c.forEach((code) => {
        const strCode = String(code);
        if (muniByCode.has(strCode)) state.conquered.add(strCode);
      });
    }
    state.streak = Math.max(0, Math.floor(Number(data.s) || 0));
    state.maxStreak = Math.max(0, Math.floor(Number(data.ms) || 0));
    state.totalAnswered = Math.max(0, Math.floor(Number(data.ta) || 0));
    state.totalCorrect = Math.max(0, Math.floor(Number(data.tc) || 0));
    state.recentCodes = Array.isArray(data.rc)
      ? data.rc.map(String).filter((code) => muniByCode.has(code)).slice(0, 14)
      : [];
    state.lastConqueredCode =
      typeof data.lc === 'string' && muniByCode.has(data.lc) ? data.lc : null;
    if (ALLOWED_QUESTION_MODES.includes(data.qm)) state.questionMode = data.qm;
    if (ALLOWED_COLOR_THEMES.includes(data.ct)) state.colorTheme = data.ct;
    return true;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      applyParsedSaveData(data);
    } catch (err) {
      console.warn('Failed to load save state:', err);
    }
  }

  function saveState() {
    try {
      const payload = {
        c: Array.from(state.conquered),
        s: state.streak,
        ms: state.maxStreak,
        ta: state.totalAnswered,
        tc: state.totalCorrect,
        rc: state.recentCodes.slice(0, 14),
        lc: state.lastConqueredCode,
        qm: state.questionMode,
        ct: state.colorTheme
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to save state:', err);
    }
  }

  // Color determination for a conquered municipality
  function getMuniFillColor(muni) {
    const subIdx = parseInt(muni.c.slice(-2), 10) || 0;
    const theme = state.colorTheme;
    if (theme === 'crimson') {
      const shades = ['#dc2626', '#ef4444', '#b91c1c', '#f97316', '#d97706', '#e11d48'];
      return shades[(muni.p + subIdx) % shades.length];
    }
    if (theme === 'emerald') {
      const shades = ['#059669', '#10b981', '#0d9488', '#16a34a', '#14b8a6', '#047857'];
      return shades[(muni.p + subIdx) % shades.length];
    }
    if (theme === 'royal') {
      const shades = ['#2563eb', '#3b82f6', '#1d4ed8', '#4f46e5', '#0284c7', '#6366f1'];
      return shades[(muni.p + subIdx) % shades.length];
    }
    // Default 'pref': Prefecture base hue with subtle per-municipality variation
    const baseHex = PREF_COLORS[(muni.p - 1) % PREF_COLORS.length];
    const c = d3.hsl(baseHex);
    const offset = ((subIdx % 5) - 2) * 0.04;
    c.l = Math.max(0.32, Math.min(0.62, c.l + offset));
    return c.formatHex();
  }

  // Rank title based on conquered count
  function getRankTitle(count) {
    if (count >= 1741) return '👑 日本全国・天下人';
    if (count >= 1400) return '🏯 征夷大将軍';
    if (count >= 1000) return '⚔️ 天下統一目前・大老';
    if (count >= 600) return '🛡️ 地方覇者・大大名';
    if (count >= 300) return '🐎 戦国大名';
    if (count >= 100) return '🚩 一国一城の主';
    if (count >= 30) return '🗡️ 侍大将';
    if (count >= 5) return '🏹 足軽小頭';
    return '🌱 旅の足軽';
  }

  // Ensure a GeoJSON feature does not have inverted spherical winding order in D3
  function fixWindingIfInverted(feat) {
    if (!feat || !feat.geometry) return feat;
    if (d3.geoArea(feat) > 0.5) {
      if (feat.geometry.type === 'Polygon') {
        feat.geometry.coordinates = feat.geometry.coordinates.map((ring) => ring.slice().reverse());
      } else if (feat.geometry.type === 'MultiPolygon') {
        feat.geometry.coordinates = feat.geometry.coordinates.map((poly) =>
          poly.map((ring) => ring.slice().reverse())
        );
      }
    }
    return feat;
  }

  // D3 Map Setup
  let svg, gRoot, gMunis, gPrefBorders, gOverlay;
  let projection, pathGenerator, zoomBehavior;
  let mapWidth = 900;
  let mapHeight = 700;
  const pathSelectionByCode = new Map();
  const featureByCode = new Map();
  const pixelCentroidByCode = new Map();

  function initMap() {
    const stageEl = document.getElementById('map-stage');
    mapWidth = stageEl.clientWidth || 900;
    mapHeight = stageEl.clientHeight || 700;

    svg = d3.select('#japan-map-svg')
      .attr('viewBox', `0 0 ${mapWidth} ${mapHeight}`);

    gRoot = svg.append('g').attr('class', 'map-root');
    gMunis = gRoot.append('g').attr('class', 'layer-munis');
    gPrefBorders = gRoot.append('g').attr('class', 'layer-pref-borders');
    gOverlay = gRoot.append('g').attr('class', 'layer-overlay');

    const topo = window.JAPAN_TOPO_DATA;
    const objKey = Object.keys(topo.objects)[0];
    const rawGeoms = topo.objects[objKey].geometries;

    // Group raw geometries by muni_code and merge designated city wards into unified features
    const geomsByMuni = new Map();
    const geomsByPref = new Map();

    rawGeoms.forEach((g) => {
      const mc = g.properties.muni_code;
      if (!geomsByMuni.has(mc)) geomsByMuni.set(mc, []);
      geomsByMuni.get(mc).push(g);

      const muni = muniByCode.get(mc);
      if (muni) {
        if (!geomsByPref.has(muni.p)) geomsByPref.set(muni.p, []);
        geomsByPref.get(muni.p).push(g);
      }
    });

    const unifiedFeatures = [];
    geomsByMuni.forEach((geomList, mc) => {
      let mergedGeom;
      if (geomList.length === 1) {
        mergedGeom = geomList[0];
      } else {
        mergedGeom = topojson.mergeArcs(topo, geomList);
      }
      const feat = topojson.feature(topo, {
        type: 'GeometryCollection',
        geometries: [mergedGeom]
      }).features[0];
      fixWindingIfInverted(feat);
      feat.properties = { muni_code: mc };
      unifiedFeatures.push(feat);
      featureByCode.set(mc, feat);
    });

    // Build prefecture border multi-polygons for clean visual separation
    const prefFeatures = [];
    geomsByPref.forEach((geomList, prefCode) => {
      const mergedPref = topojson.merge(topo, geomList);
      const pFeat = {
        type: 'Feature',
        properties: { pref: prefCode },
        geometry: mergedPref
      };
      fixWindingIfInverted(pFeat);
      prefFeatures.push(pFeat);
    });

    // Configure Mercator projection centered on Japan
    projection = d3.geoMercator()
      .center([137.0, 38.2])
      .scale(Math.min(mapWidth, mapHeight) * 2.45)
      .translate([mapWidth * 0.5, mapHeight * 0.48]);

    pathGenerator = d3.geoPath().projection(projection);

    // Precompute screen centroids for radar overlay
    muniList.forEach((m) => {
      const feat = featureByCode.get(m.c);
      let pt = null;
      if (feat) {
        const c = pathGenerator.centroid(feat);
        if (c && !isNaN(c[0]) && !isNaN(c[1])) {
          pt = c;
        }
      }
      if (!pt) {
        pt = projection([m.lon, m.lat]);
      }
      pixelCentroidByCode.set(m.c, pt);
    });

    // Draw all 1,747 municipality polygons
    const tooltip = document.getElementById('map-tooltip');

    gMunis.selectAll('path.muni-path')
      .data(unifiedFeatures, (d) => d.properties.muni_code)
      .enter()
      .append('path')
      .attr('class', 'muni-path')
      .attr('fill', '#ffffff')
      .attr('d', pathGenerator)
      .each(function (d) {
        pathSelectionByCode.set(d.properties.muni_code, d3.select(this));
      })
      .on('mouseenter', function (event, d) {
        const mc = d.properties.muni_code;
        const muni = muniByCode.get(mc);
        if (!muni) return;
        const isConq = state.conquered.has(mc);
        tooltip.style.display = 'block';
        if (isConq) {
          tooltip.innerHTML = `🚩 【占領済】 ${muni.pn} ${muni.g ? muni.g + ' ' : ''}${muni.n}（${muni.k}）`;
        } else {
          tooltip.innerHTML = `⚔️ 【未占領】 ${muni.pn} ${muni.g ? muni.g + ' ' : ''}（クリックでこの地域に出撃！）`;
        }
      })
      .on('mousemove', function (event) {
        tooltip.style.left = (event.clientX + 14) + 'px';
        tooltip.style.top = (event.clientY + 14) + 'px';
      })
      .on('mouseleave', function () {
        tooltip.style.display = 'none';
      })
      .on('click', function (event, d) {
        event.stopPropagation();
        const mc = d.properties.muni_code;
        const muni = muniByCode.get(mc);
        if (!muni) return;
        state.lastConqueredCode = mc;
        startQuizForMunicipality(muni, true);
      });

    // Draw prefecture borders
    gPrefBorders.selectAll('path.pref-border-mesh')
      .data(prefFeatures)
      .enter()
      .append('path')
      .attr('class', 'pref-border-mesh')
      .attr('d', pathGenerator);

    // Setup Zoom & Pan
    zoomBehavior = d3.zoom()
      .scaleExtent([0.85, 65])
      .on('zoom', (event) => {
        gRoot.attr('transform', event.transform);
      });

    svg.call(zoomBehavior);

    // Apply initial colors
    refreshAllMapColors();
  }

  function refreshAllMapColors() {
    muniList.forEach((muni) => {
      updateSingleMuniVisual(muni.c);
    });
  }

  function updateSingleMuniVisual(code) {
    const sel = pathSelectionByCode.get(code);
    const muni = muniByCode.get(code);
    if (!sel || !muni) return;

    const isTarget = state.currentQuiz && state.currentQuiz.muni.c === code;
    const isConq = state.conquered.has(code);

    sel.classed('active-target', Boolean(isTarget));
    sel.classed('conquered', isConq);

    if (isTarget) {
      sel.attr('fill', '#fde047').style('fill', '#fde047');
    } else if (isConq) {
      const fillCol = getMuniFillColor(muni);
      sel.attr('fill', fillCol).style('fill', fillCol);
    } else {
      sel.attr('fill', '#ffffff').style('fill', '#ffffff');
    }
  }

  function drawTargetRadarOverlay(muni) {
    gOverlay.selectAll('*').remove();
    if (!muni) return;

    const coords = pixelCentroidByCode.get(muni.c) || projection([muni.lon, muni.lat]);
    if (!coords) return;

    gOverlay.append('circle')
      .attr('class', 'target-radar-ring')
      .attr('cx', coords[0])
      .attr('cy', coords[1])
      .attr('r', 12);

    gOverlay.append('circle')
      .attr('class', 'target-crosshair')
      .attr('cx', coords[0])
      .attr('cy', coords[1])
      .attr('r', 4.5);
  }

  function focusMapOnMunicipality(muni, duration = 650) {
    if (!muni || !svg || !zoomBehavior) return;
    const feat = featureByCode.get(muni.c);
    let x, y, k = 8.5;

    if (feat) {
      const bounds = pathGenerator.bounds(feat);
      const dx = bounds[1][0] - bounds[0][0];
      const dy = bounds[1][1] - bounds[0][1];
      x = (bounds[0][0] + bounds[1][0]) / 2;
      y = (bounds[0][1] + bounds[1][1]) / 2;
      if (dx > 0 && dy > 0) {
        k = Math.max(4.5, Math.min(24, 0.28 / Math.max(dx / mapWidth, dy / mapHeight)));
      }
    } else {
      const pt = projection([muni.lon, muni.lat]);
      x = pt[0];
      y = pt[1];
    }

    const transform = d3.zoomIdentity
      .translate(mapWidth / 2, mapHeight / 2)
      .scale(k)
      .translate(-x, -y);

    svg.transition().duration(duration).call(zoomBehavior.transform, transform);
  }

  function jumpCameraToPreset(presetKey) {
    if (presetKey === 'ALL') {
      svg.transition().duration(600).call(zoomBehavior.transform, d3.zoomIdentity);
      return;
    }
    if (presetKey === 'TARGET') {
      if (state.currentQuiz && state.currentQuiz.muni) {
        focusMapOnMunicipality(state.currentQuiz.muni, 550);
      }
      return;
    }
    const preset = CAMERA_PRESETS[presetKey];
    if (!preset) return;
    const pt = projection([preset.lon, preset.lat]);
    const transform = d3.zoomIdentity
      .translate(mapWidth / 2, mapHeight / 2)
      .scale(preset.k)
      .translate(-pt[0], -pt[1]);
    svg.transition().duration(600).call(zoomBehavior.transform, transform);
  }

  // Filter eligible municipalities based on current region/prefecture filter
  function getFilteredPool(onlyUnconquered = true) {
    const rf = state.regionFilter;
    let pool = muniList;

    if (rf.startsWith('REG_')) {
      const allowedPrefs = new Set(REGION_MAP[rf] || []);
      pool = pool.filter((m) => allowedPrefs.has(m.p));
    } else if (rf.startsWith('PREF_')) {
      const prefNum = parseInt(rf.replace('PREF_', ''), 10);
      pool = pool.filter((m) => m.p === prefNum);
    }

    if (onlyUnconquered) {
      const unconq = pool.filter((m) => !state.conquered.has(m.c));
      if (unconq.length > 0) return unconq;
      const allUnconq = muniList.filter((m) => !state.conquered.has(m.c));
      if (allUnconq.length > 0) return allUnconq;
    }
    return pool;
  }

  // Squared geographic distance helper
  function geoDistSq(m1, m2) {
    const dLat = m1.lat - m2.lat;
    const dLon = (m1.lon - m2.lon) * 0.82;
    return dLat * dLat + dLon * dLon;
  }

  // Pick next target municipality according to strategy (with high geographic dispersion in 'random' mode)
  function selectNextTargetMuni() {
    const pool = getFilteredPool(true);
    if (pool.length === 0) return muniList[0];

    if (state.attackOrder === 'north_to_south') {
      let best = pool[0];
      for (let i = 1; i < pool.length; i++) {
        if (pool[i].lat > best.lat) best = pool[i];
      }
      return best;
    }

    if (state.attackOrder === 'neighbor' && state.lastConqueredCode) {
      const anchor = muniByCode.get(state.lastConqueredCode);
      if (anchor) {
        const sorted = pool
          .map((m) => ({ m, d: geoDistSq(anchor, m) }))
          .sort((a, b) => a.d - b.d);
        const topK = Math.min(3, sorted.length);
        return sorted[Math.floor(Math.random() * topK)].m;
      }
    }

    // High-randomness selection: avoid repeating recently asked prefectures and avoid nearby municipalities
    const lastMuni = state.lastAskedCode ? muniByCode.get(state.lastAskedCode) : null;
    const recentPrefSet = new Set(state.recentAskedPrefs.slice(0, 6));

    // Group available pool by prefecture so prefectures with huge counts (like Hokkaido) don't dominate
    const byPref = new Map();
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      if (!byPref.has(m.p)) byPref.set(m.p, []);
      byPref.get(m.p).push(m);
    }

    let candidatePrefs = Array.from(byPref.keys());
    const freshPrefs = candidatePrefs.filter((p) => !recentPrefSet.has(p));
    if (freshPrefs.length > 0) {
      candidatePrefs = freshPrefs;
    }

    const chosenPref = candidatePrefs[Math.floor(Math.random() * candidatePrefs.length)];
    let muniCandidates = byPref.get(chosenPref) || pool;

    // Also if possible, pick one that is not right next to the previous question
    if (lastMuni && muniCandidates.length > 1) {
      const distant = muniCandidates.filter((m) => m.c !== lastMuni.c && geoDistSq(lastMuni, m) > 0.25);
      if (distant.length > 0) {
        muniCandidates = distant;
      }
    }

    return muniCandidates[Math.floor(Math.random() * muniCandidates.length)];
  }

  // Levenshtein Edit Distance for Kana Strings
  function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = new Array(m + 1);
    for (let i = 0; i <= m; i++) {
      dp[i] = new Array(n + 1);
      dp[i][0] = i;
    }
    for (let j = 1; j <= n; j++) {
      dp[0][j] = j;
    }
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  // Score phonetic similarity ("似たよみがな") between target and candidate municipality
  function computeKanaSimilarityScore(target, cand) {
    const s1 = target.stemKana;
    const s2 = cand.stemKana;
    const b1 = target.baseKana;
    const b2 = cand.baseKana;
    let score = 0;

    // 1. Same administrative suffix type (市/町/村/区)
    if (target.t === cand.t) {
      score += 35;
    }

    // 2. Prefix reading match (first 1-2 kana of stem)
    if (s1.length >= 2 && s2.length >= 2 && s1.slice(0, 2) === s2.slice(0, 2)) {
      score += 48;
    } else if (s1[0] === s2[0]) {
      score += 24;
    } else if (b1[0] === b2[0]) {
      score += 15;
    }

    // 3. Ending reading of stem match (last 1-2 kana of stem)
    if (s1.length >= 2 && s2.length >= 2 && s1.slice(-2) === s2.slice(-2)) {
      score += 38;
    } else if (s1.slice(-1) === s2.slice(-1)) {
      score += 16;
    } else if (b1.slice(-1) === b2.slice(-1)) {
      score += 10;
    }

    // 4. Kana Levenshtein Edit Distance closeness (exact & unvoiced base)
    const dist = editDistance(s1, s2);
    const baseDist = editDistance(b1, b2);
    score += Math.max(0, 42 - dist * 11);
    score += Math.max(0, 26 - baseDist * 8);

    // 5. Shared Kanji character in stem (e.g. 日吉津村 vs 日高村, 占冠村 vs 新冠町)
    for (let i = 0; i < target.stemKanji.length; i++) {
      if (cand.stemKanji.indexOf(target.stemKanji[i]) !== -1) {
        score += 18;
      }
    }

    return score;
  }

  // 4-Choice Distractor Generator prioritizing similar readings (似たよみがな) with nationwide variety
  function generateChoices(targetMuni, direction) {
    const isKanjiToKana = direction === 'kanji2kana';
    const correctLabel = isKanjiToKana ? targetMuni.k : targetMuni.n;
    const usedLabels = new Set([correctLabel]);

    // Score all other municipalities by phonetic similarity
    const scoredCandidates = [];
    for (let i = 0; i < muniList.length; i++) {
      const cand = muniList[i];
      if (cand.c === targetMuni.c) continue;
      if (cand.k === targetMuni.k || cand.n === targetMuni.n) continue;

      const label = isKanjiToKana ? cand.k : cand.n;
      if (usedLabels.has(label)) continue;

      scoredCandidates.push({
        muni: cand,
        label,
        score: computeKanaSimilarityScore(targetMuni, cand) + Math.random() * 6
      });
    }

    // Sort descending by phonetic similarity score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // Pick 3 distractors from the top 16 most phonetically similar candidates
    const topPool = scoredCandidates.slice(0, 16);
    const distractors = [];

    while (distractors.length < 3 && topPool.length > 0) {
      const idx = Math.floor(Math.random() * Math.min(topPool.length, 10));
      const picked = topPool.splice(idx, 1)[0];
      if (!usedLabels.has(picked.label)) {
        usedLabels.add(picked.label);
        distractors.push(picked);
      }
    }

    const allChoices = [
      { label: correctLabel, muni: targetMuni, isCorrect: true },
      ...distractors.map((d) => ({ label: d.label, muni: d.muni, isCorrect: false }))
    ];

    // Fisher-Yates shuffle
    for (let i = allChoices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = allChoices[i];
      allChoices[i] = allChoices[j];
      allChoices[j] = tmp;
    }

    const correctIndex = allChoices.findIndex((c) => c.isCorrect);
    return { choices: allChoices, correctIndex };
  }

  // Launch a Quiz Question
  function startQuizForMunicipality(muni, forceFocus = false) {
    if (state.autoNextTimer) {
      clearTimeout(state.autoNextTimer);
      state.autoNextTimer = null;
    }

    const prevTargetCode = state.currentQuiz ? state.currentQuiz.muni.c : null;

    // Record asked history so subsequent random questions spread across Japan
    state.lastAskedCode = muni.c;
    state.recentAskedPrefs = [muni.p, ...state.recentAskedPrefs.filter((p) => p !== muni.p)].slice(0, 10);

    let direction = state.questionMode;
    if (direction === 'mixed') {
      direction = Math.random() < 0.5 ? 'kanji2kana' : 'kana2kanji';
    }

    const { choices, correctIndex } = generateChoices(muni, direction);

    state.currentQuiz = {
      muni,
      direction,
      choices,
      correctIndex,
      answered: false
    };

    if (prevTargetCode) updateSingleMuniVisual(prevTargetCode);
    updateSingleMuniVisual(muni.c);
    drawTargetRadarOverlay(muni);

    if (forceFocus || state.autoZoom) {
      focusMapOnMunicipality(muni, 620);
    }

    renderQuizUI();
    updatePrefProgressIndicator(muni.p);
  }

  function nextQuestion() {
    const nextMuni = selectNextTargetMuni();
    startQuizForMunicipality(nextMuni, false);
  }

  function renderQuizUI() {
    const q = state.currentQuiz;
    if (!q) return;
    const { muni, direction, choices } = q;

    document.getElementById('quiz-pref-badge').textContent = `${muni.pn}（${muni.pk}）`;
    document.getElementById('quiz-gun-badge').textContent = muni.g ? `📍 ${muni.g}` : '';
    document.getElementById('quiz-streak-badge').textContent = `🔥 ${state.streak}連勝`;

    const dirEl = document.getElementById('quiz-direction-label');
    const wordEl = document.getElementById('quiz-target-word');
    const subEl = document.getElementById('quiz-target-sub');

    const alreadyConquered = state.conquered.has(muni.c);

    if (direction === 'kanji2kana') {
      dirEl.textContent = '【漢字 → よみがな】この市区町村の正しい「よみがな」は？';
      wordEl.textContent = muni.n;
      subEl.textContent = alreadyConquered
        ? '🚩 占領済みの地域（復習モード）'
        : `正解して「${muni.pn} ${muni.n}」を白地図から占領せよ！`;
    } else {
      dirEl.textContent = '【よみがな → 漢字】この市区町村の正しい「漢字表記」は？';
      wordEl.textContent = muni.k;
      subEl.textContent = alreadyConquered
        ? '🚩 占領済みの地域（復習モード）'
        : `${muni.pn}${muni.g ? ' ' + muni.g : ''} にある「${muni.k}」の漢字はどれ？`;
    }

    const buttons = document.querySelectorAll('#choices-grid .choice-btn');
    buttons.forEach((btn, idx) => {
      btn.disabled = false;
      btn.classList.remove('correct', 'wrong');
      const labelSpan = btn.querySelector('.choice-label-text');
      labelSpan.textContent = choices[idx] ? choices[idx].label : '-';
    });

    const fb = document.getElementById('quiz-feedback');
    fb.className = 'quiz-feedback';
    document.getElementById('feedback-text').textContent =
      '💡 [1]〜[4]キーで回答 ／ 地図上の白い地域をクリックで直接進軍！';
    const skipBtn = document.getElementById('btn-skip-target');
    skipBtn.textContent = '目標変更 ↻';
  }

  // Handle Player Answer Selection
  function handleChoiceSelection(selectedIndex) {
    const q = state.currentQuiz;
    if (!q || q.answered) return;
    q.answered = true;

    const isCorrect = selectedIndex === q.correctIndex;
    const muni = q.muni;
    state.totalAnswered += 1;

    const buttons = document.querySelectorAll('#choices-grid .choice-btn');
    buttons.forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === q.correctIndex) {
        btn.classList.add('correct');
      } else if (idx === selectedIndex && !isCorrect) {
        btn.classList.add('wrong');
      }
    });

    const fb = document.getElementById('quiz-feedback');
    const fbText = document.getElementById('feedback-text');
    const skipBtn = document.getElementById('btn-skip-target');
    skipBtn.textContent = '次の地域へ ▶';

    if (isCorrect) {
      state.totalCorrect += 1;
      state.streak += 1;
      if (state.streak > state.maxStreak) state.maxStreak = state.streak;

      captureSingleMunicipality(muni);

      playSound('correct');
      fb.className = 'quiz-feedback is-correct';
      fbText.textContent = `⭕ 正解！ ${muni.pn}「${muni.n}（${muni.k}）」を占領！`;

      saveState();
      updateHUD();
      updatePrefProgressIndicator(muni.p);
      renderRecentLog();

      state.autoNextTimer = setTimeout(() => {
        nextQuestion();
      }, 950);
    } else {
      state.streak = 0;
      playSound('wrong');
      fb.className = 'quiz-feedback is-wrong';
      fbText.textContent = `❌ 残念！ 正解は「${muni.n}（${muni.k}）」でした。`;
      saveState();
      updateHUD();
    }

    document.getElementById('quiz-streak-badge').textContent = `🔥 ${state.streak}連勝`;
  }

  function captureSingleMunicipality(primaryMuni) {
    // Clear active target highlight on primaryMuni before applying conquered color so it shows immediately
    if (state.currentQuiz && state.currentQuiz.muni.c === primaryMuni.c) {
      state.currentQuiz.muni = { ...primaryMuni, c: '' };
    }

    const wasConquered = state.conquered.has(primaryMuni.c);
    state.conquered.add(primaryMuni.c);
    state.lastConqueredCode = primaryMuni.c;
    updateSingleMuniVisual(primaryMuni.c);

    if (!wasConquered) {
      state.recentCodes = [primaryMuni.c, ...state.recentCodes.filter((c) => c !== primaryMuni.c)].slice(0, 14);

      const list = munisByPref.get(primaryMuni.p) || [];
      if (list.length > 0 && list.every((m) => state.conquered.has(m.c))) {
        showConquestToast(`🎉 【${prefNames.get(primaryMuni.p)} 完全制覇！】 全${list.length}市区町村を統一しました！`);
        playSound('fanfare');
      }

      if (state.conquered.size === muniList.length) {
        showConquestToast(`👑 【日本全国・天下統一達成！】 全${muniList.length}市区町村を完全制覇しました！`);
        playSound('fanfare');
      }
    }
  }

  let toastTimer = null;
  function showConquestToast(message) {
    const toast = document.getElementById('conquest-toast');
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
  }

  function updateHUD() {
    const total = muniList.length;
    const conq = state.conquered.size;
    const pct = total > 0 ? ((conq / total) * 100).toFixed(2) : '0.00';

    let completedPrefs = 0;
    munisByPref.forEach((list) => {
      if (list.every((m) => state.conquered.has(m.c))) completedPrefs += 1;
    });

    const acc = state.totalAnswered > 0
      ? Math.round((state.totalCorrect / state.totalAnswered) * 100)
      : 100;

    document.getElementById('hud-conquest-stat').textContent =
      `占領: ${conq.toLocaleString()} / ${total.toLocaleString()} 市区町村 (${pct}%)`;
    document.getElementById('hud-pref-stat').textContent =
      `都道府県制覇: ${completedPrefs} / 47 ｜ 正解率: ${acc}%`;
    document.getElementById('hud-progress-fill').style.width = `${Math.min(100, (conq / total) * 100)}%`;
    document.getElementById('hud-rank-pill').textContent = `称号: ${getRankTitle(conq)}`;
  }

  function updatePrefProgressIndicator(prefCode) {
    const list = munisByPref.get(prefCode) || [];
    const done = list.filter((m) => state.conquered.has(m.c)).length;
    const pName = prefNames.get(prefCode) || '';
    document.getElementById('current-pref-progress').textContent =
      `${pName}: ${done} / ${list.length} 占領`;
  }

  function renderRecentLog() {
    const container = document.getElementById('recent-log-items');
    if (state.recentCodes.length === 0) {
      container.innerHTML =
        '<span style="font-size: 11px; color: #64748b;">まだ占領した地域はありません。クイズに正解して最初の領土を獲得しましょう！</span>';
      return;
    }
    container.innerHTML = '';
    state.recentCodes.forEach((code) => {
      const m = muniByCode.get(code);
      if (!m) return;
      const chip = document.createElement('span');
      chip.className = 'log-chip';
      chip.textContent = `${m.pn} ${m.n}（${m.k}）`;
      chip.title = 'クリックして地図上でフォーカス';
      chip.addEventListener('click', () => {
        focusMapOnMunicipality(m, 550);
      });
      container.appendChild(chip);
    });
  }

  // Populate Prefecture Dropdowns & Dex Modal
  function initSelectorsAndModals() {
    const optGroup = document.getElementById('optgroup-prefectures');
    const dexPrefSelect = document.getElementById('dex-pref-select');

    for (let p = 1; p <= 47; p++) {
      const pName = prefNames.get(p);
      const list = munisByPref.get(p) || [];
      const opt1 = document.createElement('option');
      opt1.value = `PREF_${p}`;
      opt1.textContent = `${pName}（${list.length}市区町村）`;
      optGroup.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = String(p);
      opt2.textContent = `${pName}（${list.length}）`;
      dexPrefSelect.appendChild(opt2);
    }

    // Question Mode Segmented Buttons
    const modeBtns = document.querySelectorAll('#question-mode-group .seg-btn');
    modeBtns.forEach((btn) => {
      if (btn.dataset.mode === state.questionMode) btn.classList.add('active');
      else btn.classList.remove('active');

      btn.addEventListener('click', () => {
        modeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.questionMode = btn.dataset.mode;
        saveState();
        if (state.currentQuiz && state.currentQuiz.muni && state.currentQuiz.muni.c) {
          startQuizForMunicipality(state.currentQuiz.muni, false);
        }
      });
    });

    // Region Filter
    document.getElementById('select-region-filter').addEventListener('change', (e) => {
      state.regionFilter = e.target.value;
      nextQuestion();
    });

    // Attack Order
    const orderSel = document.getElementById('select-attack-order');
    orderSel.value = state.attackOrder;
    orderSel.addEventListener('change', (e) => {
      state.attackOrder = e.target.value;
      nextQuestion();
    });

    // Color Theme
    const themeSel = document.getElementById('select-color-theme');
    themeSel.value = state.colorTheme;
    themeSel.addEventListener('change', (e) => {
      state.colorTheme = e.target.value;
      saveState();
      refreshAllMapColors();
    });

    // Auto-Zoom Checkbox
    document.getElementById('chk-auto-zoom').addEventListener('change', (e) => {
      state.autoZoom = e.target.checked;
    });

    // Choice Buttons Click
    document.querySelectorAll('#choices-grid .choice-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        handleChoiceSelection(idx);
      });
    });

    // Keyboard Shortcuts (1, 2, 3, 4, Enter/Space for Next)
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (['1', '2', '3', '4'].includes(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        handleChoiceSelection(idx);
      } else if ((e.key === 'Enter' || e.key === ' ') && state.currentQuiz && state.currentQuiz.answered) {
        e.preventDefault();
        nextQuestion();
      }
    });

    // Skip / Next Button
    document.getElementById('btn-skip-target').addEventListener('click', () => {
      nextQuestion();
    });

    // Camera Jump Buttons
    document.querySelectorAll('.region-jump-bar .jump-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        jumpCameraToPreset(btn.dataset.jump);
      });
    });

    // Bottom-Right Zoom Buttons
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.6);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      svg.transition().duration(250).call(zoomBehavior.scaleBy, 0.62);
    });
    document.getElementById('btn-zoom-target').addEventListener('click', () => {
      jumpCameraToPreset('TARGET');
    });
    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      jumpCameraToPreset('ALL');
    });

    // Sound Toggle
    document.getElementById('btn-toggle-sound').addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      document.getElementById('sound-icon').textContent = state.soundEnabled ? '🔊 音ON' : '🔇 音OFF';
    });

    // Dex Modal Open/Close & Filtering
    const dexModal = document.getElementById('modal-dex');
    document.getElementById('btn-open-dex').addEventListener('click', () => {
      renderDexModal();
      dexModal.classList.add('open');
    });
    document.getElementById('btn-close-dex').addEventListener('click', () => {
      dexModal.classList.remove('open');
    });
    document.getElementById('dex-search-input').addEventListener('input', () => {
      renderDexMunicipalityList();
    });
    document.getElementById('dex-pref-select').addEventListener('change', () => {
      renderDexMunicipalityList();
    });

    // Settings Modal
    const settingsModal = document.getElementById('modal-settings');
    document.getElementById('btn-open-settings').addEventListener('click', () => {
      renderSettingsStats();
      settingsModal.classList.add('open');
    });
    document.getElementById('btn-close-settings').addEventListener('click', () => {
      settingsModal.classList.remove('open');
    });

    document.getElementById('btn-export-save').addEventListener('click', () => {
      const code = btoa(unescape(encodeURIComponent(localStorage.getItem(STORAGE_KEY) || '{}')));
      const area = document.getElementById('save-code-textarea');
      area.value = code;
      area.select();
    });

    document.getElementById('btn-import-save').addEventListener('click', () => {
      const rawCode = document.getElementById('save-code-textarea').value.trim();
      if (!rawCode) return;
      try {
        const jsonStr = decodeURIComponent(escape(atob(rawCode)));
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.c)) {
          applyParsedSaveData(parsed);
          saveState();
          refreshAllMapColors();
          updateHUD();
          renderRecentLog();
          renderSettingsStats();
          alert(`セーブデータを復元しました！（占領数: ${state.conquered.size} 市区町村）`);
        } else {
          alert('セーブデータコードの形式が正しくありません。');
        }
      } catch (err) {
        alert('セーブデータコードの形式が正しくありません。');
      }
    });

    document.getElementById('btn-reset-data').addEventListener('click', () => {
      if (confirm('本当にすべての占領データをリセットして白地図の状態に戻しますか？')) {
        localStorage.removeItem(STORAGE_KEY);
        state.conquered.clear();
        state.streak = 0;
        state.maxStreak = 0;
        state.totalAnswered = 0;
        state.totalCorrect = 0;
        state.recentCodes = [];
        state.lastConqueredCode = null;
        refreshAllMapColors();
        updateHUD();
        renderRecentLog();
        settingsModal.classList.remove('open');
        nextQuestion();
      }
    });
  }

  function renderDexModal() {
    const prefGrid = document.getElementById('dex-pref-grid');
    prefGrid.innerHTML = '';

    for (let p = 1; p <= 47; p++) {
      const list = munisByPref.get(p) || [];
      const conqCount = list.filter((m) => state.conquered.has(m.c)).length;
      const pct = list.length > 0 ? Math.round((conqCount / list.length) * 100) : 0;
      const isComplete = conqCount === list.length && list.length > 0;

      const card = document.createElement('div');
      card.className = 'pref-stat-card' + (isComplete ? ' complete' : '');
      card.innerHTML = `
        <div class="pref-card-top">
          <span>${isComplete ? '👑 ' : ''}${prefNames.get(p)}</span>
          <span style="color:${isComplete ? '#fde047' : '#93c5fd'};">${conqCount}/${list.length} (${pct}%)</span>
        </div>
        <div class="pref-mini-bar">
          <div class="pref-mini-fill" style="width:${pct}%;background:${PREF_COLORS[(p - 1) % PREF_COLORS.length]};"></div>
        </div>
      `;
      card.addEventListener('click', () => {
        document.getElementById('dex-pref-select').value = String(p);
        renderDexMunicipalityList();
      });
      prefGrid.appendChild(card);
    }

    renderDexMunicipalityList();
  }

  function renderDexMunicipalityList() {
    const query = document.getElementById('dex-search-input').value.trim().toLowerCase();
    const prefVal = document.getElementById('dex-pref-select').value;
    const grid = document.getElementById('dex-muni-grid');
    const titleEl = document.getElementById('dex-muni-section-title');

    let filtered = muniList;
    if (prefVal !== 'ALL') {
      const pNum = parseInt(prefVal, 10);
      filtered = filtered.filter((m) => m.p === pNum);
    }
    if (query) {
      filtered = filtered.filter(
        (m) =>
          m.n.includes(query) ||
          m.k.includes(query) ||
          m.pn.includes(query) ||
          (m.g && m.g.includes(query))
      );
    }

    const shown = filtered.slice(0, 250);
    titleEl.textContent = `市区町村一覧（該当: ${filtered.length}件${filtered.length > 250 ? ' ※先頭250件を表示' : ''}）— クリックでその地域に出撃！`;

    grid.innerHTML = '';
    shown.forEach((m) => {
      const isConq = state.conquered.has(m.c);
      const item = document.createElement('div');
      item.className = 'muni-item-card' + (isConq ? ' is-conquered' : '');
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;">
          <span>${m.pn}${m.g ? ' ' + m.g : ''}</span>
          <span>${isConq ? '🚩 占領済' : '⚔️ 未占領'}</span>
        </div>
        <div class="muni-item-kanji">${m.n}</div>
        <div class="muni-item-kana">${m.k}</div>
      `;
      item.addEventListener('click', () => {
        document.getElementById('modal-dex').classList.remove('open');
        state.lastConqueredCode = m.c;
        startQuizForMunicipality(m, true);
      });
      grid.appendChild(item);
    });
  }

  function renderSettingsStats() {
    const total = muniList.length;
    const conq = state.conquered.size;
    const pct = ((conq / total) * 100).toFixed(2);
    const acc = state.totalAnswered > 0
      ? ((state.totalCorrect / state.totalAnswered) * 100).toFixed(1)
      : '100.0';

    document.getElementById('settings-stats-summary').innerHTML = `
      ・現在の称号：<strong>${getRankTitle(conq)}</strong><br/>
      ・全国占領数：<strong>${conq.toLocaleString()} / ${total.toLocaleString()} 市区町村 (${pct}%)</strong><br/>
      ・通算クイズ回答数：<strong>${state.totalAnswered} 問（正解 ${state.totalCorrect} 問 / 正解率 ${acc}%）</strong><br/>
      ・最高連勝記録：<strong>🔥 ${state.maxStreak} 連勝</strong>
    `;
  }

  // Boot Application
  window.addEventListener('DOMContentLoaded', () => {
    loadState();
    initSelectorsAndModals();
    initMap();
    updateHUD();
    renderRecentLog();
    nextQuestion();
  });
})();
