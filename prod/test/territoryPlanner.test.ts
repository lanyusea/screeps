import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildTerritoryCreepMemory,
  getActiveTerritoryFollowUpExecutionHints,
  planTerritoryIntent,
  recordTerritoryReserveFallbackIntent,
  recordRecoveredTerritoryFollowUpRetryCooldown,
  requiresTerritoryControllerPressure,
  shouldSpawnTerritoryControllerCreep,
  suppressTerritoryIntent,
  TERRITORY_DOWNGRADE_GUARD_TICKS,
  TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS,
  TERRITORY_SUPPRESSION_RETRY_TICKS
} from '../src/territory/territoryPlanner';

describe('planTerritoryIntent', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 8;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 9;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('scouts the first valid enabled target for the colony when visibility is missing', () => {
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
      action: 'scout',
      controllerId: 'controller3'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'scout',
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
      action: 'scout'
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

  it('uses a sufficient visible occupy recommendation as a claim intent', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 565)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 565
      }
    ]);
  });

  it('uses recommendation scoring to seed the strongest sufficient visible reserve candidate', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N2: makeRecommendationRoom('W1N2', { sourceCount: 1 }),
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 })
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 566)
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
  });

  it('excludes a cached no-route recommendation before selecting the next visible reserve candidate', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      fromRoom === 'W1N1' && toRoom === 'W2N1' ? -2 : [{ exit: 3, room: toRoom }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { findRoute } as unknown as GameMap,
      rooms: {
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 }),
        W3N1: makeRecommendationRoom('W3N1', { sourceCount: 1 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ],
        routeDistances: { 'W1N1>W2N1': null }
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 567)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve'
    });
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W2N1');
    expect(Memory.territory?.routeDistances).toEqual({
      'W1N1>W2N1': null,
      'W1N1>W3N1': 1
    });
  });

  it('does not override a safer visible configured target with a higher-scoring adjacent recommendation', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 }),
        W3N1: makeRecommendationRoom('W3N1', { sourceCount: 1 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 568)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve'
    });
    expect(describeExits).not.toHaveBeenCalled();
    expect(Memory.territory?.targets).toEqual([configuredTarget]);
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

  it('normalizes malformed existing intents before recording a scout for missing target evidence', () => {
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
        action: 'scout'
      });
    }).not.toThrow();
    expect(Memory.territory?.intents).toEqual([
      unrelatedIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 451
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
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

  it('scouts stale suppressed claim targets before retrying controller work', () => {
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
    expect(planTerritoryIntent(colony, roleCounts, 3, retryTime)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'scout'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: suppressionTime
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
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
      action: 'scout'
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
        action: 'scout',
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

  it('does not route a persisted claim intent after the visible target is self-owned', () => {
    const colony = makeSafeColony();
    const persistedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 569
    };
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
        intents: [persistedIntent]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 570)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        570
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toEqual([persistedIntent]);
  });

  it('prioritizes lower reservation TTL among persisted occupation claim follow-up intents', () => {
    const colony = makeSafeColony();
    const followUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N2', 'claim');
    const lessUrgentIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 571,
      followUp
    };
    const urgentIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 572,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: 800 }
          } as StructureController
        } as Room,
        W3N1: {
          name: 'W3N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: 200 }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [lessUrgentIntent, urgentIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 573)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      lessUrgentIntent,
      {
        ...urgentIntent,
        updatedAt: 573
      }
    ]);
  });

  it('prioritizes unreserved persisted occupation claim follow-up intents before reserved claims', () => {
    const colony = makeSafeColony();
    const followUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N2', 'claim');
    const reservedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 574,
      followUp
    };
    const unreservedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 575,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: 100 }
          } as StructureController
        } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [reservedIntent, unreservedIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 576)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      reservedIntent,
      {
        ...unreservedIntent,
        updatedAt: 576
      }
    ]);
  });

  it('scouts adjacent rooms after a configured claim target is owned by the colony account', () => {
    const colony = makeSafeColony();
    const claimedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'claim' };
    const followUp = makeFollowUp('satisfiedClaimAdjacent', 'W2N1', 'claim');
    const describeExits = jest.fn(() => ({ '3': 'W3N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'me' } } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimedTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 554)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'scout',
      followUp
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([claimedTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 554,
        followUp
      }
    ]);
  });

  it('prefers the satisfied claim target as the next adjacent scout origin', () => {
    const colony = makeSafeColony();
    const claimedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'claim' };
    const followUp = makeFollowUp('satisfiedClaimAdjacent', 'W2N1', 'claim');
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W2N1' ? { '3': 'W3N1' } : { '1': 'W1N2' }
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller: { my: false, owner: { username: 'me' } } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimedTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 555)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'scout',
      followUp
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(describeExits).toHaveBeenCalledWith('W2N1');
    expect(Memory.territory?.targets).toEqual([claimedTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 555,
        followUp
      }
    ]);
  });

  it('scouts an adjacent room while a configured claim target already has active coverage', () => {
    const colony = makeSafeColony();
    const activeClaimIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'active',
      updatedAt: 555
    };
    const describeExits = jest.fn(() => ({ '1': 'W1N2' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [activeClaimIntent]
      }
    };

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { claim: { W2N1: 1 } }
        },
        3,
        556
      )
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]);
    expect(Memory.territory?.intents).toEqual([
      activeClaimIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: 556
      }
    ]);
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
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
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

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', followUp });
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
        updatedAt: 539,
        followUp
      }
    ]);
  });

  it('extends from a satisfied configured reservation before home-adjacent reserve pressure', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N2' ? { '3': 'W2N2' } : { '3': 'W2N1' }
    );
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
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 562);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N2', action: 'reserve', followUp });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(Memory.territory?.targets).toEqual([
      configuredTarget,
      {
        colony: 'W1N1',
        roomName: 'W2N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 562,
        followUp
      }
    ]);
  });

  it('records one bounded preparation demand for a selected visible follow-up target per planning window', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
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
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 590)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      followUp
    });
    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 590)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      followUp
    });
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 590,
        followUp
      }
    ]);
  });

  it('does not record a preparation demand for a suppressed follow-up target', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 591
    };
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
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
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget],
        intents: [suppressedIntent]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 592)).toBeNull();
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([suppressedIntent]);
  });

  it('does not record a preparation demand for an unavailable follow-up target', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
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
        W2N2: {
          name: 'W2N2',
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 593)).toBeNull();
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('prefers a visible adjacent reserve follow-up over a lower-confidence distant reserve', () => {
    const colony = makeSafeColony();
    const distantTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W9N1', action: 'reserve' };
    const satisfiedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
    const findRoute = jest.fn((_fromRoom: string, toRoom: string) =>
      Array.from({ length: toRoom === 'W9N1' ? 4 : toRoom === 'W2N2' ? 2 : 1 }, (_value, index) => ({
        exit: 3,
        room: `${toRoom}-${index}`
      }))
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits, findRoute } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: makeRecommendationRoom('W1N2', {
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        }),
        W2N2: makeRecommendationRoom('W2N2', { sourceCount: 2 }),
        W9N1: makeRecommendationRoom('W9N1', { sourceCount: 1 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [distantTarget, satisfiedTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 577);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N2', action: 'reserve', followUp });
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(describeExits).not.toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      distantTarget,
      satisfiedTarget,
      {
        colony: 'W1N1',
        roomName: 'W2N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 577,
        followUp
      }
    ]);
  });

  it('preserves a visible adjacent reserve follow-up through suppression and retry', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 580;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
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
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 579)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      followUp
    });

    suppressTerritoryIntent('W1N1', { targetRoom: 'W2N2', action: 'reserve' }, suppressionTime);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        followUp
      }
    ]);
    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, suppressionTime + 1)
    ).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        followUp
      }
    ]);

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('prefers a recovered follow-up intent over an equivalent generic configured target after suppression retry', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const recoveredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 581;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const suppressedFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: suppressionTime,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeRecommendationRoom('W2N1'),
        W3N1: makeRecommendationRoom('W3N1')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, recoveredTarget],
        intents: [suppressedFollowUpIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, suppressionTime + 1)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.intents).toEqual([
      suppressedFollowUpIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: suppressionTime + 1
      }
    ]);

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: suppressionTime + 1
      }
    ]);
  });

  it('cools down recovered follow-up attempts before retrying them again', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const recoveredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 582;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const cooledRetryTime = retryTime + TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS + 1;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeRecommendationRoom('W2N1'),
        W3N1: makeRecommendationRoom('W3N1')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, recoveredTarget],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    const recoveredPlan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      retryTime
    );
    expect(recoveredPlan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });

    recordRecoveredTerritoryFollowUpRetryCooldown(recoveredPlan, retryTime);

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime + 1)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        lastAttemptAt: retryTime,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime + 1
      }
    ]);

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, cooledRetryTime)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: cooledRetryTime,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime + 1
      }
    ]);
  });

  it('prefers an active controller follow-up over spawn-ready generic territory work while preserving cooldowns', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const activeFollowUpTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const coolingDownFollowUpTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W4N1',
      action: 'reserve'
    };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 586;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 2;
    const activeFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 585,
      followUp
    };
    const coolingDownFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W4N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: suppressionTime,
      lastAttemptAt: retryTime - 1,
      followUp
    };
    const roleCounts = {
      worker: 3,
      claimer: 2,
      claimersByTargetRoom: { W3N1: 1, W4N1: 1 },
      claimersByTargetRoomAction: { reserve: { W3N1: 1, W4N1: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 }),
        W3N1: makeRecommendationRoom('W3N1', { sourceCount: 1 }),
        W4N1: makeRecommendationRoom('W4N1', { sourceCount: 2 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, activeFollowUpTarget, coolingDownFollowUpTarget],
        intents: [activeFollowUpIntent, coolingDownFollowUpIntent]
      }
    };

    const plan = planTerritoryIntent(colony, roleCounts, 3, retryTime);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });
    expect(shouldSpawnTerritoryControllerCreep(plan!, roleCounts, retryTime)).toBe(false);
    expect(Memory.territory?.intents).toEqual([
      {
        ...activeFollowUpIntent,
        status: 'active',
        updatedAt: retryTime
      },
      coolingDownFollowUpIntent
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        workerCount: 1,
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('keeps a planned controller follow-up before higher-scored generic reserve work', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const followUpTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const followUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 588,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 }),
        W3N1: makeRecommendationRoom('W3N1', { sourceCount: 1 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, followUpTarget],
        intents: [followUpIntent]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 589);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        ...followUpIntent,
        updatedAt: 589
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 589,
        followUp
      }
    ]);
  });

  it('records and refreshes one active execution hint for a persisted actionable follow-up', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const followUpTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const followUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 592,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', { sourceCount: 2 }),
        W3N1: makeRecommendationRoom('W3N1')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, followUpTarget],
        intents: [followUpIntent],
        executionHints: [
          {
            type: 'activeFollowUpExecution',
            colony: 'W1N1',
            targetRoom: 'W9N9',
            action: 'reserve',
            reason: 'visibleControlEvidenceStillActionable',
            updatedAt: 591,
            followUp
          }
        ]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 593)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });
    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 594)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      followUp
    });

    const expectedHint: TerritoryExecutionHintMemory = {
      type: 'activeFollowUpExecution',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      reason: 'visibleControlEvidenceStillActionable',
      updatedAt: 594,
      followUp
    };
    expect(Memory.territory?.executionHints).toEqual([expectedHint]);
    expect(getActiveTerritoryFollowUpExecutionHints('W1N1')).toEqual([expectedHint]);
  });

  it('clears a stale execution hint when the matching follow-up intent is gone', () => {
    const colony = makeSafeColony();
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 595
          }
        ],
        executionHints: [
          {
            type: 'activeFollowUpExecution',
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            reason: 'visibleControlEvidenceStillActionable',
            updatedAt: 595,
            followUp
          }
        ]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 596)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.executionHints).toBeUndefined();
    expect(getActiveTerritoryFollowUpExecutionHints('W1N1')).toEqual([]);
  });

  it('preserves an active execution hint when a live follow-up intent remains behind a scout plan', () => {
    const colony = makeSafeColony();
    colony.energyAvailable = 50;
    (colony.room as Room & { energyAvailable: number }).energyAvailable = 50;
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const followUpTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const followUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 596,
      followUp
    };
    const existingHint: TerritoryExecutionHintMemory = {
      type: 'activeFollowUpExecution',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      reason: 'visibleControlEvidenceStillActionable',
      updatedAt: 596,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W3N1: makeRecommendationRoom('W3N1')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, followUpTarget],
        intents: [followUpIntent],
        executionHints: [existingHint]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 597)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'scout'
    });
    expect(Memory.territory?.executionHints).toEqual([existingHint]);
    expect(getActiveTerritoryFollowUpExecutionHints('W1N1')).toEqual([existingHint]);
  });

  it('drops persisted follow-up metadata after visible controller evidence satisfies the target', () => {
    const colony = makeSafeColony();
    const genericTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const staleFollowUpTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const staleFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 590,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1'),
        W3N1: makeRecommendationRoom('W3N1', {
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [genericTarget, staleFollowUpTarget],
        intents: [staleFollowUpIntent],
        executionHints: [
          {
            type: 'activeFollowUpExecution',
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            reason: 'visibleControlEvidenceStillActionable',
            updatedAt: 590,
            followUp
          }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 591);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 590
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 591
      }
    ]);
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.executionHints).toBeUndefined();
  });

  it('scouts an alternate adjacent room while a recovered follow-up target is cooling down', () => {
    const colony = makeSafeColony();
    const recoveredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 584;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const cooldownTime = retryTime + 1;
    const coolingDownFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: suppressionTime,
      lastAttemptAt: retryTime,
      followUp
    };
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N1' ? { '1': 'W1N2' } : {}));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [recoveredTarget],
        intents: [coolingDownFollowUpIntent]
      }
    };

    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, cooldownTime)
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'scout'
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.intents).toEqual([
      coolingDownFollowUpIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'scout',
        status: 'planned',
        updatedAt: cooldownTime
      }
    ]);
  });

  it('keeps recovered follow-up safety filters ahead of retry cooldown markers', () => {
    const colony = makeSafeColony();
    const recoveredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 583;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const suppressedFollowUpIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: suppressionTime,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W3N1: makeRecommendationRoom('W3N1', {
          controller: { my: false, owner: { username: 'enemy' } } as StructureController
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [recoveredTarget],
        intents: [suppressedFollowUpIntent]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([suppressedFollowUpIntent]);
  });

  it('keeps a stronger visible configured reserve before adjacent follow-up expansion', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W9N1', action: 'reserve' };
    const satisfiedTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const describeExits = jest.fn((roomName: string) => (roomName === 'W1N2' ? { '3': 'W2N2' } : {}));
    const findRoute = jest.fn((_fromRoom: string, toRoom: string) =>
      Array.from({ length: toRoom === 'W9N1' ? 2 : toRoom === 'W2N2' ? 3 : 1 }, (_value, index) => ({
        exit: 3,
        room: `${toRoom}-${index}`
      }))
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits, findRoute } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: makeRecommendationRoom('W1N2', {
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        }),
        W2N2: makeRecommendationRoom('W2N2', { sourceCount: 1 }),
        W9N1: makeRecommendationRoom('W9N1', { sourceCount: 2 })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget, satisfiedTarget]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 578);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W9N1', action: 'reserve' });
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(Memory.territory?.targets).toEqual([configuredTarget, satisfiedTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W9N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 578
      }
    ]);
  });

  it('extends from an actively covered visible reservation before home-adjacent reserve pressure', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('activeReserveAdjacent', 'W1N2', 'reserve');
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N2' ? { '3': 'W2N2' } : { '1': 'W1N2', '3': 'W2N1' }
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: { name: 'W1N2', controller: { my: false } as StructureController } as Room,
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(
      colony,
      {
        worker: 3,
        claimer: 1,
        claimersByTargetRoom: { W1N2: 1 },
        claimersByTargetRoomAction: { reserve: { W1N2: 1 } }
      },
      3,
      563
    );

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W2N2', action: 'reserve', followUp });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(Memory.territory?.targets).toEqual([
      configuredTarget,
      {
        colony: 'W1N1',
        roomName: 'W2N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 563,
        followUp
      }
    ]);
  });

  it('keeps a live reserve fallback ahead of retrying the expired claim target', () => {
    const colony = makeSafeColony();
    const claimTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'claim' };
    const reserveTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N1', 'claim');
    const suppressionTime = 598;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const roleCounts = {
      worker: 3,
      claimer: 1,
      claimersByTargetRoom: { W1N2: 1 },
      claimersByTargetRoomAction: { reserve: { W1N2: 1 } }
    };
    const suppressedClaimIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'claim',
      status: 'suppressed',
      updatedAt: suppressionTime,
      followUp
    };
    const activeReserveIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve',
      status: 'active',
      updatedAt: suppressionTime + 1,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: makeRecommendationRoom('W1N2')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimTarget, reserveTarget],
        intents: [suppressedClaimIntent, activeReserveIntent]
      }
    };

    const plan = planTerritoryIntent(colony, roleCounts, 3, retryTime);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve', followUp });
    expect(shouldSpawnTerritoryControllerCreep(plan!, roleCounts, retryTime)).toBe(false);
    expect(Memory.territory?.targets).toEqual([claimTarget, reserveTarget]);
    expect(Memory.territory?.intents).toEqual([
      suppressedClaimIntent,
      {
        ...activeReserveIntent,
        updatedAt: retryTime
      }
    ]);
  });

  it('extends from a satisfied reserve fallback before retrying the expired claim target', () => {
    const colony = makeSafeColony();
    const claimTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'claim' };
    const reserveTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const fallbackFollowUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N1', 'claim');
    const adjacentFollowUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
    const suppressionTime = 599;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N1' ? { '1': 'W1N2' } : roomName === 'W1N2' ? { '3': 'W2N2' } : {}
    );
    const suppressedClaimIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'claim',
      status: 'suppressed',
      updatedAt: suppressionTime,
      followUp: fallbackFollowUp
    };
    const activeReserveIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve',
      status: 'active',
      updatedAt: suppressionTime + 1,
      followUp: fallbackFollowUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: makeRecommendationRoom('W1N2', {
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 500 }
          } as StructureController
        }),
        W2N2: makeRecommendationRoom('W2N2')
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimTarget, reserveTarget],
        intents: [suppressedClaimIntent, activeReserveIntent]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, retryTime);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      followUp: adjacentFollowUp
    });
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(Memory.territory?.targets).toEqual([
      claimTarget,
      reserveTarget,
      {
        colony: 'W1N1',
        roomName: 'W2N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      suppressedClaimIntent,
      activeReserveIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: retryTime,
        followUp: adjacentFollowUp
      }
    ]);
  });

  it('clears stale same-room reserve fallback after the claim target is owned', () => {
    const colony = makeSafeColony();
    const claimTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'claim' };
    const reserveTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const fallbackFollowUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N1', 'claim');
    const adjacentFollowUp = makeFollowUp('satisfiedClaimAdjacent', 'W1N2', 'claim');
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N1' ? { '1': 'W1N2' } : roomName === 'W1N2' ? { '3': 'W2N2' } : {}
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: makeRecommendationRoom('W1N2', {
          controller: { my: true, owner: { username: 'me' } } as StructureController
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimTarget, reserveTarget],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 600,
            followUp: fallbackFollowUp
          }
        ],
        demands: [
          {
            type: 'followUpPreparation',
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            workerCount: 1,
            updatedAt: 600,
            followUp: fallbackFollowUp
          }
        ],
        executionHints: [
          {
            type: 'activeFollowUpExecution',
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            reason: 'visibleControlEvidenceStillActionable',
            updatedAt: 600,
            followUp: fallbackFollowUp
          }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 601);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'scout',
      followUp: adjacentFollowUp
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(describeExits).toHaveBeenCalledWith('W1N2');
    expect(Memory.territory?.targets).toEqual([claimTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'scout',
        status: 'planned',
        updatedAt: 601,
        followUp: adjacentFollowUp
      }
    ]);
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.executionHints).toEqual([
      {
        type: 'activeFollowUpExecution',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'scout',
        reason: 'followUpTargetStillUnseen',
        updatedAt: 601,
        followUp: adjacentFollowUp
      }
    ]);
  });

  it('keeps emergency renewal ahead of active-reserve frontier expansion', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N2' ? { '3': 'W2N2' } : { '1': 'W1N2' }
    );
    const roleCounts = {
      worker: 3,
      claimer: 1,
      claimersByTargetRoom: { W1N2: 1 },
      claimersByTargetRoomAction: { reserve: { W1N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
          } as StructureController
        } as Room,
        W2N2: { name: 'W2N2', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(colony, roleCounts, 3, 564);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' });
    expect(describeExits).not.toHaveBeenCalled();
    expect(shouldSpawnTerritoryControllerCreep(plan!, roleCounts, 564)).toBe(true);
    expect(Memory.territory?.targets).toEqual([configuredTarget]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 564
      }
    ]);
  });

  it('skips hostile and suppressed adjacent reserve targets after a satisfied reservation', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const followUp = makeFollowUp('satisfiedReserveAdjacent', 'W1N2', 'reserve');
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
      action: 'reserve',
      followUp
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
        updatedAt: 541,
        followUp
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

  it('spawns one backup reserver for an emergency own reservation despite active coverage', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const roleCounts = {
      worker: 3,
      claimer: 1,
      claimersByTargetRoom: { W1N2: 1 },
      claimersByTargetRoomAction: { reserve: { W1N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 559
          }
        ]
      }
    };

    const plan = planTerritoryIntent(colony, roleCounts, 3, 560);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' });
    expect(shouldSpawnTerritoryControllerCreep(plan!, roleCounts, 560)).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 560
      }
    ]);
  });

  it('does not spawn a third reserver for an emergency own reservation', () => {
    const colony = makeSafeColony();
    const configuredTarget: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W1N2', action: 'reserve' };
    const roleCounts = {
      worker: 3,
      claimer: 2,
      claimersByTargetRoom: { W1N2: 2 },
      claimersByTargetRoomAction: { reserve: { W1N2: 2 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W1N2: {
          name: 'W1N2',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [configuredTarget]
      }
    };

    const plan = planTerritoryIntent(colony, roleCounts, 3, 561);

    expect(plan).toEqual({ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve' });
    expect(shouldSpawnTerritoryControllerCreep(plan!, roleCounts, 561)).toBe(false);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 561
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

  it('keeps own renewal ahead of foreign reservation pressure and owned reserve targets', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
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
        { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve', requiresControllerPressure: true },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(true);
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

  it('keeps an unreserved target ahead of enemy-reserved controller pressure', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
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
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', requiresControllerPressure: true },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} }
      )
    ).toBe(true);
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

  it('does not dispatch a configured foreign reservation pressure target without pressure body capacity', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 542)).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', requiresControllerPressure: true },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        542
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('infers visible foreign reservation pressure before spawning stale reserve intents', () => {
    const colony = makeSafeColony();
    const stalePlan = { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' } as const;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController
        })
      }
    };

    expect(requiresTerritoryControllerPressure(stalePlan)).toBe(true);
    expect(
      shouldSpawnTerritoryControllerCreep(
        stalePlan,
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        542
      )
    ).toBe(false);
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

  it('dispatches a configured reserve target to pressure a foreign reservation', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 542);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      requiresControllerPressure: true
    });
    expect(
      shouldSpawnTerritoryControllerCreep(plan!, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 542)
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 542,
        requiresControllerPressure: true
      }
    ]);
  });

  it('preserves live pressure when suppressing a visible foreign-reserved reserve intent', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
    const target: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const existingIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 543,
      requiresControllerPressure: true
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [target],
        intents: [existingIntent]
      }
    };

    suppressTerritoryIntent('W1N1', { targetRoom: 'W2N1', action: 'reserve' }, 544);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 544,
        requiresControllerPressure: true
      }
    ]);
  });

  it('preserves live pressure when recording a visible foreign-reserved fallback intent', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
    const target: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const existingIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 543,
      requiresControllerPressure: true
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [target],
        intents: [existingIntent]
      }
    };

    recordTerritoryReserveFallbackIntent('W1N1', { targetRoom: 'W2N1', action: 'reserve' }, 544);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 544,
        requiresControllerPressure: true
      }
    ]);
  });

  it('clears pressure when recording a visible unreserved fallback intent', () => {
    const colony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
    const target: TerritoryTargetMemory = { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' };
    const existingIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 543,
      requiresControllerPressure: true
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: { my: false } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [target],
        intents: [existingIntent]
      }
    };

    recordTerritoryReserveFallbackIntent('W1N1', { targetRoom: 'W2N1', action: 'reserve' }, 544);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 544
      }
    ]);
  });

  it('keeps foreign reservation pressure body requirements after target vision is lost', () => {
    const visibleColony = makeSafeColony({ energyAvailable: 3250, energyCapacityAvailable: 3250 });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          sourceCount: 2
        })
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    const pressurePlan = planTerritoryIntent(
      visibleColony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      543
    );

    expect(pressurePlan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      requiresControllerPressure: true
    });

    const lowCapacityColony = makeSafeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: lowCapacityColony.room
      }
    };

    expect(
      planTerritoryIntent(lowCapacityColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 544)
    ).toBeNull();
    expect(
      shouldSpawnTerritoryControllerCreep(
        { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', requiresControllerPressure: true },
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        544
      )
    ).toBe(false);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 543,
        requiresControllerPressure: true
      }
    ]);

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: lowCapacityColony.room,
        W2N1: makeRecommendationRoom('W2N1', {
          controller: { my: false } as StructureController,
          sourceCount: 2
        })
      }
    };

    const clearedPressurePlan = planTerritoryIntent(
      lowCapacityColony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      545
    );

    expect(clearedPressurePlan).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' });
    expect(clearedPressurePlan).not.toHaveProperty('requiresControllerPressure');
    expect(
      shouldSpawnTerritoryControllerCreep(
        clearedPressurePlan!,
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        545
      )
    ).toBe(true);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 545
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

  it('carries follow-up metadata into territory creep memory', () => {
    const followUp = makeFollowUp('activeReserveAdjacent', 'W1N2', 'reserve');

    expect(
      buildTerritoryCreepMemory({
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        followUp
      })
    ).toEqual({
      role: 'claimer',
      colony: 'W1N1',
      territory: {
        targetRoom: 'W2N2',
        action: 'reserve',
        followUp
      }
    });
  });
});

function makeFollowUp(
  source: TerritoryFollowUpSource,
  originRoom: string,
  originAction: TerritoryControlAction
): TerritoryFollowUpMemory {
  return {
    source,
    originRoom,
    originAction
  };
}

function makeRecommendationRoom(
  roomName: string,
  {
    controller = { my: false } as StructureController,
    sourceCount = 1,
    hostileCreepCount = 0,
    hostileStructureCount = 0
  }: {
    controller?: StructureController;
    sourceCount?: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
  } = {}
): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return Array.from({ length: sourceCount }, (_value, index) => ({ id: `source${index}` }));
        case FIND_HOSTILE_CREEPS:
          return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile${index}` }));
        case FIND_HOSTILE_STRUCTURES:
          return Array.from({ length: hostileStructureCount }, (_value, index) => ({
            id: `hostileStructure${index}`
          }));
        case FIND_MY_STRUCTURES:
        case FIND_MY_CONSTRUCTION_SITES:
          return [];
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function makeSafeColony({
  roomName = 'W1N1',
  controller = { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController,
  energyAvailable = 650,
  energyCapacityAvailable = 650
}: {
  roomName?: string;
  controller?: StructureController;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: roomName,
    controller,
    energyAvailable,
    energyCapacityAvailable
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable,
    energyCapacityAvailable
  };
}
