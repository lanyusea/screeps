import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planTerritoryIntent, TERRITORY_DOWNGRADE_GUARD_TICKS } from '../src/territory/territoryPlanner';

describe('planTerritoryIntent', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
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
});

function makeSafeColony({
  roomName = 'W1N1',
  controller = { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
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
