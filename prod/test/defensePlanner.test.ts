import {
  buildDefenderBody,
  getDesiredDefenderCount,
  hasDefensePressure,
  planDefenderSpawn,
  selectDefenderAttackTarget,
  selectTowerAttackTarget,
  shouldActivateSafeMode
} from '../src/defense/defensePlanner';

describe('defensePlanner', () => {
  it('summarizes defense pressure from visible hostiles or damaged critical structures', () => {
    expect(
      hasDefensePressure({
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        damagedCriticalStructureCount: 0
      })
    ).toBe(false);
    expect(
      hasDefensePressure({
        hostileCreepCount: 1,
        hostileStructureCount: 0,
        damagedCriticalStructureCount: 0
      })
    ).toBe(true);
    expect(
      hasDefensePressure({
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        damagedCriticalStructureCount: 1
      })
    ).toBe(true);
  });

  it('builds affordable defender bodies from hostile pressure', () => {
    expect(buildDefenderBody(139, 1)).toEqual([]);
    expect(buildDefenderBody(140, 1)).toEqual(['tough', 'attack', 'move']);
    expect(buildDefenderBody(600, 4)).toEqual([
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
    expect(buildDefenderBody(10_000, 20)).toHaveLength(15);
  });

  it('plans defender spawns until active defender coverage satisfies hostile pressure', () => {
    expect(getDesiredDefenderCount(1)).toBe(1);
    expect(getDesiredDefenderCount(4)).toBe(2);

    expect(
      planDefenderSpawn({
        roomName: 'W1N1',
        hostileCreepCount: 4,
        activeDefenderCount: 1,
        energyAvailable: 600,
        gameTime: 123,
        nameSuffix: 'a'
      })
    ).toEqual({
      body: [
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
      ],
      name: 'defender-W1N1-123-a',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
    expect(
      planDefenderSpawn({
        roomName: 'W1N1',
        hostileCreepCount: 4,
        activeDefenderCount: 2,
        energyAvailable: 600,
        gameTime: 123
      })
    ).toBeNull();
  });

  it('plans a defender when an owned controller is attack-blocked even after hostiles leave vision', () => {
    expect(
      planDefenderSpawn({
        roomName: 'W1N1',
        hostileCreepCount: 0,
        controllerUnderAttack: true,
        activeDefenderCount: 0,
        energyAvailable: 300,
        gameTime: 124
      })
    ).toEqual({
      body: ['tough', 'attack', 'move'],
      name: 'defender-W1N1-124',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
  });

  it('selects tower attack targets by hostile creep priority, range, and tower room', () => {
    const tower = { pos: makePosition(25, 25, 'W1N1') };
    const farHostile = makeCreep('hostile-z', 40, 25, 'W1N1');
    const nearHostile = makeCreep('hostile-a', 26, 25, 'W1N1');
    const closerStructure = makeStructure('structure1', 25, 26, 'W1N1');

    expect(selectTowerAttackTarget(tower, [farHostile, nearHostile], [closerStructure])).toBe(nearHostile);

    const crossRoomHostile = makeCreep('remote-hostile', 25, 25, 'W2N1');
    expect(selectTowerAttackTarget(tower, [crossRoomHostile], [closerStructure])).toBe(closerStructure);
  });

  it('prioritizes hostile creeps near owned controllers before nearer room hostiles', () => {
    const controller = makeController({ safeModeAvailable: 1 });
    const tower = { pos: makePosition(20, 20, 'W1N1'), room: { controller } };
    const nearestHostile = makeCreep('nearest-hostile', 21, 20, 'W1N1');
    const controllerHostile = makeCreep('controller-hostile', 26, 25, 'W1N1');

    expect(selectTowerAttackTarget(tower, [nearestHostile, controllerHostile], [])).toBe(controllerHostile);
  });

  it('prioritizes hostile creeps pressuring owned structures before generic nearest hostiles', () => {
    const tower = { pos: makePosition(20, 20, 'W1N1') };
    const nearestHostile = makeCreep('nearest-hostile', 21, 20, 'W1N1');
    const structureHostile = makeCreep('structure-hostile', 30, 30, 'W1N1');
    const protectedStructure = makeStructure('spawn1', 31, 30, 'W1N1');

    expect(
      selectTowerAttackTarget(tower, [nearestHostile, structureHostile], [], {
        protectedStructures: [protectedStructure]
      })
    ).toBe(structureHostile);
  });

  it('selects defender attack targets by hostile creep priority before hostile structures', () => {
    const defender = { pos: makePosition(25, 25, 'W1N1') };
    const farHostile = makeCreep('hostile1', 40, 25, 'W1N1');
    const closerStructure = makeStructure('structure1', 26, 25, 'W1N1');

    expect(selectDefenderAttackTarget(defender, [farHostile], [closerStructure])).toBe(farHostile);
    expect(selectDefenderAttackTarget(defender, [], [closerStructure])).toBe(closerStructure);
  });

  it('plans safe mode only when hostile pressure threatens recovery paths', () => {
    const hostile = makeCreep('hostile1', 26, 25, 'W1N1');
    const controller = makeController({ safeModeAvailable: 1 });

    expect(
      shouldActivateSafeMode({
        controller,
        hostileCreeps: [hostile],
        ownedSpawns: [makeSpawn('spawn1', 1_000, 5_000)]
      })
    ).toBe(true);
    expect(
      shouldActivateSafeMode({
        controller: makeController({ safeModeAvailable: 1, safeModeCooldown: 50 }),
        hostileCreeps: [hostile],
        ownedSpawns: [makeSpawn('spawn1', 1_000, 5_000)]
      })
    ).toBe(false);
    expect(
      shouldActivateSafeMode({
        controller,
        hostileCreeps: [],
        ownedSpawns: []
      })
    ).toBe(false);
  });
});

function makeCreep(id: string, x: number, y: number, roomName: string): Creep {
  return {
    id,
    pos: makePosition(x, y, roomName)
  } as unknown as Creep;
}

function makeStructure(id: string, x: number, y: number, roomName: string): Structure {
  return {
    id,
    pos: makePosition(x, y, roomName)
  } as unknown as Structure;
}

function makeSpawn(id: string, hits: number, hitsMax: number): StructureSpawn {
  return {
    id,
    hits,
    hitsMax
  } as unknown as StructureSpawn;
}

function makeController({
  safeModeAvailable = 0,
  safeModeCooldown = 0
}: {
  safeModeAvailable?: number;
  safeModeCooldown?: number;
}): StructureController {
  return {
    id: 'controller1',
    my: true,
    safeModeAvailable,
    safeModeCooldown,
    activateSafeMode: jest.fn(),
    pos: makePosition(25, 25, 'W1N1')
  } as unknown as StructureController;
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
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
