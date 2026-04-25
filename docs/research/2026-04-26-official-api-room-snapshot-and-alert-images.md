# Screeps Official-Client API Room Snapshot and Alert Images Research

Date: 2026-04-26T04:20:34+08:00

## Question

Can we use Screeps official APIs to draw the actual state of all our territory, periodically send an image to Discord `#runtime-summary` (`1497588267057680385`), and also send an image to `#runtime-alerts` (`1497588512436785284`) when an alert occurs, such as being attacked?

## Short conclusion

Yes, this is feasible, with one important wording caveat: Screeps says it does **not** have a documented public Web API, but it explicitly allows external tools to use the same undocumented HTTP endpoints and websocket channels used by the official client, authenticated with persistent auth tokens.

A reliable implementation should use:

1. `GET /api/user/overview` to enumerate owned rooms by shard.
2. `GET /api/game/room-terrain?room=<room>&shard=<shard>&encoded=1` to fetch and cache terrain for each owned room.
3. The authenticated official-client websocket `wss://screeps.com/socket/websocket`, subscribing to `room:<shard>/<room>`, to receive live RoomObjects for each visible/owned room.
4. A renderer that composes terrain + live objects into a PNG.
5. A scheduler/bridge outside Screeps runtime to send periodic images to Discord `#runtime-summary` and event-triggered images to `#runtime-alerts`.

## Verified against our current account state

Using the local untracked Screeps auth token without printing it:

- Auth token: present.
- API URL: `https://screeps.com`.
- Branch: `main`.
- Shard: `shardX`.
- Owned room: `E48S28`.

`GET /api/user/overview` currently reports one owned room on `shardX`:

- `shardX/E48S28`

A live websocket proof-of-concept subscription to `room:shardX/E48S28` succeeded and returned live room objects. The first snapshot contained:

- 3 creeps
- 2 sources
- 1 mineral
- 1 controller
- 1 spawn

A local proof-of-concept PNG was generated at:

- `docs/process/room-snapshot-poc-E48S28.png`

This proves the minimum viable drawing pipeline: terrain + actual live room objects can be rendered into an image without scraping the browser UI.

## Source findings

### Auth and allowed API model

Official docs page: `https://docs.screeps.com/auth-tokens.html`

Relevant findings:

- Screeps states it does not have a documented public Web API.
- It says using undocumented HTTP endpoints used by the official client is fine.
- Persistent auth tokens can be generated in account settings.
- Tokens can be sent with the `X-Token` header.
- Token-authenticated HTTP requests are rate limited.

Observed/documented rate limit examples relevant to this feature:

- Global: 120 requests/minute.
- `GET /api/game/room-terrain`: 360/hour.
- `POST /api/game/map-stats`: 60/hour.
- `GET /api/user/memory`: 1440/day.
- `GET /api/user/memory-segment`: 360/hour.
- `POST /api/user/console`: 360/hour.

### Owned-room discovery

Endpoint verified locally:

```text
GET https://screeps.com/api/user/overview
X-Token: <token>
```

Useful response shape:

```text
ok
shards.<shard>.rooms[]
shards.<shard>.stats
shards.<shard>.gametimes
```

For our current account, the owned-room list is `shards.shardX.rooms = ["E48S28"]`.

### Terrain data

Endpoint verified locally:

```text
GET https://screeps.com/api/game/room-terrain?room=E48S28&shard=shardX&encoded=1
X-Token: <token>
```

Useful response shape:

```text
ok
terrain[0].room
terrain[0].terrain
terrain[0].type
```

The encoded terrain string is 2500 cells for a 50x50 room. Values can be decoded as:

- `0`: plain
- `1`: wall
- `2`: swamp

Terrain should be cached because it rarely changes and the HTTP endpoint is rate limited.

### Live room objects

Community client-library docs: `https://github.com/screepers/node-screeps-api/blob/master/docs/Websocket_endpoints.md`

Verified websocket protocol:

```text
wss://screeps.com/socket/websocket
send: auth <token>
expect: auth ok ...
send: subscribe room:shardX/E48S28
```

Relevant subscription behavior from the community docs and local test:

- Channel: `room:<shard>/<room>`.
- First event returns full RoomObjects indexed by id.
- Subsequent events return changed properties only, so the monitor must maintain a local object cache per room.
- Event data includes `objects`, `info`, and often a `visual` field.
- RoomObjects resemble in-game object properties: `type`, `x`, `y`, `hits`, `hitsMax`, `energy`, owner fields, etc.

This is the key source for drawing the actual current room state.

## Proposed runtime architecture

```text
Screeps official API/token
        │
        ├─ HTTP /api/user/overview ───────► discover owned rooms
        ├─ HTTP /api/game/room-terrain ───► cache static terrain per room
        └─ websocket room:<shard>/<room> ─► live RoomObjects per room
                                            │
                                            ▼
                                  room-state cache
                                            │
                  ┌─────────────────────────┴────────────────────────┐
                  ▼                                                  ▼
        periodic renderer                                  alert detector
        every N minutes                                    hostiles/damage/etc.
                  │                                                  │
                  ▼                                                  ▼
        PNG overview/panels                                PNG alert snapshot
                  │                                                  │
                  ▼                                                  ▼
Discord #runtime-summary                         Discord #runtime-alerts
1497588267057680385                              1497588512436785284
```

## Rendering design

For each owned room:

1. Draw the 50x50 terrain base layer.
2. Overlay static/resources:
   - sources
   - mineral
   - controller
3. Overlay owned structures:
   - spawn
   - extensions
   - roads
   - ramparts
   - towers
   - storage/terminal/labs/etc. once they exist
4. Overlay units:
   - owned creeps
   - hostile creeps
   - power creeps if present
5. Add health/status annotations:
   - structure hit ratio
   - controller level/progress
   - spawn status
   - hostile count
   - tick/time of snapshot
6. For multiple rooms, compose a single overview image with one panel per room, or generate one image per room and bundle/send them together.

For alerts, use the same renderer but add a red border and annotations such as:

- `ALERT: hostile creep detected`
- room name/shard
- hostile owner and hostile body summary when available
- damaged structures count
- lowest rampart/wall hit ratio if relevant

## Alert-detection options

Recommended layered approach:

### External monitor detection

From websocket RoomObjects, detect:

- hostile creeps: `type == "creep"` and not owned by `lanyusea` / not `my`.
- damaged critical structures: large drops in `hits` or hit ratio below thresholds.
- new hostile-owned structures or invader cores.
- room object disappearance for owned structures that were previously present.

Pros:

- Does not consume Screeps CPU.
- Can trigger images even if our bot code fails.
- Has direct access to snapshot data for rendering.

Cons:

- Depends on undocumented official-client websocket behavior.
- Needs reconnect/object-cache logic because incremental websocket events are partial.

### In-game bot telemetry detection

Our bot can also emit structured console telemetry, e.g. lines prefixed with `#runtime-alert`, when it sees hostiles or internal emergencies.

Pros:

- Easier to express semantic alerts using full in-game logic.
- Can include intent-level context, not just object state.

Cons:

- Consumes Screeps CPU.
- If the bot crashes or code is not running, it may not emit alerts.

Recommended final design: use both. The external monitor is the primary trigger for visual room state; in-game telemetry enriches alert captions and severity.

## Discord delivery options

There is no direct Screeps-to-Discord feature in the official game API. We need an external bridge:

1. A small monitor process/cron job with Discord webhook or bot credentials.
2. Hermes scheduled job delivery, if it can deliver image attachments reliably to the target channel.
3. A dedicated Discord bot process if we want always-on websocket monitoring and immediate attack alerts.

For attack alerts, an always-on process is better than a periodic cron job because websocket events arrive tick-by-tick and can trigger immediately.

## Recommended implementation plan

### Phase 1: proof-of-concept monitor

- Build a small Node.js or Python monitor outside the Screeps runtime.
- Read untracked env variables:
  - `SCREEPS_AUTH_TOKEN`
  - `SCREEPS_API_URL=https://screeps.com`
  - `SCREEPS_ALERT_DISCORD_WEBHOOK` or bot token/channel mapping
- Discover owned rooms from `/api/user/overview`.
- Fetch/cache terrain from `/api/game/room-terrain`.
- Subscribe to `room:<shard>/<room>` websocket channels.
- Maintain a local full-object cache for each room.
- Render a PNG for `shardX/E48S28`.
- Send one manual summary image to `#runtime-summary`.

### Phase 2: scheduled summaries

- Every 10-30 minutes, render all owned rooms and post an image to `#runtime-summary` (`1497588267057680385`).
- Include concise text: shard, rooms, tick, CPU/bucket if available, hostiles, spawn/creep counts.
- Cache terrain and only refresh terrain daily or when a room appears/disappears.

### Phase 3: alert images

- Add event rules:
  - hostile creep appears
  - owned structure takes significant damage
  - spawn destroyed/missing
  - controller downgrade risk
  - room object cache sees critical structure disappear
- On alert, render the affected room immediately.
- Post to `#runtime-alerts` (`1497588512436785284`) with image and short actionable caption.
- Add debounce, e.g. do not send more than one similar alert per room per 3-5 minutes unless severity increases.

### Phase 4: production hardening

- Reconnect websocket automatically.
- Rebuild full room state after reconnect by waiting for the next full snapshot or explicitly resetting room cache.
- Persist the last alert timestamp per room.
- Avoid printing auth tokens or Discord webhook secrets.
- Add tests for terrain decoding, object-cache patching, renderer output, and alert debouncing.
- Add health reporting to `#runtime-summary` if the monitor loses the Screeps websocket.

## Risks and caveats

- Screeps explicitly labels these endpoints as undocumented; they are allowed but not guaranteed stable like the in-game JavaScript API.
- HTTP token endpoints are rate limited, so the monitor should prefer websocket streaming and terrain caching.
- Websocket room updates after the first event are incremental, so a naive renderer that only draws the latest event will be wrong. We must maintain a full room-state cache.
- Official room visibility may still matter. Owned rooms are visible; remote rooms may require observer/vision to have object data.
- The first implementation should avoid posting images every tick. Use periodic summaries plus debounced alerts to prevent Discord noise.

## Recommendation

Proceed. The feature is technically viable and valuable for operations.

I recommend implementing it as a dedicated external monitor rather than inside Screeps bot code. Screeps code should keep emitting structured `#runtime-summary` / `#runtime-alert` console lines for semantic state, while the external monitor handles official-client API access, rendering, and Discord image delivery.
