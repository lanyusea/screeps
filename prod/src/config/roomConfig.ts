export const OFFICIAL_SHARD = 'shardX';
export const ACTIVE_OFFICIAL_ROOM = 'W3N9';

export const OFFICIAL_ROOM_CANDIDATES = [
  'E17S59',
  'E26S49',
  'E19S57',
  ACTIVE_OFFICIAL_ROOM
] as const;

export const STRATEGY_SUPPORTED_SHARDS = [OFFICIAL_SHARD] as const;
export const STRATEGY_SUPPORTED_ROOMS = [ACTIVE_OFFICIAL_ROOM] as const;

export const ECONOMY_CORRIDOR_ROOMS = ['E17S58', 'E17S59', 'E18S59'] as const;
export const LOCAL_FIRST_ENERGY_ROOMS = ['E17S58', 'E18S59'] as const;
export const LOCAL_FIRST_SOURCE_ROOMS = ['E17S59'] as const;
export const SAFE_TRANSIT_ALLOWLIST = ['E17S59'] as const;

export const CORRIDOR_EXPORTER_PRIORITY_PAIRS = [
  {
    sourceRoom: 'E17S59',
    targetRoom: 'E18S59',
    priority: 0
  }
] as const;

export interface StaticExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
}

export const STATIC_EXPANSION_SCOUT_TARGETS: readonly StaticExpansionScoutTargetConfig[] = [
  {
    colony: ACTIVE_OFFICIAL_ROOM,
    roomName: 'W3N8',
    nearestOwnedRoom: ACTIVE_OFFICIAL_ROOM,
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  },
  {
    colony: ACTIVE_OFFICIAL_ROOM,
    roomName: 'W2N9',
    nearestOwnedRoom: ACTIVE_OFFICIAL_ROOM,
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  },
  {
    colony: 'E17S59',
    roomName: 'E18S59',
    nearestOwnedRoom: 'E17S59',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true
  },
  {
    colony: 'E17S59',
    roomName: 'E17S60',
    nearestOwnedRoom: 'E17S58',
    nearestOwnedRoomDistance: 1,
    routeDistance: 2,
    adjacentToOwnedRoom: true
  }
];
