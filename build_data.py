import os
import json
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(BASE_DIR, 'gov_codes.json'), 'r', encoding='utf-8') as f:
    gov = json.load(f)

with open(os.path.join(BASE_DIR, 'japan_topo_s0010.json'), 'r', encoding='utf-8') as f:
    topo = json.load(f)

cities_by_code5 = {}
cities_by_pref_name = {}

northern_6 = {'01695', '01696', '01697', '01698', '01699', '01700'}

for item in gov:
    c5 = item['code'][:5]
    if c5 in northern_6:
        continue
    if item['type'] == 'city':
        cities_by_code5[c5] = item
        cities_by_pref_name[(item['pref_name'], item['city_name'])] = item

geoms = topo['objects']['N03-21_210101']['geometries']
gun_by_code5 = {}
clean_geoms = []

for g in geoms:
    p = g.get('properties', {})
    c5 = p.get('N03_007')
    if not c5 or c5 in northern_6 or not g.get('type'):
        continue
    pref = p.get('N03_001')
    n3 = p.get('N03_003')
    if n3 and n3.endswith('市'):
        city_item = cities_by_pref_name.get((pref, n3))
        muni_code = city_item['code'][:5]
    else:
        muni_code = c5
        if n3 and (n3.endswith('郡') or n3.endswith('支庁') or n3.endswith('振興局')):
            gun_by_code5[muni_code] = n3
    p['muni_code'] = muni_code
    clean_geoms.append(g)

topo['objects']['N03-21_210101']['geometries'] = clean_geoms

youon_fixes = {
    '06428': 'しょうないまち',
    '10421': 'なかのじょうまち',
    '11206': 'ぎょうだし',
    '11211': 'ほんじょうし',
    '11216': 'はにゅうし',
    '12403': 'くじゅうくりまち',
    '12443': 'おんじゅくまち',
    '12463': 'きょなんまち',
    '25384': 'りゅうおうちょう',
    '27229': 'しじょうなわてし',
    '29426': 'こうりょうちょう',
    '33208': 'そうじゃし',
    '33586': 'しんじょうそん',
    '47326': 'ちゃたんちょう',
}

sx, sy = topo['transform']['scale']
tx, ty = topo['transform']['translate']
arc_coords = []
for arc in topo['arcs']:
    x, y = 0, 0
    pts = []
    for dx, dy in arc:
        x += dx
        y += dy
        pts.append((x * sx + tx, y * sy + ty))
    arc_coords.append(pts)

muni_pts = defaultdict(list)
for g in clean_geoms:
    mc = g['properties']['muni_code']
    gtype = g['type']
    arcs = g['arcs']
    rings = arcs if gtype == 'Polygon' else [r for poly in arcs for r in poly]
    for ring in rings:
        for a_idx in ring:
            idx = ~a_idx if a_idx < 0 else a_idx
            muni_pts[mc].extend(arc_coords[idx])

municipalities = []
for c5, item in sorted(cities_by_code5.items(), key=lambda x: x[0]):
    pref_code = int(item['pref_code'][:2])
    name = item['city_name']
    kana = youon_fixes.get(c5, item['city_kana'])
    gun = gun_by_code5.get(c5, '')
    if name.endswith('市'):
        mtype = '市'
    elif name.endswith('区'):
        mtype = '区'
    elif name.endswith('町'):
        mtype = '町'
    elif name.endswith('村'):
        mtype = '村'
    else:
        mtype = '他'

    pts = muni_pts.get(c5, [])
    if pts:
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        lon = round((min(lons) + max(lons)) / 2, 4)
        lat = round((min(lats) + max(lats)) / 2, 4)
    else:
        lon, lat = 135.0, 35.0

    municipalities.append({
        'c': c5,
        'p': pref_code,
        'pn': item['pref_name'],
        'pk': item['pref_kana'],
        'g': gun,
        'n': name,
        'k': kana,
        't': mtype,
        'lon': lon,
        'lat': lat,
    })

with open(os.path.join(BASE_DIR, 'data.js'), 'w', encoding='utf-8') as f:
    f.write('// Auto-generated Japan Municipality Map & Reading Dataset (1,741 Municipalities)\n')
    f.write('window.JAPAN_TOPO_DATA = ')
    json.dump(topo, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\nwindow.JAPAN_MUNI_LIST = ')
    json.dump(municipalities, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')
