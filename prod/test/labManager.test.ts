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

  it('prioritizes controller upgrader boosts while processing lower-priority requests', () => {
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
    expect(creepBoostLab.boostCreep).toHaveBeenCalledWith(fighter, 1);
    expect(upgraderBoostLab.boostCreep.mock.invocationCallOrder[0]).toBeLessThan(
      creepBoostLab.boostCreep.mock.invocationCallOrder[0]
    );
    expect(result.boost).toMatchObject({
      creepName: 'Upgrader1',
      priority: 'controllerUpgrade',
      resource: 'XGH2O',
      status: 'boosted'
    });
    expect(result.boosts).toEqual([
      expect.objectContaining({ creepName: 'Upgrader1', status: 'boosted' }),
      expect.objectContaining({ creepName: 'Fighter1', status: 'boosted' })
    ]);
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

  it('skips non-adjacent reaction output labs and accepts a range-compatible trio', () => {
    const hLab = makeLab({ id: 'lab-h', mineralType: 'H', mineralAmount: 100, x: 10, y: 10 });
    const oLab = makeLab({ id: 'lab-o', mineralType: 'O', mineralAmount: 100, x: 12, y: 10 });
    const farOutputLab = makeLab({ id: 'lab-aa-far', freeCapacity: 3_000, x: 20, y: 20 });
    const validOutputLab = makeLab({ id: 'lab-zz-valid', freeCapacity: 3_000, x: 11, y: 11 });
    const room = makeRoom({ structures: [hLab, oLab, farOutputLab, validOutputLab] });
    setReactionTargetMemory('OH' as ResourceConstant, 50);

    const result = manageLabs(room, { creeps: [] });

    expect(farOutputLab.runReaction).not.toHaveBeenCalled();
    expect(validOutputLab.runReaction).toHaveBeenCalledWith(hLab, oLab);
    expect(result.reaction).toMatchObject({
      outputLabId: 'lab-zz-valid',
      status: 'running'
    });
  });

  it('rejects reaction trios when any positioned lab pair is outside range 2', () => {
    const hLab = makeLab({ id: 'lab-h', mineralType: 'H', mineralAmount: 100, x: 10, y: 10 });
    const oLab = makeLab({ id: 'lab-o', mineralType: 'O', mineralAmount: 100, x: 13, y: 10 });
    const outputLab = makeLab({ id: 'lab-out', freeCapacity: 3_000, x: 11, y: 10 });
    const room = makeRoom({ structures: [hLab, oLab, outputLab] });
    setReactionTargetMemory('OH' as ResourceConstant, 50);

    const result = manageLabs(room, { creeps: [] });

    expect(outputLab.runReaction).not.toHaveBeenCalled();
    expect(result.reaction).toMatchObject({
      product: 'OH',
      reason: 'outputLabUnavailable',
      status: 'blocked'
    });
  });

  it('falls back to reaction selection when lab positions are missing', () => {
    const hLab = makeLab({ id: 'lab-h', mineralType: 'H', mineralAmount: 100 });
    const oLab = makeLab({ id: 'lab-o', mineralType: 'O', mineralAmount: 100 });
    const outputLab = makeLab({ id: 'lab-out', freeCapacity: 3_000 });
    const room = makeRoom({ structures: [hLab, oLab, outputLab] });
    setReactionTargetMemory('OH' as ResourceConstant, 50);

    const result = manageLabs(room, { creeps: [] });

    expect(outputLab.runReaction).toHaveBeenCalledWith(hLab, oLab);
    expect(result.reaction).toMatchObject({
      outputLabId: 'lab-out',
      status: 'running'
    });
  });

  it('continues boost processing after a blocked higher-priority request', () => {
    const fighterBoostLab = makeLab({ id: 'lab-uh', mineralType: 'UH', mineralAmount: 30, energy: 20 });
    const room = makeRoom({ structures: [fighterBoostLab] });
    const upgrader = makeCreep('Upgrader1', ['work'], { role: 'upgrader', colony: 'W1N1' });
    const fighter = makeCreep('Fighter1', ['attack'], {
      lab: { boosts: [{ part: 'attack', resource: 'UH' as MineralBoostConstant }] }
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 150,
      creeps: { Fighter1: fighter, Upgrader1: upgrader }
    };

    const result = manageLabs(room, { creeps: [upgrader, fighter] });

    expect(fighterBoostLab.boostCreep).toHaveBeenCalledWith(fighter, 1);
    expect(upgrader.memory.lab).toMatchObject({
      boostState: 'blocked',
      updatedAt: 150
    });
    expect(fighter.memory.lab).toMatchObject({
      boostState: 'complete',
      updatedAt: 150
    });
    expect(result.boosts).toEqual([
      expect.objectContaining({
        creepName: 'Upgrader1',
        reason: 'resourceUnavailable',
        status: 'blocked'
      }),
      expect.objectContaining({
        creepName: 'Fighter1',
        status: 'boosted'
      })
    ]);
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
  freeCapacity = 3_000,
  x,
  y
}: {
  id: string;
  mineralType?: ResourceConstant | null;
  mineralAmount?: number;
  energy?: number;
  cooldown?: number;
  freeCapacity?: number;
  x?: number;
  y?: number;
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
    runReaction: jest.fn().mockReturnValue(OK_CODE),
    ...(x !== undefined && y !== undefined ? { pos: makeRoomPosition(x, y) } : {})
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

function makeRoomPosition(x: number, y: number): RoomPosition {
  return {
    x,
    y,
    roomName: 'W1N1',
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const targetPos =
        typeof (target as RoomPosition).x === 'number' && typeof (target as RoomPosition).y === 'number'
          ? (target as RoomPosition)
          : (target as RoomObject).pos;

      return Math.max(Math.abs(x - targetPos.x), Math.abs(y - targetPos.y));
    })
  } as unknown as RoomPosition;
}

function setReactionTargetMemory(target: ResourceConstant, desiredAmount?: number): void {
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
          reactionTarget: target,
          ...(desiredAmount !== undefined ? { reactionDesiredAmount: desiredAmount } : {})
        }
      }
    }
  };
}
