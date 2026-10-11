# Buduje bazę adresów (PRG, Geoportal) dla Zielonej Góry i powiatu zielonogórskiego.
# Wejście: katalog z rozpakowanym POLSKA.zip (SHP punktów adresowych). Wyjście: data/adresy-zg.json + data/adresy-info.txt
import sys, os, json, glob, collections
import shapefile
from pyproj import Transformer

src = sys.argv[1]
shp = [p for p in glob.glob(os.path.join(src, '**', '*.shp'), recursive=True) if 'PunktyAdresowe' in os.path.basename(p)]
info = [f'pliki SHP: {shp}']
POW = {'zielona góra', 'zielonogórski', 'powiat zielona góra', 'powiat zielonogórski'}
out_towns, out_streets, out_codes, rows = {}, {}, {}, []
def idx(d, v):
    if v not in d: d[v] = len(d)
    return d[v]
for path in shp:
    r = shapefile.Reader(path, encoding='utf-8')
    names = [f[0] for f in r.fields[1:]]
    info.append(f'{os.path.basename(path)}: pola {names}, rekordów {len(r)}, prj: {open(path[:-4] + ".prj").read()[:120] if os.path.exists(path[:-4] + ".prj") else "?"}')
    low = [n.lower() for n in names]
    def col(*keys):
        for k in keys:
            for i, n in enumerate(low):
                if k in n: return i
        return None
    c_pow, c_gm, c_tw, c_st, c_nr, c_kod, c_teryt = col('powiat', 'pow'), col('gmina'), col('miejscowo', 'msc'), col('ulica', 'ulc', 'ul_'), col('numer', 'nr'), col('kod', 'pna'), col('teryt', 'terc')
    info.append(f'kolumny: powiat={c_pow} gmina={c_gm} miejscowosc={c_tw} ulica={c_st} numer={c_nr} kod={c_kod} teryt={c_teryt}')
    sample_shown = 0
    tr = None
    for sr in r.iterShapeRecords():
        rec = sr.record
        if sample_shown < 3: info.append('przykład: ' + repr(list(rec))[:400]); sample_shown += 1
        powv = str(rec[c_pow]).strip().lower() if c_pow is not None else ''
        terv = str(rec[c_teryt]) if c_teryt is not None else ''
        if not (powv in POW or terv.startswith('0862') or terv.startswith('0809')): continue
        if not sr.shape.points: continue
        x, y = sr.shape.points[0]
        if tr is None:
            tr = Transformer.from_crs('EPSG:2180', 'EPSG:4326', always_xy=True) if x > 1000 else False
        lng, lat = tr.transform(x, y) if tr else (x, y)
        town = str(rec[c_tw]).strip() if c_tw is not None else ''
        street = str(rec[c_st]).strip() if c_st is not None else ''
        nr = str(rec[c_nr]).strip() if c_nr is not None else ''
        kod = str(rec[c_kod]).strip() if c_kod is not None else ''
        if not nr: continue
        rows.append([idx(out_towns, town), idx(out_streets, street), nr, idx(out_codes, kod), round(lat, 6), round(lng, 6)])
os.makedirs('data', exist_ok=True)
res = {'src': 'PRG – punkty adresowe (Geoportal, GUGiK), dane bezpłatne do dowolnego wykorzystania', 'cols': ['miejscowosc', 'ulica', 'numer', 'kod', 'lat', 'lng'],
       'towns': list(out_towns), 'streets': list(out_streets), 'codes': list(out_codes), 'a': rows}
json.dump(res, open('data/adresy-zg.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
cnt = collections.Counter(res['towns'][r[0]] for r in rows)
info.append(f'adresów: {len(rows)}, miejscowości: {len(out_towns)}, ulic: {len(out_streets)}, kodów: {len(out_codes)}')
info.append('najwięcej: ' + ', '.join(f'{k} {v}' for k, v in cnt.most_common(15)))
info.append(f'rozmiar JSON: {os.path.getsize("data/adresy-zg.json")} B')
open('data/adresy-info.txt', 'w', encoding='utf-8').write('\n'.join(info) + '\n')
print('\n'.join(info))
