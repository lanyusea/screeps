import { runSafeMode, SAFE_MODE_HOSTILE_COUNT_THRESHOLD } from '../src/defense/safeModeManager';
import { runTowers } from '../src/defense/towerManager';
import { planDefenseSpawn } from '../src/spawn/spawnPlanner';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_HOSTILE_CREEPS: 101,
  FIND_HOSTILE_STRUCTURES: 102,
  FIND_MY_STRUCTURES: 103,
  FIND_MY_CREEPS: 104,
  RESOURCE_ENERGY: 'energy',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_CONTROLLER: 'controller',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_RAMPART: 'rampart',
  ATTACK: 'attack'
} as const;

describe('automatic room defense response', () => {
  beforeEach(() => {
    Object.assign(globalThis, TEST_GLOBALS);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { meta: { version: 1 }, creeps: {} };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {},
      spawns: {},
      creeps: {}
    };
  });

  it('prioritizes tower healing own wounded creeps before attacking or repairing', () => {
    const hostile = makeHostile('hostile1');
    const wounded = makeFriendlyCreep('worker1', 25, 25, 70, 100);
    const spawn = makeSpawn('spawn1', 1_000, 5_000);
    const tower = makeTower('tower1', { energy: 500 });
    const room = makeRoom({ hostiles: [hostile], myCreeps: [wounded], structures: [spawn, tower] });
    attachRoom([spawn, tower], room);

    const events = runTowers(room);

    expect(tower.heal).toHaveBeenCalledWith(wounded);
    expect(tower.attack).not.toHaveBeenCalled();
    expect(tower.repair).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ type: 'defense', action: 'towerHeal', targetId: 'worker1' }]);
  });

  it('attacks hostile creeps before repairing damaged critical structures', () => {
    const hostile = makeHostile('hostile1');
    const spawn = makeSpawn('spawn1', 1_000, 5_000);
    const tower = makeTower('tower1', { energy: 500 });
    const room = makeRoom({ hostiles: [hostile], structures: [spawn, tower] });
    attachRoom([spawn, tower], room);

    runTowers(room);

    expect(tower.attack).toHaveBeenCalledWith(hostile);
    expect(tower.repair).not.toHaveBeenCalled();
  });

  it('selects hostile targets independently for each tower by range', () => {
    const leftHostile = makeHostile('hostile-left', 12, 25);
    const rightHostile = makeHostile('hostile-right', 38, 25);
    const leftTower = makeTower('tower-left', { energy: 500, x: 10, y: 25 });
    const rightTower = makeTower('tower-right', { energy: 500, x: 40, y: 25 });
    const room = makeRoom({ hostiles: [rightHostile, leftHostile], structures: [leftTower, rightTower] });
    attachRoom([leftTower, rightTower], room);

    runTowers(room);

    expect(leftTower.attack).toHaveBeenCalledWith(leftHostile);
    expect(rightTower.attack).toHaveBeenCalledWith(rightHostile);
  });

  it('keeps low-energy towers from healing or repairing so attack reserve is preserved', () => {
    const wounded = makeFriendlyCreep('worker1', 25, 25, 70, 100);
    const spawn = makeSpawn('spawn1', 1_000, 5_000);
    const tower = makeTower('tower1', { energy: 100 });
    const room = makeRoom({ myCreeps: [wounded], structures: [spawn, tower] });
    attachRoom([spawn, tower], room);

    const events = runTowers(room);

    expect(tower.heal).not.toHaveBeenCalled();
    expect(tower.repair).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('repairs ramparts below the critical damage ratio with available tower reserve', () => {
    const rampart = makeRampart('rampart-low', 200_000_000, 300_000_000);
    const tower = makeTower('tower1', { energy: 500 });
    const room = makeRoom({ structures: [rampart, tower] });
    attachRoom([tower], room);

    const events = runTowers(room);

    expect(tower.repair).toHaveBeenCalledWith(rampart);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'towerRepair',
        targetId: 'rampart-low',
        damagedCriticalStructureCount: 1
      }
    ]);
  });

  it('skips ramparts above the critical damage ratio to preserve tower energy', () => {
    const rampart = makeRampart('rampart-high', 270_000_000, 300_000_000);
    const tower = makeTower('tower1', { energy: 500 });
    const room = makeRoom({ structures: [rampart, tower] });
    attachRoom([tower], room);

    const events = runTowers(room);

    expect(tower.repair).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('scales defender body size from room hostile count', () => {
    const oneHostileRoom = installSpawnPlanningRoom({ hostileCount: 1, energyAvailable: 600 });
    const oneHostilePlan = planDefenseSpawn(oneHostileRoom);

    const fourHostileRoom = installSpawnPlanningRoom({ hostileCount: 4, energyAvailable: 600 });
    const fourHostilePlan = planDefenseSpawn(fourHostileRoom);

    expect(oneHostilePlan?.body).toEqual(['tough', 'attack', 'move']);
    expect(fourHostilePlan?.body).toEqual([
      'tough',
      'attack',
      'move',
      'tough',
      'attack',
      'move',
      'tough',
      'attack',
      'move',
      'tough',
      'attack',
      'move'
    ]);
  });

  it('does not plan defenders when hostiles are cleared or no defender body is affordable', () => {
    expect(planDefenseSpawn(installSpawnPlanningRoom({ hostileCount: 0, energyAvailable: 600 }))).toBeNull();
    expect(planDefenseSpawn(installSpawnPlanningRoom({ hostileCount: 1, energyAvailable: 139 }))).toBeNull();
  });

  it('activates safe mode when hostile pressure exceeds threshold and the controller is under attack', () => {
    const controller = makeController({
      safeModeAvailable: 1,
      upgradeBlocked: 10,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    const spawn = makeSpawn('spawn1');
    const room = makeRoom({
      controller,
      hostiles: makeHostiles(SAFE_MODE_HOSTILE_COUNT_THRESHOLD + 1),
      structures: [spawn]
    });
    attachRoom([spawn], room);

    const events = runSafeMode(room);

    expect(controller.activateSafeMode).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'safeMode',
        roomName: 'W1N1',
        hostileCreepCount: SAFE_MODE_HOSTILE_COUNT_THRESHOLD + 1,
        result: OK_CODE
      }
    ]);
  });

  it('activates safe mode before the last spawn is lost when hostiles critically damage it', () => {
    const controller = makeController({
      safeModeAvailable: 1,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    const spawn = makeSpawn('spawn1', 1_000, 5_000);
    const room = makeRoom({
      controller,
      hostiles: [makeHostile('hostile1')],
      structures: [spawn]
    });
    attachRoom([spawn], room);

    const events = runSafeMode(room);

    expect(controller.activateSafeMode).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([
      {
        type: 'defense',
        action: 'safeMode',
        roomName: 'W1N1',
        hostileCreepCount: 1,
        result: OK_CODE
      }
    ]);
  });

  it('keeps safe mode idle under light hostile pressure when spawn damage is not critical', () => {
    const controller = makeController({
      safeModeAvailable: 1,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    const spawn = makeSpawn('spawn1', 2_000, 5_000);
    const room = makeRoom({
      controller,
      hostiles: [makeHostile('hostile1')],
      structures: [spawn]
    });
    attachRoom([spawn], room);

    expect(runSafeMode(room)).toEqual([]);
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });

  it('does not attempt safe mode while safe mode is on cooldown', () => {
    const controller = makeController({
      safeModeAvailable: 1,
      safeModeCooldown: 50,
      upgradeBlocked: 10,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    const spawn = makeSpawn('spawn1');
    const room = makeRoom({
      controller,
      hostiles: makeHostiles(SAFE_MODE_HOSTILE_COUNT_THRESHOLD + 1),
      structures: [spawn]
    });
    attachRoom([spawn], room);

    expect(runSafeMode(room)).toEqual([]);
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });

  it('no-ops across towers, defender spawning, and safe mode when no hostiles are present', () => {
    const controller = makeController({
      safeModeAvailable: 1,
      upgradeBlocked: 10,
      activateSafeMode: jest.fn().mockReturnValue(OK_CODE)
    });
    const spawn = makeSpawn('spawn1');
    const tower = makeTower('tower1', { energy: 500 });
    const room = makeRoom({ controller, structures: [spawn, tower] });
    attachRoom([spawn, tower], room);
    installGame(room, spawn);

    expect(runTowers(room)).toEqual([]);
    expect(planDefenseSpawn(room)).toBeNull();
    expect(runSafeMode(room)).toEqual([]);
    expect(tower.attack).not.toHaveBeenCalled();
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });
});

function installSpawnPlanningRoom({
  hostileCount,
  energyAvailable
}: {
  hostileCount: number;
  energyAvailable: number;
}): Room {
  const spawn = makeSpawn('spawn1');
  const room = makeRoom({
    hostiles: makeHostiles(hostileCount),
    structures: [spawn],
    energyAvailable,
    energyCapacityAvailable: energyAvailable
  });
  attachRoom([spawn], room);
  installGame(room, spawn);
  return room;
}

function installGame(room: Room, spawn?: StructureSpawn): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 200,
    rooms: { [room.name]: room },
    spawns: spawn ? { Spawn1: spawn } : {},
    creeps: {}
  };
}

function makeRoom({
  roomName = 'W1N1',
  controller = makeController(),
  hostiles = [],
  hostileStructures = [],
  myCreeps = [],
  structures = [],
  energyAvailable = 300,
  energyCapacityAvailable = 300
}: {
  roomName?: string;
  controller?: StructureController;
  hostiles?: Creep[];
  hostileStructures?: Structure[];
  myCreeps?: Creep[];
  structures?: AnyOwnedStructure[];
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): Room {
  return {
    name: roomName,
    controller,
    energyAvailable,
    energyCapacityAvailable,
    find: jest.fn((type: number) => {
      if (type === TEST_GLOBALS.FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === TEST_GLOBALS.FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (type === TEST_GLOBALS.FIND_MY_STRUCTURES) {
        return structures;
      }

      if (type === TEST_GLOBALS.FIND_MY_CREEPS) {
        return myCreeps;
      }

      return [];
    })
  } as unknown as Room;
}

function makeController({
  safeModeAvailable = 0,
  safeMode,
  safeModeCooldown,
  upgradeBlocked = 0,
  activateSafeMode = jest.fn()
}: {
  safeModeAvailable?: number;
  safeMode?: number;
  safeModeCooldown?: number;
  upgradeBlocked?: number;
  activateSafeMode?: jest.Mock<ScreepsReturnCode, []>;
} = {}): StructureController {
  return {
    id: 'controller1',
    my: true,
    level: 3,
    structureType: TEST_GLOBALS.STRUCTURE_CONTROLLER,
    safeModeAvailable,
    safeMode,
    safeModeCooldown,
    upgradeBlocked,
    activateSafeMode,
    pos: makePosition(25, 25)
  } as unknown as StructureController;
}

function makeTower(
  id: string,
  {
    energy,
    x = 25,
    y = 25
  }: {
    energy: number;
    x?: number;
    y?: number;
  }
): StructureTower {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_TOWER,
    hits: 3_000,
    hitsMax: 3_000,
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === TEST_GLOBALS.RESOURCE_ENERGY ? energy : 0
      )
    },
    attack: jest.fn().mockReturnValue(OK_CODE),
    heal: jest.fn().mockReturnValue(OK_CODE),
    repair: jest.fn().mockReturnValue(OK_CODE),
    pos: makePosition(x, y)
  } as unknown as StructureTower;
}

function makeSpawn(id: string, hits = 5_000, hitsMax = 5_000): StructureSpawn {
  return {
    id,
    name: 'Spawn1',
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    hits,
    hitsMax,
    spawning: null
  } as unknown as StructureSpawn;
}

function makeRampart(id: string, hits: number, hitsMax: number): StructureRampart {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
    my: true,
    hits,
    hitsMax,
    pos: makePosition()
  } as unknown as StructureRampart;
}

function attachRoom(structures: Array<StructureSpawn | StructureTower>, room: Room): void {
  for (const structure of structures) {
    (structure as StructureSpawn | StructureTower).room = room;
  }
}

function makeHostiles(count: number): Creep[] {
  return Array.from({ length: count }, (_, index) => makeHostile(`hostile${index + 1}`, 25 + index, 25));
}

function makeHostile(id: string, x = 25, y = 25): Creep {
  return {
    id,
    owner: { username: 'enemy' },
    pos: makePosition(x, y)
  } as unknown as Creep;
}

function makeFriendlyCreep(id: string, x: number, y: number, hits: number, hitsMax: number): Creep {
  return {
    id,
    name: id,
    my: true,
    hits,
    hitsMax,
    pos: makePosition(x, y)
  } as unknown as Creep;
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
