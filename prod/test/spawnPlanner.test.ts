import { planSpawn } from '../src/spawn/spawnPlanner';
import { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  persistOccupationRecommendationFollowUpIntent,
  scoreOccupationRecommendations
} from '../src/territory/occupationRecommendation';
import {
  TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_SUPPRESSION_RETRY_TICKS
} from '../src/territory/territoryPlanner';

describe('planSpawn', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  function makeColony({
    sourceCount = 1,
    energyAvailable = 300,
    energyCapacityAvailable = 300,
    roomName = 'W1N1',
    constructionSiteCount = 0,
    hostileCreeps = [],
    hostileStructures = [],
    spawning = null,
    controller
  }: {
    sourceCount?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    roomName?: string;
    constructionSiteCount?: number;
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    spawning?: Spawning | null;
    controller?: StructureController;
  } = {}): { colony: ColonySnapshot; spawn: StructureSpawn; find: jest.Mock<unknown[], [number]> } {
    const sources = Array.from({ length: sourceCount }, (_, index) => ({ id: `source${index}` }) as Source);
    const constructionSites = Array.from(
      { length: constructionSiteCount },
      (_, index) => ({ id: `site${index}` }) as ConstructionSite
    );
    const find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_MY_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      const hostileCreepsFind = (globalThis as Record<string, unknown>).FIND_HOSTILE_CREEPS;
      if (typeof hostileCreepsFind === 'number' && type === hostileCreepsFind) {
        return hostileCreeps;
      }

      const hostileStructuresFind = (globalThis as Record<string, unknown>).FIND_HOSTILE_STRUCTURES;
      if (typeof hostileStructuresFind === 'number' && type === hostileStructuresFind) {
        return hostileStructures;
      }

      return [];
    });
    const room = {
      name: roomName,
      energyAvailable,
      energyCapacityAvailable,
      find,
      ...(controller ? { controller } : {})
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room, spawning } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable,
      energyCapacityAvailable
    };

    return { colony, spawn, find };
  }

  function makeSafeOwnedController(): StructureController {
    return { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController;
  }

  function installHostileFindGlobals(): void {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
  }

  function makeTerritoryRoom(roomName: string, controller: StructureController, sourceCount = 0): Room {
    return {
      name: roomName,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return Array.from({ length: sourceCount }, (_, index) => ({ id: `${roomName}-source${index}` }));
        }

        return [];
      })
    } as unknown as Room;
  }

  it('plans a worker when the colony has no workers and an idle spawn', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 0 }, 123)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-123',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps one-source rooms at the three-worker target', () => {
    const { colony } = makeColony({ sourceCount: 1 });

    expect(planSpawn(colony, { worker: 3 }, 123)).toBeNull();
  });

  it('plans one replacement when steady-state worker capacity is below target', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 2 }, 124)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-124',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans a replacement when low-TTL workers leave steady-state capacity below target', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans the full capacity worker body when currently affordable', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 2 }, 134)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-134',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('uses mid-capacity room energy for worker carry and move throughput', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N13',
      energyAvailable: 550,
      energyCapacityAvailable: 550
    });

    expect(planSpawn(colony, { worker: 2 }, 151)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'carry', 'move'],
      name: 'worker-W1N13-151',
      memory: { role: 'worker', colony: 'W1N13' }
    });
  });

  it('does not overbuild when replacement-aware worker capacity is at target', () => {
    const { colony } = makeColony();

    expect(planSpawn(colony, { worker: 3, workerCapacity: 3 }, 124)).toBeNull();
  });

  it('keeps normal replacement body selection when only expiring workers remain', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 600, energyCapacityAvailable: 800 });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 0 }, 135)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-135',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps the emergency worker body for true zero-creep recovery', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 600, energyCapacityAvailable: 800 });

    expect(planSpawn(colony, { worker: 0, workerCapacity: 0 }, 136)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-136',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('adds one worker target for active construction backlog after the baseline target is safe', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N8',
      constructionSiteCount: 1,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 145)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N8-145',
      memory: { role: 'worker', colony: 'W1N8' }
    });
    expect(planSpawn(colony, { worker: 4 }, 146)).toBeNull();
  });

  it('adds one worker target while spawn-extension refill pressure remains after baseline workers', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N16',
      energyAvailable: 400,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 146)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N16-146',
      memory: { role: 'worker', colony: 'W1N16' }
    });
    expect(planSpawn(colony, { worker: 4 }, 147)).toBeNull();
  });

  it('adds a second worker target for substantial construction backlog after the first bonus target is safe', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N14',
      constructionSiteCount: 5,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 147)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N14-147',
      memory: { role: 'worker', colony: 'W1N14' }
    });
    expect(planSpawn(colony, { worker: 4 }, 148)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N14-148',
      memory: { role: 'worker', colony: 'W1N14' }
    });
    expect(planSpawn(colony, { worker: 5 }, 149)).toBeNull();
  });

  it('plans one downgrade-guard worker when the home controller needs recovery', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N9',
      controller: { my: true, level: 3, ticksToDowngrade: 5_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3 }, 150)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N9-150',
      memory: { role: 'worker', colony: 'W1N9' }
    });
  });

  it('does not spend the only spawn on a downgrade-guard worker under hostile pressure', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({
      roomName: 'W1N9',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      hostileCreeps: [hostile],
      controller: { my: true, level: 3, ticksToDowngrade: 5_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 151)).toBeNull();
  });

  it('allows a downgrade-guard worker under hostile pressure when another idle spawn remains available', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({
      roomName: 'W1N9',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      hostileCreeps: [hostile],
      controller: { my: true, level: 3, ticksToDowngrade: 5_000 } as StructureController
    });
    colony.spawns = [spawn, { name: 'Spawn2', room: colony.room, spawning: null } as StructureSpawn];

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 152)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N9-152',
      memory: { role: 'worker', colony: 'W1N9' }
    });
  });

  it('does not spend construction backlog bonuses while the home controller needs downgrade recovery', () => {
    const { colony } = makeColony({
      roomName: 'W1N9',
      constructionSiteCount: 5,
      controller: { my: true, level: 3, ticksToDowngrade: 5_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 4 }, 150)).toBeNull();
  });

  it('plans an emergency defender when hostile creeps are visible and local worker coverage is stable', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 160)).toEqual({
      spawn,
      body: ['tough', 'attack', 'move'],
      name: 'defender-W1N1-160',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
  });

  it('plans an emergency defender before local worker refill while hostiles are visible', () => {
    installHostileFindGlobals();
    const { colony: localRefillColony, spawn: localRefillSpawn } = makeColony({ sourceCount: 2 });
    expect(planSpawn(localRefillColony, { worker: 3 }, 163)).toEqual({
      spawn: localRefillSpawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-163',
      memory: { role: 'worker', colony: 'W1N1' }
    });

    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ sourceCount: 2, hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 164)).toEqual({
      spawn,
      body: ['tough', 'attack', 'move'],
      name: 'defender-W1N1-164',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
  });

  it('keeps bootstrap recovery ahead of defender spawning while hostiles are visible', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 0 }, 165)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-165',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('does not stack emergency defenders while one defender is already active', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 161)).toBeNull();
  });

  it('waits instead of emitting an invalid defender body when hostile defense energy is unavailable', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({ energyAvailable: 139, hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 162)).toBeNull();
  });

  it('plans a scout for an explicit memory target when target visibility is missing', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 139)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-139',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 139
      }
    ]);
  });

  it('plans territory scouting once the construction-adjusted worker target is satisfied', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N10',
      constructionSiteCount: 1,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N10', roomName: 'W2N10', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 148)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N10-W2N10-148',
      memory: {
        role: 'scout',
        colony: 'W1N10',
        territory: { targetRoom: 'W2N10', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N10',
        targetRoom: 'W2N10',
        action: 'scout',
        status: 'planned',
        updatedAt: 148
      }
    ]);
  });

  it('plans a claimer-role reserver for a seeded adjacent reserve target when home survival is safe', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 142)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-142',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 142
      }
    ]);
  });

  it('does not spawn a one-CLAIM reserver for foreign reservation pressure', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 143)).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a pressure-capable claimer for foreign reservation pressure', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 144)).toEqual({
      spawn,
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      name: 'claimer-W1N1-W2N1-144',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
  });

  it('does not spawn a one-CLAIM claimer for foreign-reserved claim pressure', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 145)).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a pressure-capable claimer for foreign-reserved claim pressure', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 146)).toEqual({
      spawn,
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      name: 'claimer-W1N1-W2N1-146',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 146,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body for persisted foreign-reserved claim pressure after vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(visibleColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 147)).toMatchObject({
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move']
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 148)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 148,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body after claim pressure recommendation persistence and vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 146,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const recommendation = scoreOccupationRecommendations({
      colonyName: 'W1N1',
      colonyOwnerUsername: 'me',
      energyCapacityAvailable: 3250,
      workerCount: 3,
      controllerLevel: 3,
      ticksToDowngrade: 10_000,
      candidates: [
        {
          roomName: 'W2N1',
          source: 'configured',
          order: 0,
          adjacent: false,
          visible: true,
          actionHint: 'claim',
          routeDistance: 1,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          constructionSiteCount: 0,
          ownedStructureCount: 0
        }
      ]
    });

    expect(recommendation.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      requiresControllerPressure: true
    });
    expect(persistOccupationRecommendationFollowUpIntent(recommendation, 147)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 147,
      requiresControllerPressure: true
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 148)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 148,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not retry a stale suppressed claim-pressure recommendation with a one-CLAIM body after vision loss', () => {
    const suppressionTime = 146;
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'suppressed',
            updatedAt: suppressionTime
          }
        ]
      }
    };
    const recommendation = scoreOccupationRecommendations({
      colonyName: 'W1N1',
      colonyOwnerUsername: 'me',
      energyCapacityAvailable: 3250,
      workerCount: 3,
      controllerLevel: 3,
      ticksToDowngrade: 10_000,
      candidates: [
        {
          roomName: 'W2N1',
          source: 'configured',
          order: 0,
          adjacent: false,
          visible: true,
          actionHint: 'claim',
          routeDistance: 1,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          constructionSiteCount: 0,
          ownedStructureCount: 0
        }
      ]
    });

    expect(persistOccupationRecommendationFollowUpIntent(recommendation, suppressionTime + 1)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: suppressionTime,
        requiresControllerPressure: true
      }
    ]);

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: retryTime,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body for persisted foreign reservation pressure after vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(visibleColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 145)).toMatchObject({
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move']
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 146)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 146,
        requiresControllerPressure: true
      }
    ]);
  });

  it('plans a claimer from a persisted occupation claim intent when the target is actionable', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2' as Id<StructureController>,
          my: false
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 152,
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 153)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-153',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'claim',
          controllerId: 'controller2' as Id<StructureController>
        }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 153,
        controllerId: 'controller2'
      }
    ]);
  });

  it('uses a selected follow-up demand to plan one support worker before a reserver', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 155)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-155',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 155,
        followUp
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('plans a reserver from a persisted follow-up intent once support demand is satisfied', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 155)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N2-155',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('cools down a recovered follow-up when no spawn action is available', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 160;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const eligibleTime = retryTime + TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS + 1;
    const busy = { remainingTime: 5 } as Spawning;
    const { colony: busyColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      spawning: busy
    });
    const { colony: idleColony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const recoveringRoleCounts = { worker: 3, claimer: 0, claimersByTargetRoom: {} };
    const readyRoleCounts = { worker: 4, claimer: 0, claimersByTargetRoom: {} };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(busyColony, recoveringRoleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        lastAttemptAt: retryTime,
        followUp
      }
    ]);

    expect(planSpawn(idleColony, recoveringRoleCounts, retryTime + 1)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        lastAttemptAt: retryTime,
        followUp
      }
    ]);

    expect(planSpawn(idleColony, readyRoleCounts, eligibleTime)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: `claimer-W1N1-W2N2-${eligibleTime}`,
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: eligibleTime,
        followUp
      }
    ]);
  });

  it('uses a ready alternate while a recovered follow-up lacks claim body energy', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 165;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const { colony, spawn } = makeColony({
      energyAvailable: 50,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '1': 'W1N3' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N2', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, retryTime)).toEqual({
      spawn,
      body: ['move'],
      name: `scout-W1N1-W1N3-${retryTime}`,
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W1N3', action: 'scout' }
      }
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W1N3',
        action: 'scout',
        status: 'planned',
        updatedAt: retryTime
      }
    ]);
  });

  it('keeps a recovered follow-up active when live controller coverage already satisfies it', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 170;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const roleCounts = {
      worker: 4,
      claimer: 1,
      claimersByTargetRoom: { W2N2: 1 },
      claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, roleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: retryTime,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('does not cool down a covered recovered follow-up when support worker spawn is unavailable', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 180;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const busy = { remainingTime: 5 } as Spawning;
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      spawning: busy
    });
    const roleCounts = {
      worker: 3,
      claimer: 1,
      claimersByTargetRoom: { W2N2: 1 },
      claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, roleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: retryTime,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('does not plan a duplicate claimer for the same persisted target and action', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 156
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N2: 1 },
          claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
        },
        157
      )
    ).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 157
      }
    ]);
  });

  it('does not count a reserver as coverage for a persisted claim intent on the same target', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'claim',
            status: 'planned',
            updatedAt: 158
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N2: 1 },
          claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
        },
        159
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N2-159',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'claim' }
      }
    });
  });

  it('plans a cheap scout for an unseen adjacent reserve candidate before reserving it', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 50,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '3': 'W2N1' })) } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 144)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-144',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout' }
      }
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 144
      }
    ]);
  });

  it('spawns a scout while waiting for claim body energy and target visibility', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 600,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim', controllerId: 'controller2' as Id<StructureController> }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 141)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-141',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout', controllerId: 'controller2' as Id<StructureController> }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 141,
        controllerId: 'controller2'
      }
    ]);
  });

  it('plans a scout when only reserve capacity exists for an unseen recovered claim target', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        149
      )
    ).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-149',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 149
      }
    ]);
  });

  it('keeps low worker capacity on worker recovery before territory control', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 1, claimer: 0, claimersByTargetRoom: {} }, 140)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-140',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('keeps near-target local recovery ahead of territory control', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 141)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-141',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not plan another claimer while one has active target capacity', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 1, claimersByTargetRoom: { W2N1: 1 } }, 143)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 143
      }
    ]);
  });

  it('plans a backup reserver when an active own reservation reaches emergency renewal', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: {
          name: 'W2N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        151
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-151',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 151
      }
    ]);
  });

  it('plans the next territory controller target while another target has active capacity', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    const activeReserveIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 143
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ],
        intents: [activeReserveIntent]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        150
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W3N1-150',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      activeReserveIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 150
      }
    ]);
  });

  it('prefers safe visible adjacent reserve progress at the territory-ready worker floor', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W4N1: makeTerritoryRoom('W4N1', { my: false } as StructureController, 1),
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }],
        routeDistances: { 'W1N1>W4N1': 3 }
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 160)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-160',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      { colony: 'W1N1', roomName: 'W4N1', action: 'reserve' },
      { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }
    ]);
  });

  it('keeps worker recovery before adjacent reserve progress below the territory-ready worker floor', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W4N1: makeTerritoryRoom('W4N1', { my: false } as StructureController, 1),
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }],
        routeDistances: { 'W1N1>W4N1': 3 }
      }
    };

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 161)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-161',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(describeExits).not.toHaveBeenCalled();
    expect(Memory.territory?.targets).toEqual([{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }]);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('targets a fourth worker for two-source rooms', () => {
    const { colony, spawn } = makeColony({ roomName: 'W1N2', sourceCount: 2 });

    expect(planSpawn(colony, { worker: 3 }, 126)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N2-126',
      memory: { role: 'worker', colony: 'W1N2' }
    });
    expect(planSpawn(colony, { worker: 4 }, 126)).toBeNull();
  });

  it('waits for two-source home stability before territory spawning', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N15',
      sourceCount: 2,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N15', roomName: 'W2N15', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 152)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N15-152',
      memory: { role: 'worker', colony: 'W1N15' }
    });
    expect(Memory.territory?.intents).toBeUndefined();

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 153)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N15-W2N15-153',
      memory: {
        role: 'scout',
        colony: 'W1N15',
        territory: { targetRoom: 'W2N15', action: 'scout' }
      }
    });
  });

  it('caps the source-aware worker target even with substantial construction backlog', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N3',
      sourceCount: 10,
      constructionSiteCount: 5,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 5 }, 127)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N3-127',
      memory: { role: 'worker', colony: 'W1N3' }
    });
    expect(planSpawn(colony, { worker: 6 }, 127)).toBeNull();
  });

  it('caches source counts for repeated planning in the same room', () => {
    const { colony, find } = makeColony({ roomName: 'W1N4', sourceCount: 2 });

    planSpawn(colony, { worker: 3 }, 128);
    planSpawn(colony, { worker: 3 }, 129);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('computes source counts once for each newly encountered room', () => {
    const first = makeColony({ roomName: 'W1N5', sourceCount: 1 });
    const second = makeColony({ roomName: 'W1N6', sourceCount: 2 });

    planSpawn(first.colony, { worker: 2 }, 130);
    planSpawn(second.colony, { worker: 3 }, 131);
    planSpawn(second.colony, { worker: 3 }, 132);

    expect(first.find).toHaveBeenCalledTimes(1);
    expect(second.find).toHaveBeenCalledTimes(1);
  });

  it('falls back safely when room name and find are absent in a mock', () => {
    const room = {
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 3 }, 133)).toBeNull();
  });

  it('plans an emergency basic worker when zero active workers cannot afford the normal worker body', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 200, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps zero-worker recovery on the emergency basic worker body when construction backlog exists', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N11',
      constructionSiteCount: 1,
      energyAvailable: 400,
      energyCapacityAvailable: 600,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 0 }, 135)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N11-135',
      memory: { role: 'worker', colony: 'W1N11' }
    });
  });

  it('plans an affordable worker body below the minimum functional worker target', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 600 });

    expect(planSpawn(colony, { worker: 2 }, 136)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-136',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans an affordable worker body for a source-aware shortfall before the full worker body is affordable', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N7',
      sourceCount: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 600
    });

    expect(planSpawn(colony, { worker: 3 }, 137)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N7-137',
      memory: { role: 'worker', colony: 'W1N7' }
    });
  });

  it('plans an affordable worker body when replacement-aware capacity is below the source-aware target', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N12',
      sourceCount: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 600
    });

    expect(planSpawn(colony, { worker: 4, workerCapacity: 3 }, 150)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N12-150',
      memory: { role: 'worker', colony: 'W1N12' }
    });
  });

  it('does not plan an emergency body that costs more than available energy', () => {
    const { colony } = makeColony({ energyAvailable: 199, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toBeNull();
  });

  it('does not plan a non-emergency worker body below the minimum worker energy', () => {
    const { colony } = makeColony({ energyAvailable: 199, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 2 }, 138)).toBeNull();
  });

  it('does not plan when all spawns are busy', () => {
    const { colony } = makeColony({ spawning: {} as Spawning });

    expect(planSpawn(colony, { worker: 0 }, 123)).toBeNull();
  });
});
