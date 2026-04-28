import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  planTerritoryIntent,
  shouldSpawnTerritoryControllerCreep,
  TERRITORY_DOWNGRADE_GUARD_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS,
  TERRITORY_SUPPRESSION_RETRY_TICKS
} from '../src/territory/territoryPlanner';

describe('planTerritoryIntent', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('records the first valid enabled target for the colony', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve', enabled: false },
          { colony: 'W9N9', roomName: 'W9N8', action: 'claim' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'claim', controllerId: 'controller3' as Id<StructureController> }
        ]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 500)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      controllerId: 'controller3'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 500,
        controllerId: 'controller3'
      }
    ]);
  });

  it('seeds an adjacent reserve target when no configured targets exist', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 514)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 514
      }
    ]);
  });

  it('creates a scout intent for an unseen adjacent reserve candidate when no configured targets exist', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 525)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: 525
      }
    ]);
  });

  it('prefers a visible adjacent reserve target before scouting an unknown exit', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 529)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
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
        updatedAt: 529
      }
    ]);
  });

  it('commits a seeded reserve target after scout visibility confirms a safe controller', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 527)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout'
    });

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(
        colony,
        { worker: 3, claimer: 0, claimersByTargetRoom: {}, scout: 1, scoutsByTargetRoom: { W1N2: 1 } },
        3,
        528
      )
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: 527
      },
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 528
      }
    ]);
  });

  it('commits a safe visible adjacent reserve target after scout suppression', () => {
    const colony = makeSafeColony();
    const suppressedScout: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout',
      status: 'suppressed',
      updatedAt: 529
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [suppressedScout]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 530)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      suppressedScout,
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 530
      }
    ]);
  });

  it('does not emit another scout for an unknown adjacent room after scout suppression', () => {
    const colony = makeSafeColony();
    const suppressedScout: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout',
      status: 'suppressed',
      updatedAt: 531
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [suppressedScout]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 532)
    ).toBeNull();
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([suppressedScout]);
  });

  it('retries stale scout suppression for an unknown adjacent room', () => {
    const colony = makeSafeColony();
    const suppressionTime = 531;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'scout',
            status: 'suppressed',
            updatedAt: suppressionTime
          }
        ]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: retryTime
      }
    ]);
  });

  it('skips unavailable, owned, and reserved adjacent rooms before seeding reserve targets', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({
          '1': 'W1N2',
          '3': 'W2N1',
          '5': 'W1N0',
          '7': 'W0N1'
        }))
      } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2' } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room,
        W1N0: {
          name: 'W1N0',
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 4_000 }
          } as StructureController
        } as Room,
        W0N1: { name: 'W0N1', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 533)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W0N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W0N1',
        action: 'reserve'
      }
    ]);
  });

  it('does not seed an adjacent reserve target when the colony has only disabled configured targets', () => {
    const colony = makeSafeColony();
    const disabledTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'reserve',
      enabled: false
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [disabledTarget]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 521)).toBeNull();
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([disabledTarget]);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not seed an adjacent reserve target when the colony has only suppressed configured targets', () => {
    const colony = makeSafeColony();
    const suppressedTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'reserve'
    };
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 520
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [suppressedTarget],
        intents: [suppressedIntent]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 522)).toBeNull();
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([suppressedTarget]);
    expect(Memory.territory?.intents).toEqual([suppressedIntent]);
  });

  it('does not seed an adjacent reserve target when the colony has only visible unavailable configured targets', () => {
    const colony = makeSafeColony();
    const unavailableTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'reserve'
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [unavailableTarget]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 523)).toBeNull();
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([unavailableTarget]);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('uses a visible adjacent reserve target instead of blocked configured targets', () => {
    const colony = makeSafeColony();
    const disabledTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W1N2',
      action: 'reserve',
      enabled: false
    };
    const suppressedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const unavailableTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N0', action: 'reserve' };
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 545
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({
          '1': 'W1N2',
          '3': 'W2N1',
          '5': 'W1N0',
          '7': 'W0N1'
        }))
      } as unknown as GameMap,
      rooms: {
        W1N0: {
          name: 'W1N0',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room,
        W0N1: { name: 'W0N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [disabledTarget, suppressedTarget, unavailableTarget],
        intents: [suppressedIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 546)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W0N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      disabledTarget,
      suppressedTarget,
      unavailableTarget,
      {
        colony: 'W1N1',
        roomName: 'W0N1',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      suppressedIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W0N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 546
      }
    ]);
  });

  it('defers seeded adjacent target writes until recording a finalized plan', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2' })) } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2', controller: { my: false } as StructureController } as Room
      }
    };
    const claimersByTargetRoom = new Proxy<Record<string, number>>(
      {},
      {
        get(target, property) {
          if (property === 'W1N2') {
            expect(Memory.territory?.targets).toBeUndefined();
          }

          return typeof property === 'string' ? target[property] : undefined;
        }
      }
    );

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom }, 3, 518)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 518
      }
    ]);
  });

  it('calls describeExits directly when discovering adjacent rooms', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    const callTrap = jest.fn(() => {
      throw new Error('describeExits.call should not be used');
    });
    Object.defineProperty(describeExits, 'call', { value: callTrap });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 519)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(callTrap).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing configured target when adjacent rooms are discoverable', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 515)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([configuredTarget]);
  });

  it('prefers a visible adjacent reserve target over an unknown configured target', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 547)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      configuredTarget,
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
        updatedAt: 547
      }
    ]);
  });

  it('does not seed visible hostile-owned or self-owned adjacent rooms', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: true, owner: { username: 'me' } } as StructureController
        } as Room
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 516)).toBeNull();
    expect(Memory.territory).toBeUndefined();
  });

  it('does not seed visible adjacent rooms with hostile presence', () => {
    const colony = makeSafeColony();
    const hostile = { id: 'enemy1' } as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: { my: false } as StructureController,
          find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? [hostile] : []))
        } as unknown as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: false } as StructureController,
          find: jest.fn().mockReturnValue([])
        } as unknown as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 517)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve'
      }
    ]);
  });

  it('skips visible adjacent rooms without controllers', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W1N2: {
          name: 'W1N2'
        } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: false } as StructureController
        } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 524)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve'
      }
    ]);
  });

  it('does not seed when every visible adjacent room lacks a controller', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W1N2: { name: 'W1N2' } as Room,
        W2N1: { name: 'W2N1' } as Room
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 526)).toBeNull();
    expect(Memory.territory).toBeUndefined();
  });

  it('does not seed visible reserved adjacent rooms', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 4_000 }
          } as StructureController
        } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: false } as StructureController
        } as Room
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 520)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve'
      }
    ]);
  });

  it('does not throw when map exit APIs are absent', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {} as unknown as GameMap
    };
    let intent: ReturnType<typeof planTerritoryIntent>;

    expect(() => {
      intent = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 517);
    }).not.toThrow();
    expect(intent!).toBeNull();
    expect(Memory.territory).toBeUndefined();
  });

  it('ignores malformed territory memory without throwing', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          null,
          { colony: 'W1N1', roomName: 'W2N1' },
          { colony: 'W1N1', roomName: 'W1N1', action: 'reserve' }
        ] as unknown as TerritoryTargetMemory[]
      }
    };
    let intent: ReturnType<typeof planTerritoryIntent>;

    expect(() => {
      intent = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 501);
    }).not.toThrow();
    expect(intent!).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('normalizes malformed existing intents before updating a matching intent', () => {
    const colony = makeSafeColony();
    const unrelatedIntent: TerritoryIntentMemory = {
      colony: 'W9N9',
      targetRoom: 'W9N8',
      action: 'reserve',
      status: 'planned',
      updatedAt: 400
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }],
        intents: [
          null,
          undefined,
          { colony: 'W1N1', targetRoom: 'W2N1', status: 'planned', updatedAt: 450 },
          unrelatedIntent,
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 451
          }
        ] as unknown as TerritoryIntentMemory[]
      }
    };

    expect(() => {
      expect(
        planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 506)
      ).toEqual({
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve'
      });
    }).not.toThrow();
    expect(Memory.territory?.intents).toEqual([
      unrelatedIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 506
      }
    ]);
  });

  it('does not emit or spawn suppressed claim targets', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'suppressed',
            updatedAt: 510
          }
        ]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 511)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        511
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 510
      }
    ]);
  });

  it('retries stale suppressed claim targets', () => {
    const colony = makeSafeColony();
    const suppressionTime = 510;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const roleCounts = { worker: 3, claimer: 0, claimersByTargetRoom: {} };
    const plan = { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' } as const;
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

    expect(shouldSpawnTerritoryControllerCreep(plan, roleCounts, retryTime)).toBe(true);
    expect(planTerritoryIntent(colony, roleCounts, 3, retryTime)).toEqual(plan);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: retryTime
      }
    ]);
  });

  it('preserves suppressed intents while planning the next eligible target', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'claim' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ],
        intents: [
          null,
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'suppressed',
            updatedAt: 512
          }
        ] as unknown as TerritoryIntentMemory[]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 513)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 512
      },
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 513
      }
    ]);
  });

  it('does not emit territory intent when the home controller is near downgrade', () => {
    const colony = makeSafeColony({
      controller: { my: true, level: 3, ticksToDowngrade: TERRITORY_DOWNGRADE_GUARD_TICKS } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 502)).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not request replacement claimers after a visible claim target is self-owned', () => {
    const colony = makeSafeColony();
    const ownedController = { my: true, owner: { username: 'me' } } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: ownedController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 503)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('skips visible hostile-owned claim targets and plans the next eligible target', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'claim' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'claim' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 508);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'claim' });
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 508
      }
    ]);
  });

  it('prefers visible claim targets over visible reserve targets', () => {
    const colony = makeSafeColony();
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
          { colony: 'W1N1', roomName: 'W3N1', action: 'claim' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 548);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'claim' });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 548
      }
    ]);
  });

  it('still requests claimers for visible unowned claim targets', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 504);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 504
      }
    ]);
  });

  it('does not request reserve claimers after a visible reserve target is self-owned', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: true, owner: { username: 'me' } } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 505)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('skips visible hostile-owned reserve targets and plans the next eligible target', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 506);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 506
      }
    ]);
  });

  it('skips configured targets when route lookup reports no path', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      fromRoom === 'W1N1' && toRoom === 'W2N1' ? -2 : [{ exit: 3, room: toRoom }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { findRoute } as unknown as GameMap,
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
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 549);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W2N1');
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W3N1');
    expect(Memory.territory?.routeDistances).toEqual({
      'W1N1>W2N1': null,
      'W1N1>W3N1': 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 549
      }
    ]);
  });

  it('plans an adjacent scout when configured targets have no known route', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      fromRoom === 'W1N1' && toRoom === 'W3N1' ? -2 : [{ exit: 1, room: toRoom }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits, findRoute } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 552);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'scout' });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W3N1');
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W1N2');
    expect(Memory.territory?.routeDistances).toEqual({
      'W1N1>W3N1': null,
      'W1N1>W1N2': 1
    });
    expect(Memory.territory?.targets).toEqual([{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: 552
      }
    ]);
  });

  it('revalidates cached no-route entries before suppressing configured targets', () => {
    const colony = makeSafeColony();
    const findRoute = jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { findRoute } as unknown as GameMap,
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
        routeDistances: {
          'W1N1>W2N1': null,
          'W1N1>W3N1': 1
        }
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 553);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' });
    expect(findRoute).toHaveBeenCalledTimes(1);
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W2N1');
    expect(Memory.territory?.routeDistances).toEqual({
      'W1N1>W2N1': 1,
      'W1N1>W3N1': 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 553
      }
    ]);
  });

  it('reuses cached route lengths while rechecking cached no-route targets in later planning passes', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      fromRoom === 'W1N1' && toRoom === 'W2N1' ? -2 : [{ exit: 3, room: toRoom }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { findRoute } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 550);
    const nextPlan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 551);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(nextPlan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(findRoute).toHaveBeenCalledTimes(3);
    expect(findRoute).toHaveBeenNthCalledWith(1, 'W1N1', 'W2N1');
    expect(findRoute).toHaveBeenNthCalledWith(2, 'W1N1', 'W3N1');
    expect(findRoute).toHaveBeenNthCalledWith(3, 'W1N1', 'W2N1');
    expect(Memory.territory?.routeDistances).toEqual({
      'W1N1>W2N1': null,
      'W1N1>W3N1': 1
    });
  });

  it('prioritizes a neutral adjacent reserve target over a healthy own configured reservation', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        } as Room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 539);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.targets).toEqual([
      configuredTarget,
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
        updatedAt: 539
      }
    ]);
  });

  it('skips hostile and suppressed adjacent reserve targets after a satisfied reservation', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 540
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({
          '1': 'W1N2',
          '3': 'W2N1',
          '5': 'W1N0',
          '7': 'W0N1'
        }))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        } as Room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W1N0: {
          name: 'W1N0',
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 4_000 }
          } as StructureController
        } as Room,
        W0N1: { name: 'W0N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget],
        intents: [suppressedIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 541)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W0N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      configuredTarget,
      {
        colony: 'W1N1',
        roomName: 'W0N1',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      suppressedIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W0N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 541
      }
    ]);
  });

  it('renews an own visible reserve target near expiry', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
          } as StructureController
        } as Room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 534);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' });
    expect(describeExits).not.toHaveBeenCalled();
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.targets).toEqual([configuredTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 534
      }
    ]);
  });

  it('renews the lowest-TTL configured reserve before other configured targets', () => {
    const colony = makeSafeColony();
    const unreservedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const higherTtlTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const lowerTtlTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W4N1', action: 'reserve' };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W3N1: {
          name: 'W3N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS - 100 }
          } as StructureController
        } as Room,
        W4N1: {
          name: 'W4N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS - 700 }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [unreservedTarget, higherTtlTarget, lowerTtlTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 542);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W4N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W4N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 542
      }
    ]);
  });

  it('keeps unreserved configured reserve targets eligible when no renewal is urgent', () => {
    const colony = makeSafeColony();
    const healthyReservationTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const unreservedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        } as Room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [healthyReservationTarget, unreservedTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 543);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
    expect(Memory.territory?.targets).toEqual([healthyReservationTarget, unreservedTarget]);
  });

  it('does not treat hostile or owned reserve targets as renewal candidates', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS - 900 }
          } as StructureController
        } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: true, owner: { username: 'me' } } as StructureController
        } as Room,
        W3N1: {
          name: 'W3N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS - 100 }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 544);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
  });

  it('does not over-spawn for a healthy own visible reservation', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W1N2', action: 'reserve' }]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 535)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('skips visible enemy-reserved reserve targets and plans the next eligible target', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: {
          name: 'W2N1',
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
          } as StructureController
        } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 536);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W3N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 536
      }
    ]);
  });

  it('does not renew an explicitly suppressed own reserve target near expiry', () => {
    const colony = makeSafeColony();
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 537
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W1N2', action: 'reserve' }],
        intents: [suppressedIntent]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 538)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toEqual([suppressedIntent]);
  });

  it('renews a stale suppressed own reserve target near expiry', () => {
    const colony = makeSafeColony();
    const suppressionTime = 537;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W1N2', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime
          }
        ]
      }
    };

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      retryTime
    );

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, retryTime)
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime
      }
    ]);
  });

  it('still requests claimers for visible unowned reserve targets', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 507);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} })
    ).toBe(true);
  });
});

function makeSafeColony({
  roomName = 'W1N1',
  controller = { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
}: {
  roomName?: string;
  controller?: StructureController;
} = {}): ColonySnapshot {
  const room = {
    name: roomName,
    controller,
    energyAvailable: 650,
    energyCapacityAvailable: 650
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable: 650,
    energyCapacityAvailable: 650
  };
}
