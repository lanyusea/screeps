#!/usr/bin/env python3
"""Render a Page-&-Margin-style design canvas for a live Screeps room snapshot.

This intentionally follows the design-board language of demo-2-canvas.html:
warm paper canvas, 2x2 cards, small labeled headers, restrained editorial
layouts, and differentiated inner design directions.
"""
import os
import asyncio
import json
import urllib.parse
import urllib.request
import html
from collections import Counter
from pathlib import Path

import websockets

BASE_HTTP = os.environ.get("SCREEPS_API_URL", "https://screeps.com").rstrip("/")
BASE_WS = BASE_HTTP.replace("https://", "wss://").replace("http://", "ws://")
TOKEN = os.environ["SCREEPS_AUTH_TOKEN"]
SHARD = os.environ.get("SCREEPS_SHARD", "shardX")
ROOM = os.environ.get("SCREEPS_ROOM", "E26S49")
OWNER = os.environ.get("SCREEPS_OWNER", "lanyusea")

OUT_SVG = Path(f"/root/screeps/docs/process/room-snapshot-design-canvas-{ROOM}.svg")
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


def escape(value):
    return html.escape(str(value), quote=True)


def pct(a, b):
    try:
        return max(0, min(1, float(a) / float(b))) if b else 0
    except Exception:
        return 0


def main():
    terrain = get_json("/api/game/room-terrain", {"room": ROOM, "shard": SHARD, "encoded": "1"})["terrain"][0]["terrain"]
    overview = get_json("/api/user/overview")
    room_event = asyncio.run(get_room_event())
    objects = room_event.get("objects", {})

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
    alert_text = "No hostile creep visible" if not hostiles else f"{len(hostiles)} hostile creep(s) visible"
    alert_short = "QUIET ROOM" if not hostiles else "ROOM UNDER PRESSURE"

    W, H = 1440, 1210
    page_x, page_y = 48, 72
    card_w, card_h = 640, 480
    gap = 32
    grid_y = 176

    svg = []
    def add(s): svg.append(s)
    def text(x, y, content, cls="", **attrs):
        attr = " ".join(f'{k.replace("_", "-")}="{escape(v)}"' for k, v in attrs.items())
        add(f'<text x="{x}" y="{y}" class="{cls}" {attr}>{escape(content)}</text>')

    def card(x, y, tag, title, note, body_bg="#f8f7f3"):
        add(f'<g transform="translate({x},{y})">')
        add(f'<rect width="{card_w}" height="{card_h}" rx="6" fill="white" filter="url(#cardShadow)"/>')
        add(f'<rect y="0" width="{card_w}" height="49" fill="#fbfaf7"/>')
        add(f'<path d="M0 49 H{card_w}" stroke="#e6e1d8"/>')
        add(f'<rect x="18" y="15" width="27" height="20" rx="3" fill="#efece5"/>')
        text(31.5, 29, tag, "tagText", text_anchor="middle")
        text(58, 30, title, "cardTitle")
        text(card_w - 18, 30, note, "cardNote", text_anchor="end")
        add(f'<rect x="0" y="50" width="{card_w}" height="{card_h-50}" fill="{body_bg}"/>')

    def end_card(): add('</g>')

    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add('''<defs>
      <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".03"/><feDropShadow dx="0" dy="12" stdDeviation="14" flood-opacity=".06"/></filter>
      <style>
        .pageTitle{font:500 28px Inter,Helvetica,Arial,sans-serif;letter-spacing:-.01em;fill:#111}.pageSub{font:400 15px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.tagText{font:600 11px Inter,Helvetica,Arial,sans-serif;letter-spacing:.10em;fill:#6b6359}.cardTitle{font:650 14px Inter,Helvetica,Arial,sans-serif;fill:#111}.cardNote{font:400 12px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.kicker{font:700 10px Inter,Helvetica,Arial,sans-serif;letter-spacing:.28em;fill:#5f5a54}.micro{font:500 11px Inter,Helvetica,Arial,sans-serif;fill:#6b6359}.body{font:400 13px Inter,Helvetica,Arial,sans-serif;fill:#5c5750}.mono{font:400 13px JetBrains Mono,IBM Plex Mono,Courier New,monospace;fill:#000}.monoSmall{font:400 11px JetBrains Mono,IBM Plex Mono,Courier New,monospace;fill:#000}.serif{font-family:Georgia,Times New Roman,serif}.coord{font:500 8px JetBrains Mono,Courier New,monospace;fill:#8a8379}.label{font:650 9px Inter,Helvetica,Arial,sans-serif;letter-spacing:.06em;fill:#111}.link{font:400 14px JetBrains Mono,Courier New,monospace;fill:#0000ee;text-decoration:underline}
      </style>
    </defs>''')
    add('<rect width="100%" height="100%" fill="#efece5"/>')
    text(page_x, 104, "Screeps — room snapshot variations", "pageTitle")
    text(page_x, 134, f"Four editorial render directions for live official-client API data from {SHARD}/{ROOM}. Same facts; different visual treatments for summary and alert channels.", "pageSub")

    # A — Swiss Tactical Map
    ax, ay = page_x, grid_y
    card(ax, ay, "A", "Swiss Tactical Map", "Structured authority · best default for runtime-summary", "#f3f0ea")
    ox, oy = 40, 86
    text(ox, oy, "SCREEPS / ROOM SNAPSHOT", "kicker")
    text(card_w - 40, oy, f"TICK {gametime or 'UNKNOWN'}", "kicker", text_anchor="end")
    text(ox, 150, "Territory you can", "", style="font:500 45px Inter,Helvetica,Arial,sans-serif;letter-spacing:-.045em;fill:#111")
    text(ox, 202, "reason about.", "", style="font:500 45px Inter,Helvetica,Arial,sans-serif;letter-spacing:-.045em;fill:#cf4327")
    # map in A
    mx, my, cs = 352, 105, 4.6
    add(f'<rect x="{mx-12}" y="{my-12}" width="{50*cs+24}" height="{50*cs+24}" fill="#ebe6dc" stroke="#d6cec1"/>')
    for yy in range(50):
        for xx in range(50):
            v = int(terrain[yy*50+xx])
            fill = "#3f403d" if v & 1 else ("#b9b891" if v & 2 else "#ded7cb")
            add(f'<rect x="{mx+xx*cs:.2f}" y="{my+yy*cs:.2f}" width="{cs+.05:.2f}" height="{cs+.05:.2f}" fill="{fill}"/>')
    for i in range(0, 51, 10):
        add(f'<path d="M{mx+i*cs:.1f} {my} V{my+50*cs}" stroke="#fff" stroke-opacity=".45" stroke-width=".8"/>')
        add(f'<path d="M{mx} {my+i*cs:.1f} H{mx+50*cs}" stroke="#fff" stroke-opacity=".45" stroke-width=".8"/>')
    def plot(o, color, r=4, stroke="#111"):
        x = mx + o.get('x', 0)*cs + cs/2; y = my + o.get('y', 0)*cs + cs/2
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{color}" stroke="{stroke}" stroke-width="1"/>')
        return x, y
    for s in sources: plot(s, "#d9a900", 5)
    if mineral: plot(mineral, "#7b55a2", 5)
    if controller: plot(controller, "#2d6f9f", 5)
    if spawn: plot(spawn, "#2b9a57", 6)
    for c in creeps: plot(c, "#ffffff" if c not in hostiles else "#cf4327", 4)
    text(ox, 290, f"{ROOM} on {SHARD}. {counts.get('creep',0)} creeps, {counts.get('source',0)} sources, {len(hostiles)} hostiles.", "body")
    text(ox, 312, f"Spawn {spawn.get('hits') if spawn else '—'}/{spawn.get('hitsMax') if spawn else '—'} · Controller R{controller.get('level') if controller else '—'} · Objects {len(objects)}", "body")
    add(f'<path d="M{card_w-190} 378 H{card_w-40}" stroke="#111"/>')
    text(card_w-40, 402, "OPEN RUNTIME SUMMARY →", "kicker", text_anchor="end")
    end_card()

    # B — Quiet Operations
    bx, by = page_x + card_w + gap, grid_y
    card(bx, by, "B", "Quiet Operations", "Kenya Hara lineage · calm heartbeat image", "#f8f6f1")
    add(f'<circle cx="{card_w/2}" cy="168" r="4" fill="#a47a4a"/>')
    text(card_w/2, 214, "SCREEPS ROOM", "kicker", text_anchor="middle", fill="#a47a4a")
    text(card_w/2, 260, alert_short + ".", "", text_anchor="middle", style="font:400 34px Georgia,Times New Roman,serif;fill:#3c3934")
    text(card_w/2, 294, f"{SHARD}/{ROOM} · {counts.get('creep',0)} creeps · {len(hostiles)} hostiles · tick {gametime or 'unknown'}", "body", text_anchor="middle")
    text(card_w/2, 320, "A calm snapshot for when nothing requires interruption.", "body", text_anchor="middle")
    end_card()

    # C — Brutalist Data
    cx, cy = page_x, grid_y + card_h + gap
    card(cx, cy, "C", "Brutalist Data", "Raw text · best for debugging and archival logs", "#ffffff")
    x0, y0 = 40, 92
    text(x0, y0, f"// screeps-room {SHARD}/{ROOM}", "mono")
    text(x0, y0+22, "// live websocket + cached terrain + rendered summary", "mono")
    add(f'<path d="M{x0} {y0+44} H{card_w-40}" stroke="#000"/>')
    text(x0, y0+92, "Room State", "", style="font:700 32px Georgia,Times New Roman,serif;fill:#000")
    text(x0, y0+125, "Every visible object in the owned room, reduced to a plain-text operational record.", "", style="font:400 14px Georgia,Times New Roman,serif;fill:#000")
    add(f'<path d="M{x0} {y0+154} H{card_w-40}" stroke="#000"/>')
    rows = [
        ("ROOM", f"{SHARD}/{ROOM}"),
        ("GAME TIME", str(gametime or "unknown")),
        ("OBJECTS", str(len(objects))),
        ("CREEPS", str(counts.get('creep',0))),
        ("SOURCES", str(counts.get('source',0))),
        ("SPAWN", f"{spawn.get('hits')}/{spawn.get('hitsMax')} @ {spawn.get('x')},{spawn.get('y')}" if spawn else "missing"),
        ("CONTROLLER", f"R{controller.get('level')} @ {controller.get('x')},{controller.get('y')}" if controller else "not visible"),
        ("ALERT", alert_text),
    ]
    yy = y0 + 168
    for k, v in rows:
        text(x0, yy, k, "monoSmall")
        text(x0+142, yy, v, "monoSmall")
        add(f'<path d="M{x0} {yy+10} H{card_w-40}" stroke="#aaa" stroke-dasharray="2 4"/>')
        yy += 23
    text(x0, card_h-24, "→ render summary image", "link")
    text(x0+210, card_h-24, "→ inspect alert rules", "link")
    end_card()

    # D — Editorial Alert
    dx, dy = page_x + card_w + gap, grid_y + card_h + gap
    card(dx, dy, "D", "Editorial Alert", "Magazine cover · best for runtime-alerts", "#17120f")
    text(38, 98, f"{ROOM} · Tick N° {gametime or 'unknown'}", "", style="font:700 13px Georgia,Times New Roman,serif;fill:#d4b98c")
    headline = ["The room", "is quiet," if not hostiles else "is under", "but the", "map is", "watching."] if not hostiles else ["A hostile", "entered", "the room", "and the", "map saw it."]
    hy = 152
    for line in headline:
        text(38, hy, line, "", style="font:700 48px Georgia,Times New Roman,serif;letter-spacing:-.03em;fill:#f3eadf")
        hy += 49
    text(38, card_h-50, "SHIPPING TO RUNTIME-ALERTS WHEN SEVERITY RISES", "kicker", fill="#d4b98c")
    add(f'<rect x="390" y="88" width="206" height="312" fill="#2b231e"/>')
    add(f'<path d="M420 130 V318" stroke="#d4b98c" stroke-width="2"/>')
    quote = ["No hostile", "creep", "visible", "in the", "current", "snapshot."] if not hostiles else [str(len(hostiles)), "hostile", "creep(s)", "visible", "right", "now."]
    qy = 156
    for line in quote:
        text(438, qy, line, "", style="font:400 25px Georgia,Times New Roman,serif;fill:#f3eadf")
        qy += 31
    text(438, 356, "— LIVE ROOM", "kicker", fill="#d4b98c")
    text(438, 376, "OBJECT CACHE", "kicker", fill="#d4b98c")
    end_card()

    add('</svg>')
    OUT_SVG.write_text("\n".join(svg), encoding="utf-8")
    print(json.dumps({"svg": str(OUT_SVG), "png": str(OUT_PNG), "objects": len(objects), "hostiles": len(hostiles), "counts": dict(counts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
