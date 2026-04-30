#!/usr/bin/env python3
import os, asyncio, json, urllib.request, urllib.parse, html
from pathlib import Path
from collections import Counter
import websockets

base_http = os.environ.get('SCREEPS_API_URL', 'https://screeps.com').rstrip('/')
base_ws = base_http.replace('https://', 'wss://').replace('http://', 'ws://')
tok = os.environ['SCREEPS_AUTH_TOKEN']
shard = os.environ.get('SCREEPS_SHARD', 'shardX')
room = os.environ.get('SCREEPS_ROOM', 'E48S29')
owner = 'lanyusea'

def get_json(path, params=None):
    url = base_http + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'X-Token': tok})
    return json.load(urllib.request.urlopen(req, timeout=20))

terrain = get_json('/api/game/room-terrain', {'room': room, 'shard': shard, 'encoded': '1'})['terrain'][0]['terrain']
userov = get_json('/api/user/overview')

async def get_room_event():
    async with websockets.connect(base_ws + '/socket/websocket', open_timeout=20) as ws:
        await ws.send('auth ' + tok)
        for _ in range(20):
            msg = await asyncio.wait_for(ws.recv(), timeout=20)
            if isinstance(msg, bytes):
                msg = msg.decode()
            if msg.startswith('auth '):
                break
        await ws.send(f'subscribe room:{shard}/{room}')
        for _ in range(40):
            msg = await asyncio.wait_for(ws.recv(), timeout=20)
            if isinstance(msg, bytes):
                msg = msg.decode()
            if msg.startswith('['):
                arr = json.loads(msg)
                if arr[0].startswith('room:'):
                    return arr[1]
        return {'objects': {}}

event = asyncio.run(get_room_event())
objs = event.get('objects', {})
counts = Counter(o.get('type', '?') for o in objs.values() if isinstance(o, dict))
creeps = [o for o in objs.values() if isinstance(o, dict) and o.get('type') == 'creep']
hostiles = []
for c in creeps:
    uname = (c.get('owner') or {}).get('username')
    if c.get('my') is False or (uname and uname != owner):
        hostiles.append(c)
spawn = next((o for o in objs.values() if isinstance(o, dict) and o.get('type') == 'spawn'), None)
controller = next((o for o in objs.values() if isinstance(o, dict) and o.get('type') == 'controller'), None)
sources = [o for o in objs.values() if isinstance(o, dict) and o.get('type') == 'source']
mineral = next((o for o in objs.values() if isinstance(o, dict) and o.get('type') == 'mineral'), None)
gametime = (userov.get('shards', {}).get(shard, {}).get('gametimes') or [None])[0]

W, H = 1600, 1120
cell = 18
map_x, map_y = 70, 130
map_w = map_h = 50 * cell
side_x = 1020
esc = lambda s: html.escape(str(s), quote=True)
svg = []
def add(s): svg.append(s)
def pct(a, b):
    try:
        return max(0, min(1, float(a) / float(b))) if b else 0
    except Exception:
        return 0

def center(o):
    return map_x + o.get('x', 0) * cell + cell / 2, map_y + o.get('y', 0) * cell + cell / 2

add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add("""
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a1020"/><stop offset="0.55" stop-color="#101b2e"/><stop offset="1" stop-color="#06110e"/></linearGradient>
<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#172238"/><stop offset="1" stop-color="#0d1424"/></linearGradient>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000" flood-opacity="0.45"/></filter>
<filter id="softGlow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<pattern id="swampPattern" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#405b34"/><path d="M0,8 L8,0" stroke="#5e7b47" stroke-width="1" opacity=".45"/></pattern>
<pattern id="wallPattern" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#2e3438"/><circle cx="2" cy="2" r="1" fill="#576066" opacity=".55"/><circle cx="7" cy="6" r="1.2" fill="#1d2226" opacity=".7"/></pattern>
<style>
.title{font:800 34px Inter,Segoe UI,Arial,sans-serif;fill:#eaf6ff;letter-spacing:.5px}.sub{font:500 15px Inter,Segoe UI,Arial,sans-serif;fill:#9fb5c9}.label{font:700 13px Inter,Segoe UI,Arial,sans-serif;fill:#dcecff}.tiny{font:600 10px Inter,Segoe UI,Arial,sans-serif;fill:#93a8bc}.coord{font:500 10px monospace;fill:#62788b}.num{font:800 28px Inter,Segoe UI,Arial,sans-serif;fill:#fff}.panelTitle{font:800 18px Inter,Segoe UI,Arial,sans-serif;fill:#dff7ff}.warn{fill:#ff5b63}.ok{fill:#65f0a5}.cyan{fill:#68d8ff}
</style>
</defs>
""")
add(f'<rect width="{W}" height="{H}" fill="url(#bg)"/>')
for x in range(0, W, 80):
    add(f'<path d="M{x} 0 V{H}" stroke="#18304a" stroke-opacity=".28"/>')
for y in range(0, H, 80):
    add(f'<path d="M0 {y} H{W}" stroke="#18304a" stroke-opacity=".28"/>')
add(f'<text class="title" x="70" y="58">Screeps Room Tactical Snapshot</text>')
add(f'<text class="sub" x="70" y="88">{esc(shard)}/{esc(room)} · owner {owner} · tick {gametime or "unknown"} · official-client API websocket + terrain endpoint</text>')
add(f'<rect x="{map_x-18}" y="{map_y-44}" width="{map_w+36}" height="{map_h+82}" rx="24" fill="url(#panel)" filter="url(#shadow)" stroke="#2c4863"/>')
add(f'<text class="panelTitle" x="{map_x}" y="{map_y-16}">Live room board</text>')
for y in range(50):
    for x in range(50):
        v = int(terrain[y * 50 + x])
        fill = 'url(#wallPattern)' if v & 1 else ('url(#swampPattern)' if v & 2 else '#172719')
        add(f'<rect x="{map_x+x*cell}" y="{map_y+y*cell}" width="{cell}" height="{cell}" fill="{fill}"/>')
for i in range(0, 51, 5):
    op = '.58' if i % 10 == 0 else '.32'
    sw = 1.2 if i % 10 == 0 else .8
    add(f'<path d="M{map_x+i*cell} {map_y} V{map_y+map_h}" stroke="#6a8297" stroke-opacity="{op}" stroke-width="{sw}"/>')
    add(f'<path d="M{map_x} {map_y+i*cell} H{map_x+map_w}" stroke="#6a8297" stroke-opacity="{op}" stroke-width="{sw}"/>')
    if i < 50:
        add(f'<text class="coord" x="{map_x+i*cell+4}" y="{map_y-5}">{i}</text>')
        add(f'<text class="coord" x="{map_x-24}" y="{map_y+i*cell+13}">{i}</text>')
add(f'<rect x="{map_x}" y="{map_y}" width="{map_w}" height="{map_h}" fill="none" stroke="#8fb8d9" stroke-width="2.2"/>')

for o in objs.values():
    if not isinstance(o, dict) or 'x' not in o or 'y' not in o: continue
    x, y = center(o); t = o.get('type')
    if t == 'road': add(f'<rect x="{x-5}" y="{y-5}" width="10" height="10" rx="2" fill="#8c8170" opacity=".85"/>')
    if t in ('constructedWall', 'rampart'):
        color = '#9aa0a7' if t == 'constructedWall' else '#2ce386'
        add(f'<rect x="{x-7}" y="{y-7}" width="14" height="14" fill="none" stroke="{color}" stroke-width="2" opacity=".9"/>')

for o in objs.values():
    if not isinstance(o, dict) or 'x' not in o or 'y' not in o: continue
    x, y = center(o); t = o.get('type')
    if t == 'source':
        add(f'<circle cx="{x}" cy="{y}" r="11" fill="#ffd84d" filter="url(#softGlow)" stroke="#fff2a5" stroke-width="2"/><path d="M{x} {y-14} L{x+5} {y-2} L{x+16} {y} L{x+5} {y+3} L{x} {y+15} L{x-5} {y+3} L{x-16} {y} L{x-5} {y-2} Z" fill="#ffcc28" opacity=".95"/>')
        energy=o.get('energy'); cap=o.get('energyCapacity')
        if cap:
            w=28; p=pct(energy,cap); add(f'<rect x="{x-w/2}" y="{y+16}" width="{w}" height="4" fill="#24323b"/><rect x="{x-w/2}" y="{y+16}" width="{w*p}" height="4" fill="#ffe066"/>')
    elif t == 'mineral':
        add(f'<polygon points="{x},{y-13} {x+12},{y-5} {x+9},{y+10} {x},{y+16} {x-9},{y+10} {x-12},{y-5}" fill="#a76cff" stroke="#ead7ff" stroke-width="2" filter="url(#softGlow)"/>')
    elif t == 'controller':
        lvl=o.get('level',0); progress=o.get('progress',0); total=o.get('progressTotal',0)
        add(f'<rect x="{x-13}" y="{y-13}" width="26" height="26" rx="6" fill="#3aa7ff" stroke="#d9f2ff" stroke-width="2" transform="rotate(45 {x} {y})" filter="url(#softGlow)"/>')
        add(f'<text x="{x}" y="{y+5}" text-anchor="middle" font-size="14" font-weight="900" fill="#03131f">R{lvl}</text>')
        if total:
            w=40; p=pct(progress,total); add(f'<rect x="{x-w/2}" y="{y+20}" width="{w}" height="5" fill="#162635"/><rect x="{x-w/2}" y="{y+20}" width="{w*p}" height="5" fill="#68d8ff"/>')
    elif t == 'spawn':
        p=pct(o.get('hits'),o.get('hitsMax'))
        add(f'<circle cx="{x}" cy="{y}" r="16" fill="#1feb85" stroke="#d7ffe9" stroke-width="3" filter="url(#softGlow)"/><circle cx="{x}" cy="{y}" r="7" fill="#0b291c"/><path d="M{x-14},{y} H{x+14} M{x},{y-14} V{y+14}" stroke="#eafff2" stroke-width="2" opacity=".8"/>')
        add(f'<rect x="{x-18}" y="{y+20}" width="36" height="5" fill="#22313a"/><rect x="{x-18}" y="{y+20}" width="{36*p}" height="5" fill="#5df096"/>')
    elif t == 'tower':
        add(f'<rect x="{x-10}" y="{y-12}" width="20" height="24" rx="3" fill="#ff6b6b" stroke="#ffd4d4" stroke-width="2"/>')
    elif t == 'extension':
        add(f'<circle cx="{x}" cy="{y}" r="9" fill="#49d985" stroke="#d7ffe9" stroke-width="2"/>')

for c in creeps:
    x, y = center(c); uname=(c.get('owner') or {}).get('username'); hostile=(c.get('my') is False or (uname and uname != owner))
    fill = '#ff4b55' if hostile else '#f7fbff'; stroke = '#ffd0d3' if hostile else '#122034'
    add(f'<g filter="url(#shadow)"><path d="M{x},{y-13} L{x+12},{y+10} L{x},{y+5} L{x-12},{y+10} Z" fill="{fill}" stroke="{stroke}" stroke-width="2"/></g>')
    hp=pct(c.get('hits'),c.get('hitsMax'))
    add(f'<rect x="{x-14}" y="{y+14}" width="28" height="4" fill="#222c34"/><rect x="{x-14}" y="{y+14}" width="{28*hp}" height="4" fill="{"#ff6b6b" if hostile else "#ffffff"}"/>')

labels=[]
if spawn: labels.append((spawn, 'Spawn', '#65f0a5'))
if controller: labels.append((controller, f'Controller R{controller.get("level",0)}', '#68d8ff'))
for i,s in enumerate(sources,1): labels.append((s, f'Source {i}', '#ffe066'))
if mineral: labels.append((mineral, 'Mineral', '#bd8cff'))
for idx,(o,text,color) in enumerate(labels):
    x,y=center(o); lx=x+26 if x<map_x+map_w-200 else x-130; ly=y-18 if idx%2==0 else y+32
    width=max(80,len(text)*8+62)
    add(f'<path d="M{x+10} {y-8} L{lx} {ly}" stroke="{color}" stroke-width="1.5" opacity=".8"/>')
    add(f'<rect x="{lx}" y="{ly-16}" width="{width}" height="22" rx="8" fill="#07101c" stroke="{color}" opacity=".92"/>')
    add(f'<text class="tiny" x="{lx+8}" y="{ly-1}" fill="{color}">{esc(text)} · ({o.get("x")},{o.get("y")})</text>')

add(f'<rect x="{side_x}" y="130" width="500" height="260" rx="24" fill="url(#panel)" filter="url(#shadow)" stroke="#2c4863"/>')
add(f'<text class="panelTitle" x="{side_x+28}" y="170">Room telemetry</text>')
metric=[('Objects',len(objs),'#68d8ff'),('Creeps',counts.get('creep',0),'#ffffff'),('Hostiles',len(hostiles),'#ff5b63' if hostiles else '#65f0a5'),('Sources',counts.get('source',0),'#ffe066')]
for i,(name,val,col) in enumerate(metric):
    x=side_x+30+(i%2)*225; y=210+(i//2)*80
    add(f'<rect x="{x}" y="{y}" width="200" height="58" rx="16" fill="#0b1424" stroke="#263d58"/>')
    add(f'<text class="tiny" x="{x+18}" y="{y+22}">{name}</text><text class="num" x="{x+18}" y="{y+50}" fill="{col}">{val}</text>')

add(f'<rect x="{side_x}" y="420" width="500" height="250" rx="24" fill="url(#panel)" filter="url(#shadow)" stroke="#2c4863"/>')
add(f'<text class="panelTitle" x="{side_x+28}" y="460">Operational status</text>')
rows=[]
if spawn:
    rows.append(('Spawn', f'({spawn.get("x")},{spawn.get("y")}) hits {spawn.get("hits")}/{spawn.get("hitsMax")}', '#65f0a5' if spawn.get('hits')==spawn.get('hitsMax') else '#ffe066'))
else:
    rows.append(('Spawn','missing in visible objects','#ff5b63'))
if controller:
    rows.append(('Controller', f'R{controller.get("level",0)} progress {controller.get("progress",0)}/{controller.get("progressTotal",0) or "—"}', '#68d8ff'))
rows.append(('Alert', 'no hostile creep visible' if not hostiles else f'{len(hostiles)} hostile creep(s) visible', '#65f0a5' if not hostiles else '#ff5b63'))
rows.append(('Snapshot', 'live websocket full-state seed + terrain cache', '#9fb5c9'))
for i,(a,b,col) in enumerate(rows):
    y=495+i*40
    add(f'<circle cx="{side_x+38}" cy="{y-5}" r="6" fill="{col}"/><text class="label" x="{side_x+55}" y="{y}">{esc(a)}</text><text class="sub" x="{side_x+175}" y="{y}">{esc(b)}</text>')

add(f'<rect x="{side_x}" y="700" width="500" height="250" rx="24" fill="url(#panel)" filter="url(#shadow)" stroke="#2c4863"/>')
add(f'<text class="panelTitle" x="{side_x+28}" y="740">Legend / visual encoding</text>')
leg=[('#172719','plain terrain'),('#405b34','swamp terrain'),('#2e3438','wall terrain'),('#ffd84d','energy source'),('#3aa7ff','controller'),('#1feb85','spawn / owned structure'),('#f7fbff','owned creep'),('#ff4b55','hostile / alert')]
for i,(col,text) in enumerate(leg):
    x=side_x+30+(i%2)*235; y=780+(i//2)*42
    add(f'<rect x="{x}" y="{y-15}" width="24" height="24" rx="6" fill="{col}" stroke="#dbeeff" stroke-opacity=".45"/><text class="sub" x="{x+36}" y="{y+3}">{esc(text)}</text>')

add(f'<text class="sub" x="70" y="1070">Design target: clearer than raw client map — coordinate grid, object labels, health/energy bars, tactical summary, alert-ready color coding.</text>')
add('</svg>')
out_svg=Path('/root/screeps/docs/process/room-snapshot-refined-E48S29.svg')
out_png=out_svg.with_suffix('.png')
out_svg.write_text('\n'.join(svg), encoding='utf-8')
print(json.dumps({'svg':str(out_svg),'png':str(out_png),'objects':len(objs),'hostiles':len(hostiles),'counts':dict(counts)}, ensure_ascii=False))
