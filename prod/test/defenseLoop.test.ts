import { runDefense } from '../src/defense/defenseLoop';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_HOSTILE_CREEPS: 101,
  FIND_HOSTILE_STRUCTURES: 102,
  FIND_MY_STRUCTURES: 103,
  FIND_MY_CREEPS: 104,
  RESOURCE_ENERGY: 'energy',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_TOWER: 'tower'
} as const;

describe('runDefense', () => {
  beforeEach(() => {
    Object.assign(globalThis, TEST_GLOBALS);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { meta: { version: 1 }, creeps: {} };
  });

  it('attacks a visible hostile with an energized owned tower and records evidence', () => {
    const hostile = makeHostile('hostile1');
    const roomFixture = makeOwnedRoom({ hostiles: [hostile] });
    const tower = makeTower(roomFixture.room, {
      id: 'tower1',
      attack: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    roomFixture.setTowers([tower]);

    const events = runDefense();

    expect(tower.attack).toHaveBeenCalledWith(hostile);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'towerAttack',
        roomName: 'W1N1',
        structureId: 'tower1',
        targetId: 'hostile1',
        result: OK_CODE,
        hostileCreepCount: 1
      }
    ]);
    expect(Memory.defense?.rooms?.W1N1).toMatchObject({
      type: 'towerAttack',
      targetId: 'hostile1'
    });
  });

  it('repairs a damaged spawn with a tower when no hostile target is visible', () => {
    const roomFixture = makeOwnedRoom({
      spawnHits: 2_000,
      spawnHitsMax: 5_000
    });
    const tower = makeTower(roomFixture.room, {
      id: 'tower1',
      repair: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    roomFixture.setTowers([tower]);

    const events = runDefense();

    expect(tower.repair).toHaveBeenCalledWith(roomFixture.spawn);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'towerRepair',
        roomName: 'W1N1',
        structureId: 'tower1',
        targetId: 'spawn1',
        result: OK_CODE,
        damagedCriticalStructureCount: 1
      }
    ]);
  });

  it('activates safe mode for an early owned room with hostiles and no remaining spawn', () => {
    const controller = makeController({
      level: 2,
      safeModeAvailable: 1,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    makeOwnedRoom({
      controller,
      hostiles: [makeHostile('hostile1')],
      includeSpawn: false
    });

    const events = runDefense();

    expect(controller.activateSafeMode).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'safeMode',
        roomName: 'W1N1',
        result: OK_CODE,
        reason: 'safeModeEarlyRoomThreat',
        hostileCreepCount: 1
      }
    ]);
  });

  it('records worker fallback evidence when no tower or safe mode response is available', () => {
    makeOwnedRoom({
      controller: makeController({ level: 2, safeModeAvailable: 0 }),
      hostiles: [makeHostile('hostile1')]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {
      Worker1: { memory: { role: 'worker', colony: 'W1N1' } } as Creep
    };

    const events = runDefense();

    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'workerFallback',
        roomName: 'W1N1',
        reason: 'workerEmergencyFallback',
        hostileCreepCount: 1
      }
    ]);
    expect(Memory.defense?.rooms?.W1N1?.type).toBe('workerFallback');
  });

  it('runs an emergency defender creep toward hostile contact', () => {
    const hostile = makeHostile('hostile1');
    const room = makeRoom({
      controller: makeController({ my: false }),
      hostiles: [hostile]
    });
    const defender = {
      name: 'Defender1',
      memory: { role: 'defender', colony: 'W1N1' },
      room,
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      moveTo: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 104,
      rooms: {},
      spawns: {},
      creeps: { Defender1: defender }
    };

    const events = runDefense();

    expect(defender.attack).toHaveBeenCalledWith(hostile);
    expect(defender.moveTo).toHaveBeenCalledWith(hostile);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'defenderMove',
        roomName: 'W1N1',
        structureId: 'Defender1',
        targetId: 'hostile1',
        result: OK_CODE
      }
    ]);
  });
});

interface OwnedRoomFixture {
  room: Room;
  spawn: StructureSpawn | undefined;
  setTowers(towers: StructureTower[]): void;
}

function makeOwnedRoom({
  controller = makeController(),
  hostiles = [],
  hostileStructures = [],
  includeSpawn = true,
  spawnHits = 5_000,
  spawnHitsMax = 5_000
}: {
  controller?: StructureController;
  hostiles?: Creep[];
  hostileStructures?: Structure[];
  includeSpawn?: boolean;
  spawnHits?: number;
  spawnHitsMax?: number;
} = {}): OwnedRoomFixture {
  let towers: StructureTower[] = [];
  const room = makeRoom({ controller, hostiles, hostileStructures, getTowers: () => towers });
  const spawn = includeSpawn
    ? ({
        id: 'spawn1',
        name: 'Spawn1',
        room,
        structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
        hits: spawnHits,
        hitsMax: spawnHitsMax,
        spawning: null
      } as unknown as StructureSpawn)
    : undefined;

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 103,
    rooms: { W1N1: room },
    spawns: spawn ? { Spawn1: spawn } : {},
    creeps: {}
  };

  return {
    room,
    spawn,
    setTowers: (nextTowers: StructureTower[]) => {
      towers = nextTowers;
    }
  };
}

function makeRoom({
  controller,
  hostiles = [],
  hostileStructures = [],
  myCreeps = [],
  getTowers = () => []
}: {
  controller: StructureController;
  hostiles?: Creep[];
  hostileStructures?: Structure[];
  myCreeps?: Creep[];
  getTowers?: () => StructureTower[];
}): Room {
  const room = {
    name: 'W1N1',
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controller,
    find: jest.fn((type: number) => {
      if (type === TEST_GLOBALS.FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === TEST_GLOBALS.FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (type === TEST_GLOBALS.FIND_MY_STRUCTURES) {
        const spawns = Object.values((globalThis as unknown as { Game?: Partial<Game> }).Game?.spawns ?? {});
        return [...spawns, ...getTowers()];
      }

      if (type === TEST_GLOBALS.FIND_MY_CREEPS) {
        return myCreeps;
      }

      return [];
    })
  } as unknown as Room;

  return room;
}

function makeController({
  my = true,
  level = 3,
  safeModeAvailable = 0,
  safeMode,
  safeModeCooldown,
  activateSafeMode = jest.fn()
}: {
  my?: boolean;
  level?: number;
  safeModeAvailable?: number;
  safeMode?: number;
  safeModeCooldown?: number;
  activateSafeMode?: jest.Mock<ScreepsReturnCode, []>;
} = {}): StructureController {
  return {
    id: 'controller1',
    my,
    level,
    safeModeAvailable,
    safeMode,
    safeModeCooldown,
    activateSafeMode
  } as unknown as StructureController;
}

function makeTower(
  room: Room,
  {
    id,
    energy,
    attack = jest.fn(),
    heal = jest.fn(),
    repair = jest.fn()
  }: {
    id: string;
    energy: number;
    attack?: jest.Mock<ScreepsReturnCode, [Creep]>;
    heal?: jest.Mock<ScreepsReturnCode, [Creep]>;
    repair?: jest.Mock<ScreepsReturnCode, [Structure]>;
  }
): StructureTower {
  return {
    id,
    room,
    structureType: TEST_GLOBALS.STRUCTURE_TOWER,
    hits: 3_000,
    hitsMax: 3_000,
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === TEST_GLOBALS.RESOURCE_ENERGY ? energy : 0
      )
    },
    attack,
    heal,
    repair,
    pos: makePosition()
  } as unknown as StructureTower;
}

function makeHostile(id: string): Creep {
  return {
    id,
    owner: { username: 'enemy' },
    pos: makePosition()
  } as unknown as Creep;
}

function makePosition(): RoomPosition {
  return {
    x: 25,
    y: 25,
    roomName: 'W1N1',
    getRangeTo: jest.fn().mockReturnValue(1)
  } as unknown as RoomPosition;
}
