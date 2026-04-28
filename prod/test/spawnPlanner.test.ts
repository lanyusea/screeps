import { planSpawn } from '../src/spawn/spawnPlanner';
import { ColonySnapshot } from '../src/colony/colonyRegistry';

describe('planSpawn', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  function makeColony({
    sourceCount = 1,
    energyAvailable = 300,
    energyCapacityAvailable = 300,
    roomName = 'W1N1',
    constructionSiteCount = 0,
    spawning = null,
    controller
  }: {
    sourceCount?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    roomName?: string;
    constructionSiteCount?: number;
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

  it('does not spend the construction backlog bonus while the home controller needs downgrade recovery', () => {
    const { colony } = makeColony({
      roomName: 'W1N9',
      constructionSiteCount: 1,
      controller: { my: true, level: 3, ticksToDowngrade: 5_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3 }, 147)).toBeNull();
  });

  it('plans a claimer-role reserver for an explicit memory target when home survival is safe', () => {
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
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-139',
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
        status: 'planned',
        updatedAt: 139
      }
    ]);
  });

  it('plans territory control once the construction-adjusted worker target is satisfied', () => {
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
      body: ['claim', 'move'],
      name: 'claimer-W1N10-W2N10-148',
      memory: {
        role: 'claimer',
        colony: 'W1N10',
        territory: { targetRoom: 'W2N10', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N10',
        targetRoom: 'W2N10',
        action: 'reserve',
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

  it('records territory intent while waiting for claim body energy', () => {
    const { colony } = makeColony({
      energyAvailable: 600,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim', controllerId: 'controller2' as Id<StructureController> }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 141)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 141,
        controllerId: 'controller2'
      }
    ]);
  });

  it('plans a claim creep when only reserve capacity exists for the recovered target room', () => {
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
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-149',
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
        updatedAt: 149
      }
    ]);
  });

  it('keeps territory control absent when the home worker floor is unsafe', () => {
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

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 140)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-140',
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

  it('caps the source-aware worker target even with active construction backlog', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N3',
      sourceCount: 10,
      constructionSiteCount: 1,
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
