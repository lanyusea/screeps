export interface RoomSpawnSelection {
  name: string;
  x: number;
  y: number;
}

export interface OfficialRoomCandidate {
  shard: string;
  roomName: string;
  status: 'active' | 'fallback' | 'historical';
  spawn?: RoomSpawnSelection;
  notes: string;
}

export interface StaticExpansionScoutTargetSelection {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
}

export const ACTIVE_OFFICIAL_ROOM_SELECTION = {
  branch: 'main',
  shard: 'shardX',
  roomName: 'E29N55',
  spawn: {
    name: 'Spawn1',
    x: 17,
    y: 24
  }
} as const;

export const OFFICIAL_ROOM_CANDIDATES: readonly OfficialRoomCandidate[] = [
  {
    shard: ACTIVE_OFFICIAL_ROOM_SELECTION.shard,
    roomName: ACTIVE_OFFICIAL_ROOM_SELECTION.roomName,
    status: 'active',
    spawn: ACTIVE_OFFICIAL_ROOM_SELECTION.spawn,
    notes: 'Current official MMO room selected after the W3N9 room_dead recovery.'
  },
  {
    shard: 'shardX',
    roomName: 'W3N9',
    status: 'fallback',
    spawn: { name: 'Spawn1', x: 35, y: 23 },
    notes: 'Previous official target retained only as a fallback/audit candidate.'
  },
  {
    shard: 'shardX',
    roomName: 'E19S57',
    status: 'fallback',
    notes: 'Prior recovery candidate from the owner-approved fallback sequence.'
  },
  {
    shard: 'shardX',
    roomName: 'E26S49',
    status: 'fallback',
    notes: 'Prior official room and fallback candidate; not an active default.'
  },
  {
    shard: 'shardX',
    roomName: 'E17S59',
    status: 'fallback',
    notes: 'Legacy expansion/logistics root retained as a non-active fallback candidate.'
  }
] as const;

export const REPLACED_ACTIVE_OFFICIAL_ROOM_NAMES = OFFICIAL_ROOM_CANDIDATES
  .filter((candidate) => candidate.status !== 'active')
  .map((candidate) => candidate.roomName);

export const ACTIVE_OFFICIAL_SHARDS = [ACTIVE_OFFICIAL_ROOM_SELECTION.shard] as const;
export const ACTIVE_OFFICIAL_ROOM_NAMES = [ACTIVE_OFFICIAL_ROOM_SELECTION.roomName] as const;

export const LOGISTICS_ROOM_SELECTION = {
  corridorRooms: ['E17S58', 'E17S59', 'E18S59'],
  safeTransitRooms: ['E17S59'],
  localFirstEnergyRooms: ['E17S58', 'E18S59'],
  localFirstSourceRoom: 'E17S59',
  prioritizedExportRoutes: [{ sourceRoom: 'E17S59', targetRoom: 'E18S59' }]
} as const;

const activeRoom = ACTIVE_OFFICIAL_ROOM_SELECTION.roomName;

export const TERRITORY_EXPANSION_ROOM_SELECTION = {
  scoutTargets: [
    {
      colony: activeRoom,
      roomName: 'E29N54',
      nearestOwnedRoom: activeRoom,
      nearestOwnedRoomDistance: 1,
      routeDistance: 1,
      adjacentToOwnedRoom: true,
      scoutOnly: true
    },
    {
      colony: activeRoom,
      roomName: 'E30N55',
      nearestOwnedRoom: activeRoom,
      nearestOwnedRoomDistance: 1,
      routeDistance: 1,
      adjacentToOwnedRoom: true,
      scoutOnly: true
    },
    {
      colony: LOGISTICS_ROOM_SELECTION.localFirstSourceRoom,
      roomName: 'E18S59',
      nearestOwnedRoom: LOGISTICS_ROOM_SELECTION.localFirstSourceRoom,
      nearestOwnedRoomDistance: 1,
      routeDistance: 1,
      adjacentToOwnedRoom: true
    },
    {
      colony: LOGISTICS_ROOM_SELECTION.localFirstSourceRoom,
      roomName: 'E17S60',
      nearestOwnedRoom: LOGISTICS_ROOM_SELECTION.localFirstEnergyRooms[0],
      nearestOwnedRoomDistance: 1,
      routeDistance: 2,
      adjacentToOwnedRoom: true
    }
  ] as readonly StaticExpansionScoutTargetSelection[]
} as const;

export const PRODUCTION_ROOM_SELECTION_LITERAL_NAMES = Array.from(new Set([
  ACTIVE_OFFICIAL_ROOM_SELECTION.shard,
  ACTIVE_OFFICIAL_ROOM_SELECTION.roomName,
  ...OFFICIAL_ROOM_CANDIDATES.map((candidate) => candidate.roomName),
  ...OFFICIAL_ROOM_CANDIDATES.map((candidate) => candidate.shard),
  ...LOGISTICS_ROOM_SELECTION.corridorRooms,
  ...LOGISTICS_ROOM_SELECTION.safeTransitRooms,
  ...LOGISTICS_ROOM_SELECTION.localFirstEnergyRooms,
  LOGISTICS_ROOM_SELECTION.localFirstSourceRoom,
  ...LOGISTICS_ROOM_SELECTION.prioritizedExportRoutes.flatMap((route) => [route.sourceRoom, route.targetRoom]),
  ...TERRITORY_EXPANSION_ROOM_SELECTION.scoutTargets.flatMap((target) => [
    target.colony,
    target.roomName,
    target.nearestOwnedRoom
  ])
]));
