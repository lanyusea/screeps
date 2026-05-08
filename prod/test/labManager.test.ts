import {
  detectOwnedLabs,
  manageLabs,
  planReactionChain,
  type LabInventory
} from '../src/economy/labManager';

const OK_CODE = 0 as ScreepsReturnCode;

type TestLab = StructureLab & {
  boostCreep: jest.Mock;
  runReaction: jest.Mock;
};

describe('labManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      LAB_BOOST_ENERGY: 20,
      LAB_BOOST_MINERAL: 30,
      LAB_REACTION_AMOUNT: 5,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_LAB: 'lab'
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 100, creeps: {} };
  });

  it('detects owned labs and plans dependent reaction chains', () => {
    const labB = makeLab({ id: 'lab-b' });
    const labA = makeLab({ id: 'lab-a' });
    const spawn = { id: 'spawn1', structureType: 'spawn' } as StructureSpawn;
    const room = makeRoom({ structures: [spawn as unknown as AnyOwnedStructure, labB, labA] });

    expect(detectOwnedLabs(room).map((lab) => lab.id)).toEqual(['lab-a', 'lab-b']);

    const chain = planReactionChain('XGH2O' as ResourceConstant, {
      G: 100,
      H: 100,
      OH: 100,
      X: 100
    } as LabInventory, 50);

    expect(chain.missingResources).toEqual([]);
    expect(chain.steps.map((step) => step.product)).toEqual(['GH', 'GH2O', 'XGH2O']);
    expect(chain.steps.map((step) => step.reagents)).toEqual([
      ['G', 'H'],
      ['GH', 'OH'],
      ['GH2O', 'X']
    ]);
  });

  it('boosts controller upgraders before lower-priority creep boost requests', () => {
    const creepBoostLab = makeLab({ id: 'lab-a', mineralType: 'UH', mineralAmount: 30, energy: 20 });
    const upgraderBoostLab = makeLab({ id: 'lab-b', mineralType: 'XGH2O', mineralAmount: 30, energy: 20 });
    const room = makeRoom({ structures: [creepBoostLab, upgraderBoostLab] });
    const fighter = makeCreep('Fighter1', ['attack'], {
      lab: { boosts: [{ part: 'attack', resource: 'UH' as MineralBoostConstant }] }
    });
    const upgrader = makeCreep('Upgrader1', ['work'], { role: 'upgrader', colony: 'W1N1' });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 101,
      creeps: { Fighter1: fighter, Upgrader1: upgrader }
    };

    const result = manageLabs(room, { creeps: [fighter, upgrader] });

    expect(upgraderBoostLab.boostCreep).toHaveBeenCalledWith(upgrader, 1);
    expect(creepBoostLab.boostCreep).not.toHaveBeenCalled();
    expect(result.boost).toMatchObject({
      creepName: 'Upgrader1',
      priority: 'controllerUpgrade',
      resource: 'XGH2O',
      status: 'boosted'
    });
  });

  it('runs reactions and accumulates reaction progress in memory', () => {
    const hLab = makeLab({ id: 'lab-h', mineralType: 'H', mineralAmount: 100 });
    const oLab = makeLab({ id: 'lab-o', mineralType: 'O', mineralAmount: 100 });
    const outputLab = makeLab({ id: 'lab-out', freeCapacity: 3_000 });
    const room = makeRoom({ structures: [hLab, oLab, outputLab] });
    Memory.economy = {
      labManagement: {
        updatedAt: 199,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            rcl: 6,
            updatedAt: 199,
            labs: [],
            inventory: {},
            boostDemand: [],
            reactionTarget: 'OH' as ResourceConstant,
            reactionDesiredAmount: 50
          }
        }
      }
    };

    manageLabs(room, { creeps: [] });

    expect(outputLab.runReaction).toHaveBeenCalledWith(hLab, oLab);
    expect(Memory.economy?.labManagement?.rooms.W1N1.reaction).toMatchObject({
      activeProduct: 'OH',
      availableAmount: 0,
      outputLabId: 'lab-out',
      producedAmount: 5,
      reagents: ['H', 'O'],
      sourceLabIds: ['lab-h', 'lab-o'],
      status: 'running',
      targetResource: 'OH'
    });

    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 102, creeps: {} };
    manageLabs(room, { creeps: [] });

    expect(Memory.economy?.labManagement?.rooms.W1N1.reaction?.producedAmount).toBe(10);
  });

  it('enforces boost energy budgets and reaction cooldowns', () => {
    const lowEnergyBoostLab = makeLab({ id: 'lab-boost', mineralType: 'GH', mineralAmount: 30, energy: 19 });
    const boostRoom = makeRoom({ structures: [lowEnergyBoostLab] });
    const worker = makeCreep('Worker1', ['work'], {
      lab: { boosts: [{ part: 'work', resource: 'GH' as MineralBoostConstant }] }
    });

    const boostResult = manageLabs(boostRoom, { creeps: [worker] });

    expect(lowEnergyBoostLab.boostCreep).not.toHaveBeenCalled();
    expect(boostResult.boost).toMatchObject({
      creepName: 'Worker1',
      reason: 'insufficientEnergy',
      status: 'blocked'
    });

    const hLab = makeLab({ id: 'lab-h', mineralType: 'H', mineralAmount: 100 });
    const oLab = makeLab({ id: 'lab-o', mineralType: 'O', mineralAmount: 100 });
    const coolingOutputLab = makeLab({ id: 'lab-out', cooldown: 3, freeCapacity: 3_000 });
    const reactionRoom = makeRoom({ structures: [hLab, oLab, coolingOutputLab] });
    Memory.economy = {
      labManagement: {
        updatedAt: 100,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            rcl: 6,
            updatedAt: 100,
            labs: [],
            inventory: {},
            boostDemand: [],
            reactionTarget: 'OH' as ResourceConstant
          }
        }
      }
    };

    const reactionResult = manageLabs(reactionRoom, { creeps: [] });

    expect(coolingOutputLab.runReaction).not.toHaveBeenCalled();
    expect(reactionResult.reaction).toMatchObject({
      product: 'OH',
      reason: 'cooldown',
      status: 'blocked',
      targetResource: 'OH'
    });
  });
});

function makeRoom({
  structures,
  storage,
  terminal
}: {
  structures: AnyOwnedStructure[];
  storage?: StructureStorage;
  terminal?: StructureTerminal;
}): Room {
  return {
    name: 'W1N1',
    controller: { my: true, level: 6 } as StructureController,
    ...(storage ? { storage } : {}),
    ...(terminal ? { terminal } : {}),
    find: jest.fn((type: number) => (type === FIND_MY_STRUCTURES ? structures : []))
  } as unknown as Room;
}

function makeLab({
  id,
  mineralType = null,
  mineralAmount = 0,
  energy = 0,
  cooldown = 0,
  freeCapacity = 3_000
}: {
  id: string;
  mineralType?: ResourceConstant | null;
  mineralAmount?: number;
  energy?: number;
  cooldown?: number;
  freeCapacity?: number;
}): TestLab {
  return {
    id,
    structureType: 'lab',
    mineralType,
    mineralAmount,
    mineralCapacity: 3_000,
    energy,
    cooldown,
    store: makeStore({
      ...(energy > 0 ? { energy } : {}),
      ...(mineralType && mineralAmount > 0 ? { [mineralType]: mineralAmount } : {})
    }, freeCapacity),
    boostCreep: jest.fn().mockReturnValue(OK_CODE),
    runReaction: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestLab;
}

function makeCreep(name: string, body: BodyPartConstant[], memory: Partial<CreepMemory> = {}): Creep {
  return {
    name,
    body: body.map((type) => ({ type, hits: 100 })),
    memory,
    room: { name: 'W1N1' } as Room,
    moveTo: jest.fn()
  } as unknown as Creep;
}

function makeStore(resources: Record<string, number>, freeCapacity: number): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => {
      if (!resource) {
        return Object.values(resources).reduce((total, amount) => total + amount, 0);
      }

      return resources[resource] ?? 0;
    }),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY ? Math.max(0, 2_000 - (resources.energy ?? 0)) : freeCapacity
    ),
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_000 : 3_000))
  } as unknown as StoreDefinition;
}
