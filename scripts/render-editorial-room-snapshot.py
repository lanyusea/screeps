#!/usr/bin/env python3
"""Render a single warm-neutral editorial Screeps room snapshot.

Design goal: borrow the reference image's palette, restrained lines, typography,
soft card shadow, and editorial whitespace without copying its 2x2 layout.
"""
import asyncio
import html
import json
import os
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import websockets

BASE_HTTP = os.environ.get("SCREEPS_API_URL", "https://screeps.com").rstrip("/")
BASE_WS = BASE_HTTP.replace("https://", "wss://").replace("http://", "ws://")
TOKEN = os.environ["SCREEPS_AUTH_TOKEN"]
SHARD = os.environ.get("SCREEPS_SHARD", "shardX")
ROOM = os.environ.get("SCREEPS_ROOM", "E48S28")
OWNER = os.environ.get("SCREEPS_OWNER", "lanyusea")
OUT_SVG = Path(f"/root/screeps/docs/process/room-snapshot-editorial-{ROOM}.svg")
OUT_PNG = OUT_SVG.with_suffix(".png")


def get_json(path, params=None):
    url = BASE_HTTP + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-Token": TOKEN})
    return json.load(urllib.request.urlopen(req, timeout=20))


async def get_room_event():
    async with websockets.connect(BASE_WS + "/socket/websocket", open_timeout=20) as ws:
        await ws.send("auth " + TOKEN)
        for _ in range(20):
            msg = await asyncio.wait_for(ws.recv(), timeout=20)
            if isinstance(msg, bytes):
                msg = msg.decode()
            if msg.startswith("auth "):
                break
        await ws.send(f"subscribe room:{SHARD}/{ROOM}")
        for _ in range(40):
            msg = await asyncio.wait_for(ws.recv(), timeout=20)
            if isinstance(msg, bytes):
                msg = msg.decode()
            if msg.startswith("["):
                arr = json.loads(msg)
                if arr[0].startswith("room:"):
                    return arr[1]
    return {"objects": {}}


def esc(v):
    return html.escape(str(v), quote=True)


def pct(a, b):
    try:
        return max(0, min(1, float(a) / float(b))) if b else 0
    except Exception:
        return 0


def main():
    terrain = get_json("/api/game/room-terrain", {"room": ROOM, "shard": SHARD, "encoded": "1"})["terrain"][0]["terrain"]
    overview = get_json("/api/user/overview")
    event = asyncio.run(get_room_event())
    objects = event.get("objects", {})

    counts = Counter(o.get("type", "?") for o in objects.values() if isinstance(o, dict))
    creeps = [o for o in objects.values() if isinstance(o, dict) and o.get("type") == "creep"]
    sources = [o for o in objects.values() if isinstance(o, dict) and o.get("type") == "source"]
    spawn = next((o for o in objects.values() if isinstance(o, dict) and o.get("type") == "spawn"), None)
    controller = next((o for o in objects.values() if isinstance(o, dict) and o.get("type") == "controller"), None)
    mineral = next((o for o in objects.values() if isinstance(o, dict) and o.get("type") == "mineral"), None)
    hostiles = []
    for c in creeps:
        username = (c.get("owner") or {}).get("username")
        if c.get("my") is False or (username and username != OWNER):
            hostiles.append(c)
    gametime = (overview.get("shards", {}).get(SHARD, {}).get("gametimes") or [None])[0]

    W, H = 1440, 900
    card_x, card_y = 54, 50
    card_w, card_h = 1332, 800
    map_x, map_y = 86, 142
    cell = 13.4
    map_size = cell * 50
    side_x = 875

    svg = []
    def add(s): svg.append(s)
    def text(x, y, content, cls="", **attrs):
        attr = " ".join(f'{k.replace("_", "-")}="{esc(v)}"' for k, v in attrs.items())
        add(f'<text x="{x}" y="{y}" class="{cls}" {attr}>{esc(content)}</text>')
    def center(o):
        return map_x + o.get("x", 0) * cell + cell / 2, map_y + o.get("y", 0) * cell + cell / 2

    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add('''<defs>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".03"/><feDropShadow dx="0" dy="16" stdDeviation="18" flood-opacity=".07"/></filter>
      <style>
        .sans{font-family:Inter,Helvetica,Arial,sans-serif}.serif{font-family:Georgia,Times New Roman,serif}.mono{font-family:JetBrains Mono,IBM Plex Mono,Courier New,monospace}.kicker{font:700 10px Inter,Helvetica,Arial,sans-serif;letter-spacing:.24em;fill:#6b6359}.body{font:400 13px Inter,Helvetica,Arial,sans-serif;fill:#5f5a54}.small{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.metricNum{font:500 32px Georgia,Times New Roman,serif;fill:#111}.metricLabel{font:700 9px Inter,Helvetica,Arial,sans-serif;letter-spacing:.18em;fill:#8a8379}.coord{font:500 8px JetBrains Mono,Courier New,monospace;fill:#8f887e}.caption{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#3e3a35}.legend{font:500 11px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.dense{font:500 12px Inter,Helvetica,Arial,sans-serif;fill:#3e3a35}.denseMuted{font:400 11px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}
      </style>
    </defs>''')
    add('<rect width="100%" height="100%" fill="#efece5"/>')
    add(f'<rect x="{card_x}" y="{card_y}" width="{card_w}" height="{card_h}" rx="8" fill="#fbfaf7" filter="url(#shadow)"/>')
    add(f'<path d="M{card_x} {card_y+66} H{card_x+card_w}" stroke="#e6e1d8"/>')
    add(f'<rect x="{card_x+24}" y="{card_y+22}" width="68" height="24" rx="3" fill="#efece5"/>')
    text(card_x+58, card_y+38, "LIVE", "kicker", text_anchor="middle")
    text(card_x+110, card_y+39, "Screeps room snapshot", "small")
    text(card_x+card_w-24, card_y+39, f"{SHARD}/{ROOM} · tick {gametime or 'unknown'}", "small", text_anchor="end")

    text(96, 112, f"{SHARD}/{ROOM}", "kicker")
    text(96, 132, f"tick {gametime or 'unknown'} · official-client room feed", "small")
    text(side_x, 112, "Runtime reading", "kicker")
    add(f'<path d="M{side_x} 132 H{card_x+card_w-72}" stroke="#111" stroke-opacity=".75"/>')

    # Map panel
    add(f'<rect x="{map_x-18}" y="{map_y-18}" width="{map_size+36}" height="{map_size+36}" fill="#f3f0ea" stroke="#d8d0c4"/>')
    for y in range(50):
        for x in range(50):
            v = int(terrain[y * 50 + x])
            fill = "#353632" if v & 1 else ("#b7b48e" if v & 2 else "#e4ded2")
            add(f'<rect x="{map_x+x*cell:.2f}" y="{map_y+y*cell:.2f}" width="{cell+.04:.2f}" height="{cell+.04:.2f}" fill="{fill}"/>')
    for i in range(0, 51, 5):
        op = ".45" if i % 10 == 0 else ".22"
        add(f'<path d="M{map_x+i*cell:.2f} {map_y} V{map_y+map_size}" stroke="#fff" stroke-opacity="{op}"/>')
        add(f'<path d="M{map_x} {map_y+i*cell:.2f} H{map_x+map_size}" stroke="#fff" stroke-opacity="{op}"/>')
        if i < 50 and i % 10 == 0:
            text(map_x+i*cell+2, map_y-7, str(i), "coord")
            text(map_x-20, map_y+i*cell+11, str(i), "coord")
    add(f'<rect x="{map_x}" y="{map_y}" width="{map_size}" height="{map_size}" fill="none" stroke="#111" stroke-width="1.2"/>')

    def dot(o, fill, r, stroke="#111", label=None, dx=14, dy=-10):
        x, y = center(o)
        add(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>')
        if label:
            add(f'<path d="M{x+r+2:.1f} {y:.1f} L{x+dx-4:.1f} {y+dy:.1f}" stroke="#111" stroke-opacity=".55"/>')
            text(x+dx, y+dy+4, label, "caption")
        return x, y

    for idx, s in enumerate(sources, 1):
        dot(s, "#d3a400", 6.5, label=f"Source {idx}", dx=16, dy=-12 if idx == 1 else -18)
    if mineral:
        dot(mineral, "#8060a8", 6, label="Mineral", dx=-72, dy=-12)
    if controller:
        dot(controller, "#2f6e91", 7, label=f"Controller R{controller.get('level', 0)}", dx=18, dy=26)
    if spawn:
        dot(spawn, "#2f8c5a", 8, label="Spawn", dx=16, dy=-14)
    for c in creeps:
        hostile = c in hostiles
        dot(c, "#cf4327" if hostile else "#fffaf0", 4.5, stroke="#cf4327" if hostile else "#111")

    # Dense side metrics and notes
    metrics = [
        ("objects", len(objects)),
        ("creeps", counts.get("creep", 0)),
        ("sources", counts.get("source", 0)),
        ("hostiles", len(hostiles)),
    ]
    my = 172
    text(side_x, my, "Snapshot", "kicker")
    my += 26
    for i, (label, value) in enumerate(metrics):
        x = side_x + (i % 2) * 170
        y = my + (i // 2) * 30
        text(x, y, label.upper(), "metricLabel")
        text(x + 124, y, value, "dense", text_anchor="end")
        add(f'<path d="M{x} {y+12} H{x+132}" stroke="#e0d9ce"/>')

    status_y = 290
    text(side_x, status_y, "Objects and status", "kicker")
    rows = [
        ("Spawn", f"{spawn.get('hits')}/{spawn.get('hitsMax')} at {spawn.get('x')},{spawn.get('y')}" if spawn else "not visible"),
        ("Controller", f"R{controller.get('level')} at {controller.get('x')},{controller.get('y')}" if controller else "not visible"),
        ("Alert", "No hostile creep visible" if not hostiles else f"{len(hostiles)} hostile creep(s) visible"),
        ("Mineral", f"visible at {mineral.get('x')},{mineral.get('y')}" if mineral else "not visible"),
        ("Feed", "websocket room objects + cached terrain"),
    ]
    y = status_y + 26
    for k, v in rows:
        text(side_x, y, k.upper(), "metricLabel")
        text(side_x + 108, y, v, "dense")
        add(f'<path d="M{side_x} {y+15} H{card_x+card_w-72}" stroke="#e0d9ce"/>')
        y += 27

    # Compact object mix table
    y += 14
    text(side_x, y, "Object mix", "kicker")
    y += 24
    mix = [
        ("spawn", counts.get("spawn", 0)),
        ("controller", counts.get("controller", 0)),
        ("creep", counts.get("creep", 0)),
        ("source", counts.get("source", 0)),
        ("mineral", counts.get("mineral", 0)),
        ("hostile", len(hostiles)),
    ]
    for idx, (name, value) in enumerate(mix):
        x = side_x + (idx % 2) * 170
        yy = y + (idx // 2) * 25
        text(x, yy, name.upper(), "metricLabel")
        text(x + 118, yy, value, "dense", text_anchor="end")
    y += 86

    add(f'<path d="M{side_x} {y} H{card_x+card_w-72}" stroke="#111" stroke-opacity=".65"/>')
    text(side_x, y + 28, "summary cadence", "metricLabel")
    text(side_x + 160, y + 28, "periodic snapshot", "dense")
    text(side_x, y + 52, "alert treatment", "metricLabel")
    text(side_x + 160, y + 52, "red emphasis + room crop", "dense")
    text(side_x, y + 76, "delivery", "metricLabel")
    text(side_x + 160, y + 76, "runtime-summary / runtime-alerts", "dense")

    # Bottom legend
    ly = card_y + card_h - 44
    lx = 96
    legend = [("#e4ded2", "plain"), ("#b7b48e", "swamp"), ("#353632", "wall"), ("#2f8c5a", "spawn"), ("#d3a400", "source"), ("#fffaf0", "creep"), ("#cf4327", "hostile")]
    for color, label in legend:
        add(f'<rect x="{lx}" y="{ly-11}" width="18" height="18" fill="{color}" stroke="#111" stroke-opacity=".45"/>')
        text(lx+26, ly+2, label, "legend")
        lx += 110
    text(card_x+card_w-72, ly+2, "designed for quiet summaries; alert state swaps in red emphasis", "legend", text_anchor="end")

    add('</svg>')
    OUT_SVG.write_text("\n".join(svg), encoding="utf-8")
    print(json.dumps({"svg": str(OUT_SVG), "png": str(OUT_PNG), "objects": len(objects), "hostiles": len(hostiles), "counts": dict(counts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
