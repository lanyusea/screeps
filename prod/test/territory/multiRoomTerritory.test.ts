import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import { refreshExpansionExecutorIntent } from '../../src/territory/expansionExecutor';
import { selectTerritoryClaimOwner } from '../../src/territory/multiRoomTerritory';
import { planTerritoryIntent } from '../../src/territory/territoryPlanner';

describe('multi-room territory coordination', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  });

  it('assigns visible expansion priorities to distinct owned rooms by route distance', () => {
    const west = makeColony('W1N1');
    const east = makeColony('W3N1');
    installGame([west, east], 900);
    setSafeHomeThreat('W1N1', 900);
    setSafeHomeThreat('W3N1', 900);

    expect(refreshExpansionExecutorIntent(west, 900)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1'
    });
    expect(refreshExpansionExecutorIntent(east, 900)).toMatchObject({
      status: 'planned',
      colony: 'W3N1',
      targetRoom: 'W4N1'
    });

    expect(Memory.territory?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ colony: 'W1N1', roomName: 'W2N1' }),
        expect.objectContaining({ colony: 'W3N1', roomName: 'W4N1' })
      ])
    );
    expect(new Set((Memory.territory?.targets ?? []).map((target) => target.roomName)).size).toBe(
      Memory.territory?.targets?.length
    );
    expect(Memory.territory?.expansionCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ colony: 'W1N1', roomName: 'W2N1', rank: 1 }),
        expect.objectContaining({ colony: 'W3N1', roomName: 'W4N1', rank: 1 })
      ])
    );
  });

  it('does not let two owned rooms plan a claim for the same target', () => {
    const west = makeColony('W1N1');
    const east = makeColony('W3N1');
    installGame([west, east], 910);
    Memory.territory = {
      targets: [
        { colony: 'W1N1', roomName: 'W4N1', action: 'claim' },
        { colony: 'W3N1', roomName: 'W4N1', action: 'claim' }
      ]
    };

    expect(planTerritoryIntent(west, readyRoleCounts(), 3, 910)).not.toMatchObject({
      targetRoom: 'W4N1',
      action: 'claim'
    });
    expect(planTerritoryIntent(east, readyRoleCounts(), 3, 910)).toMatchObject({
      colony: 'W3N1',
      targetRoom: 'W4N1',
      action: 'claim'
    });
    expect(Memory.territory?.targets).toEqual(
      expect.arrayContaining([{ colony: 'W3N1', roomName: 'W4N1', action: 'claim' }])
    );
    expect(Memory.territory?.targets).not.toEqual(
      expect.arrayContaining([{ colony: 'W1N1', roomName: 'W4N1', action: 'claim' }])
    );
  });

  it('prefers a resource-ready claim room over a closer room that cannot spawn the claim package now', () => {
    const lowEnergyWest = makeColony('W1N1', { energyAvailable: 300 });
    const readyEast = makeColony('W3N1');
    installGame([lowEnergyWest, readyEast], 920);
    Memory.territory = {
      targets: [
        { colony: 'W1N1', roomName: 'W2N1', action: 'claim' },
        { colony: 'W3N1', roomName: 'W2N1', action: 'claim' }
      ]
    };

    expect(planTerritoryIntent(lowEnergyWest, readyRoleCounts(), 3, 920)).toBeNull();
    expect(planTerritoryIntent(readyEast, readyRoleCounts(), 3, 920)).toMatchObject({
      colony: 'W3N1',
      targetRoom: 'W2N1',
      action: 'claim'
    });
  });

  it('prefers a Seasonal RCL3 room at 800 energy over an RCL5 room still short of claim energy', () => {
    const seasonalRcl3 = makeColony('W1N1', {
      controllerLevel: 3,
      energyAvailable: 800,
      energyCapacityAvailable: 800
    });
    const waitingRcl5 = makeColony('W3N1', {
      controllerLevel: 5,
      energyAvailable: 1_049,
      energyCapacityAvailable: 1_800
    });
    installGame([seasonalRcl3, waitingRcl5], 925);
    (Game as { shard: Game['shard'] }).shard = { name: 'shardSeason', type: 'normal' } as Game['shard'];
    Memory.territory = {
      targets: [
        { colony: 'W1N1', roomName: 'W2N1', action: 'claim' },
        { colony: 'W3N1', roomName: 'W2N1', action: 'claim' }
      ]
    };

    expect(selectTerritoryClaimOwner({ colony: seasonalRcl3, targetRoom: 'W2N1' })).toBe('W1N1');
  });

  it('ignores destroyed spawn references while selecting a claim owner', () => {
    const west = makeColony('W1N1');
    installGame([west], 930);
    (west.spawns as unknown as Array<StructureSpawn | null>).push(null);

    expect(() => selectTerritoryClaimOwner({ colony: west, targetRoom: 'W2N1' })).not.toThrow();
  });

  it('reuses route distances for the same room pairs during one tick', () => {
    const west = makeColony('W1N1');
    const east = makeColony('W3N1');
    installGame([west, east], 940);
    const findRoute = (Game.map.findRoute as jest.Mock).mockClear();

    selectTerritoryClaimOwner({ colony: west, targetRoom: 'W4N1' });
    selectTerritoryClaimOwner({ colony: west, targetRoom: 'W4N1' });

    expect(findRoute).toHaveBeenCalledTimes(2);
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W4N1');
    expect(findRoute).toHaveBeenCalledWith('W3N1', 'W4N1');
  });
});

function makeColony(
  roomName: string,
  options: { energyAvailable?: number; energyCapacityAvailable?: number; controllerLevel?: number } = {}
): ColonySnapshot {
  const energyAvailable = options.energyAvailable ?? 1_300;
  const energyCapacityAvailable = options.energyCapacityAvailable ?? 1_300;
  const room = makeOwnedRoom(roomName, {
    energyAvailable,
    energyCapacityAvailable,
    controllerLevel: options.controllerLevel ?? 6
  });
  const spawn = makeActiveSpawn(`spawn-${roomName}`, room);

  return {
    room,
    spawns: [spawn],
    energyAvailable,
    energyCapacityAvailable,
    memory: room.memory
  };
}

function makeOwnedRoom(
  roomName: string,
  options: { energyAvailable: number; energyCapacityAvailable: number; controllerLevel: number }
): Room & { memory: RoomMemory } {
  return {
    name: roomName,
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyCapacityAvailable,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: options.controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    storage: {
      store: {
        getUsedCapacity: jest.fn(() => 0)
      }
    },
    memory: {},
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName, 2) : []))
  } as unknown as Room & { memory: RoomMemory };
}

function makeExpansionRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false,
      pos: makePosition(25, 25, roomName)
    } as StructureController,
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName, 2) : []))
  } as unknown as Room;
}

function makeActiveSpawn(name: string, room: Room): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    room,
    spawning: null,
    isActive: jest.fn(() => true)
  } as unknown as StructureSpawn;
}

function installGame(colonies: ColonySnapshot[], time: number): void {
  const rooms: Record<string, Room> = {
    W2N1: makeExpansionRoom('W2N1'),
    W4N1: makeExpansionRoom('W4N1')
  };
  const spawns: Record<string, StructureSpawn> = {};
  for (const colony of colonies) {
    rooms[colony.room.name] = colony.room;
    for (const spawn of colony.spawns) {
      spawns[spawn.name] = spawn;
    }
  }

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms,
    spawns,
    map: {
      describeExits: jest.fn((roomName: string) => {
        switch (roomName) {
          case 'W1N1':
            return { '3': 'W2N1' };
          case 'W2N1':
            return { '3': 'W3N1', '7': 'W1N1' };
          case 'W3N1':
            return { '3': 'W4N1', '7': 'W2N1' };
          case 'W4N1':
            return { '7': 'W3N1' };
          default:
            return {};
        }
      }),
      findRoute: jest.fn((fromRoom: string, toRoom: string) => makeRoute(fromRoom, toRoom)),
      getRoomTerrain: jest.fn(() => makeTerrain(0))
    } as unknown as GameMap
  };
}

function makeRoute(fromRoom: string, toRoom: string): unknown {
  if (fromRoom === toRoom) {
    return [];
  }

  const routeLengths: Record<string, number> = {
    'W1N1>W2N1': 1,
    'W1N1>W3N1': 2,
    'W1N1>W4N1': 3,
    'W3N1>W1N1': 2,
    'W3N1>W2N1': 1,
    'W3N1>W4N1': 1
  };
  const length = routeLengths[`${fromRoom}>${toRoom}`];
  return length === undefined
    ? (-2 as ScreepsReturnCode)
    : Array.from({ length }, (_value, index) => ({ exit: 3, room: `${fromRoom}-${toRoom}-${index}` }));
}

function makeSources(roomName: string, count: number): Source[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${roomName}-source-${index}` as Id<Source>,
    pos: makePosition(10 + index * 20, 10, roomName)
  })) as Source[];
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeTerrain(mask: number): RoomTerrain {
  return {
    get: jest.fn(() => mask)
  } as unknown as RoomTerrain;
}

function readyRoleCounts(): { worker: number; claimer: number; claimersByTargetRoom: Record<string, number> } {
  return { worker: 3, claimer: 0, claimersByTargetRoom: {} };
}

function setSafeHomeThreat(roomName: string, updatedAt: number): void {
  Memory.defense = {
    ...(Memory.defense ?? {}),
    colonyThreats: {
      updatedAt,
      rooms: {
        ...(Memory.defense?.colonyThreats?.rooms ?? {}),
        [roomName]: {
          roomName,
          level: 'none',
          updatedAt,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          damagedCriticalStructureCount: 0
        }
      }
    }
  };
}
