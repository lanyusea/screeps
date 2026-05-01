import { runDefense } from '../src/defense/defenseLoop';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
type TestFindRouteOptions = { routeCallback?: (roomName: string, fromRoomName: string) => number };

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
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {
      Worker1: { memory: { role: 'worker', colony: 'W1N1' } } as Creep
    };

    const events = runDefense();

    expect(tower.attack).toHaveBeenCalledWith(hostile);
    expect(events).toHaveLength(1);
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

  it('falls back to the nearest hostile structure when no hostile creep is visible', () => {
    const farStructure = makeHostileStructure('structure-a', 34, 25);
    const nearStructure = makeHostileStructure('structure-z', 26, 25);
    const roomFixture = makeOwnedRoom({ hostileStructures: [farStructure, nearStructure] });
    const tower = makeTower(roomFixture.room, {
      id: 'tower1',
      attack: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    roomFixture.setTowers([tower]);

    const events = runDefense();

    expect(tower.attack).toHaveBeenCalledWith(nearStructure);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'towerAttack',
        roomName: 'W1N1',
        structureId: 'tower1',
        targetId: 'structure-z',
        result: OK_CODE,
        hostileCreepCount: 0,
        hostileStructureCount: 2
      }
    ]);
  });

  it('prefers hostile creeps before falling back to closer hostile structures', () => {
    const hostile = makeHostile('hostile1', 35, 25);
    const hostileStructure = makeHostileStructure('structure1', 26, 25);
    const roomFixture = makeOwnedRoom({
      hostiles: [hostile],
      hostileStructures: [hostileStructure]
    });
    const tower = makeTower(roomFixture.room, {
      id: 'tower1',
      attack: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    roomFixture.setTowers([tower]);

    runDefense();

    expect(tower.attack).toHaveBeenCalledWith(hostile);
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

  it('lets non-attacking towers recover while another tower attacks', () => {
    const hostile = makeHostile('hostile1');
    const roomFixture = makeOwnedRoom({
      hostiles: [hostile],
      spawnHits: 2_000,
      spawnHitsMax: 5_000
    });
    const attackingTower = makeTower(roomFixture.room, {
      id: 'tower-attack',
      attack: jest.fn().mockReturnValue(OK_CODE),
      repair: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    const recoveryTower = makeTower(roomFixture.room, {
      id: 'tower-recover',
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      repair: jest.fn().mockReturnValue(OK_CODE),
      energy: 500
    });
    roomFixture.setTowers([attackingTower, recoveryTower]);

    const events = runDefense();

    expect(attackingTower.attack).toHaveBeenCalledWith(hostile);
    expect(attackingTower.repair).not.toHaveBeenCalled();
    expect(recoveryTower.repair).toHaveBeenCalledWith(roomFixture.spawn);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'towerAttack',
        structureId: 'tower-attack',
        targetId: 'hostile1',
        result: OK_CODE
      },
      {
        type: 'defense',
        action: 'towerAttack',
        structureId: 'tower-recover',
        targetId: 'hostile1',
        result: ERR_NOT_IN_RANGE_CODE
      },
      {
        type: 'defense',
        action: 'towerRepair',
        structureId: 'tower-recover',
        targetId: 'spawn1',
        result: OK_CODE
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

  it('records defender action evidence against the defender room when away from home', () => {
    const homeRoom = makeRoom({
      roomName: 'W1N1',
      controller: makeController()
    });
    const homeSpawn = {
      id: 'home-spawn',
      name: 'HomeSpawn',
      room: homeRoom,
      structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
      hits: 1_000,
      hitsMax: 5_000,
      spawning: null
    } as unknown as StructureSpawn;
    const hostile = makeHostile('remote-hostile', 26, 25, 'W2N1');
    const remoteRoom = makeRoom({
      roomName: 'W2N1',
      controller: makeController({ my: false }),
      hostiles: [hostile]
    });
    const defender = {
      name: 'Defender1',
      memory: { role: 'defender', colony: 'W1N1' },
      pos: makePosition(25, 25, 'W2N1'),
      room: remoteRoom,
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      moveTo: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 107,
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      spawns: { HomeSpawn: homeSpawn },
      creeps: { Defender1: defender }
    };

    const events = runDefense();

    expect(defender.attack).toHaveBeenCalledWith(hostile);
    expect(defender.moveTo).toHaveBeenCalledWith(hostile);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'defenderMove',
        roomName: 'W2N1',
        structureId: 'Defender1',
        targetId: 'remote-hostile',
        result: OK_CODE,
        hostileCreepCount: 1,
        damagedCriticalStructureCount: 0
      }
    ]);
    expect(Memory.defense?.rooms?.W2N1).toMatchObject({
      type: 'defenderMove',
      damagedCriticalStructureCount: 0
    });
    expect(Memory.defense?.rooms?.W1N1).toBeUndefined();
  });

  it('runs a defender toward the nearest hostile creep before id order', () => {
    const farHostile = makeHostile('hostile-a', 35, 25);
    const nearHostile = makeHostile('hostile-z', 26, 25);
    const room = makeRoom({
      controller: makeController({ my: false }),
      hostiles: [farHostile, nearHostile]
    });
    const defender = {
      name: 'Defender1',
      memory: { role: 'defender', colony: 'W1N1' },
      pos: makePosition(25, 25),
      room,
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      moveTo: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 105,
      rooms: {},
      spawns: {},
      creeps: { Defender1: defender }
    };

    const events = runDefense();

    expect(defender.attack).toHaveBeenCalledWith(nearHostile);
    expect(defender.moveTo).toHaveBeenCalledWith(nearHostile);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'defenderMove',
        targetId: 'hostile-z'
      }
    ]);
  });

  it('runs a defender toward the nearest hostile structure when no hostile creep is visible', () => {
    const farStructure = makeHostileStructure('structure-a', 34, 25);
    const nearStructure = makeHostileStructure('structure-z', 26, 25);
    const room = makeRoom({
      controller: makeController({ my: false }),
      hostileStructures: [farStructure, nearStructure]
    });
    const defender = {
      name: 'Defender1',
      memory: { role: 'defender', colony: 'W1N1' },
      pos: makePosition(25, 25),
      room,
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      moveTo: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 106,
      rooms: {},
      spawns: {},
      creeps: { Defender1: defender }
    };

    const events = runDefense();

    expect(defender.attack).toHaveBeenCalledWith(nearStructure);
    expect(defender.moveTo).toHaveBeenCalledWith(nearStructure);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'defenderMove',
        targetId: 'structure-z'
      }
    ]);
  });

  it('does not path a defender toward a known enemy tower room when no safe route exists', () => {
    const hostileTower = makeHostileStructure('enemy-tower', 25, 25, 'W2N1', TEST_GLOBALS.STRUCTURE_TOWER);
    const deadZoneRoom = makeRoom({
      roomName: 'W2N1',
      controller: makeController({ my: false }),
      hostileStructures: [hostileTower]
    });
    const remoteHostile = makeHostile('remote-hostile', 25, 25, 'W2N1');
    const homeRoom = makeRoom({
      roomName: 'W1N1',
      controller: makeController(),
      hostiles: [remoteHostile]
    });
    const findRoute = jest.fn((_fromRoom: string, _toRoom: string, options?: TestFindRouteOptions) =>
      options?.routeCallback?.('W2N1', 'W1N1') === Infinity
        ? ERR_NO_PATH_CODE
        : [{ exit: 3, room: 'W2N1' }]
    );
    const defender = {
      name: 'Defender1',
      memory: { role: 'defender', colony: 'W1N1' },
      pos: makePosition(25, 25, 'W1N1'),
      room: homeRoom,
      attack: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE),
      moveTo: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 108,
      map: { findRoute } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: deadZoneRoom },
      spawns: {},
      creeps: { Defender1: defender }
    };

    const events = runDefense();

    expect(defender.attack).toHaveBeenCalledWith(remoteHostile);
    expect(defender.moveTo).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(Memory.defense?.unsafeRooms?.W2N1).toMatchObject({
      roomName: 'W2N1',
      unsafe: true,
      reason: 'enemyTower',
      hostileTowerCount: 1
    });
  });

  it('marks dead-zone rooms as unsafe in defense memory', () => {
    const hostileTower = makeHostileStructure('enemy-tower', 25, 25, 'W2N1', TEST_GLOBALS.STRUCTURE_TOWER);
    const deadZoneRoom = makeRoom({
      roomName: 'W2N1',
      controller: makeController({ my: false }),
      hostileStructures: [hostileTower]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 109,
      rooms: { W2N1: deadZoneRoom },
      spawns: {},
      creeps: {}
    };

    runDefense();

    expect(Memory.defense?.unsafeRooms?.W2N1).toEqual({
      roomName: 'W2N1',
      unsafe: true,
      reason: 'enemyTower',
      updatedAt: 109,
      hostileCreepCount: 0,
      hostileStructureCount: 1,
      hostileTowerCount: 1
    });
  });

  it('suppresses territory intent with a dead-zone reason when all paths to target cross dead zones', () => {
    const colonyRoom = makeRoom({ roomName: 'W1N1', controller: makeController() });
    const hostileTower = makeHostileStructure('enemy-tower', 25, 25, 'W2N1', TEST_GLOBALS.STRUCTURE_TOWER);
    const deadZoneRoom = makeRoom({
      roomName: 'W2N1',
      controller: makeController({ my: false }),
      hostileStructures: [hostileTower]
    });
    const targetRoom = makeRoom({
      roomName: 'W3N1',
      controller: makeController({ my: false })
    });
    const findRoute = jest.fn((_fromRoom: string, toRoom: string, options?: TestFindRouteOptions) =>
      options?.routeCallback?.('W2N1', 'W1N1') === Infinity
        ? ERR_NO_PATH_CODE
        : [
            { exit: 3, room: 'W2N1' },
            { exit: 3, room: toRoom }
          ]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 110,
      map: { findRoute } as unknown as GameMap,
      rooms: { W1N1: colonyRoom, W2N1: deadZoneRoom, W3N1: targetRoom },
      spawns: {},
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      meta: { version: 1 },
      creeps: {},
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }]
      }
    };

    runDefense();
    const plan = planTerritoryIntent(
      { room: colonyRoom, spawns: [], energyAvailable: 650, energyCapacityAvailable: 650 },
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      110
    );

    expect(plan).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 110,
        reason: 'deadZoneRoute'
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
  roomName = 'W1N1',
  controller,
  hostiles = [],
  hostileStructures = [],
  myCreeps = [],
  getTowers = () => []
}: {
  roomName?: string;
  controller: StructureController;
  hostiles?: Creep[];
  hostileStructures?: Structure[];
  myCreeps?: Creep[];
  getTowers?: () => StructureTower[];
}): Room {
  const room = {
    name: roomName,
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
    attack?: jest.Mock<ScreepsReturnCode, [Creep | Structure]>;
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

function makeHostile(id: string, x = 25, y = 25, roomName = 'W1N1'): Creep {
  return {
    id,
    owner: { username: 'enemy' },
    pos: makePosition(x, y, roomName)
  } as unknown as Creep;
}

function makeHostileStructure(
  id: string,
  x = 25,
  y = 25,
  roomName = 'W1N1',
  structureType: StructureConstant = 'rampart'
): Structure {
  return {
    id,
    structureType,
    pos: makePosition(x, y, roomName)
  } as unknown as Structure;
}

function makePosition(x = 25, y = 25, roomName = 'W1N1'): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: jest.fn((target?: { x?: number; y?: number }) => {
      if (typeof target?.x !== 'number' || typeof target.y !== 'number') {
        return 1;
      }

      return Math.max(Math.abs(x - target.x), Math.abs(y - target.y));
    })
  } as unknown as RoomPosition;
}
