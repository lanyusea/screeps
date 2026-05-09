import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import {
  COLONY_UPGRADE_DOWNGRADE_RISK_TICKS,
  selectColonyUpgradeTarget,
  selectColonyUpgradeTargets
} from '../../src/territory/colonyUpgradePriority';

describe('colony upgrade priority', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('returns the only upgradeable room when it has workers', () => {
    const colony = makeColony({ roomName: 'W1N1' });
    installWorkers(['W1N1']);

    expect(selectColonyUpgradeTarget([colony])).toBe(colony);
  });

  it('prefers the room closest to the next controller level', () => {
    const slowProgress = makeColony({ roomName: 'W1N1', progress: 100, progressTotal: 1_000 });
    const nearLevel = makeColony({ roomName: 'W2N1', progress: 950, progressTotal: 1_000 });
    installWorkers(['W1N1', 'W2N1']);

    expect(selectColonyUpgradeTarget([slowProgress, nearLevel])).toBe(nearLevel);
    expect(selectColonyUpgradeTargets([slowProgress, nearLevel])).toEqual([nearLevel]);
  });

  it('keeps downgrade-risk rooms eligible alongside the level-up target', () => {
    const nearLevel = makeColony({
      roomName: 'W1N1',
      progress: 950,
      progressTotal: 1_000,
      ticksToDowngrade: 20_000
    });
    const downgradeRisk = makeColony({
      roomName: 'W2N1',
      progress: 100,
      progressTotal: 1_000,
      ticksToDowngrade: COLONY_UPGRADE_DOWNGRADE_RISK_TICKS
    });
    installWorkers(['W1N1', 'W2N1']);

    expect(selectColonyUpgradeTarget([nearLevel, downgradeRisk])).toBe(downgradeRisk);
    expect(selectColonyUpgradeTargets([nearLevel, downgradeRisk])).toEqual([
      downgradeRisk,
      nearLevel
    ]);
  });

  it('skips rooms without available workers', () => {
    const starvedNearLevel = makeColony({ roomName: 'W1N1', progress: 990, progressTotal: 1_000 });
    const staffedRoom = makeColony({ roomName: 'W2N1', progress: 100, progressTotal: 1_000 });
    installWorkers(['W2N1']);

    expect(selectColonyUpgradeTarget([starvedNearLevel, staffedRoom])).toBe(staffedRoom);
    expect(selectColonyUpgradeTarget([starvedNearLevel])).toBeNull();
  });

  it('uses colony role after controller progress signals match', () => {
    const homeRoom = makeColony({ roomName: 'W1N1', progress: 500, progressTotal: 1_000, spawnCount: 1 });
    const expansionRoom = makeColony({ roomName: 'W2N1', progress: 500, progressTotal: 1_000, spawnCount: 0 });
    installWorkers(['W1N1', 'W2N1']);

    expect(selectColonyUpgradeTarget([homeRoom, expansionRoom])).toBe(expansionRoom);
  });

  it('breaks equal priorities by stable room name ordering', () => {
    const west = makeColony({ roomName: 'W2N1', progress: 500, progressTotal: 1_000 });
    const east = makeColony({ roomName: 'W1N1', progress: 500, progressTotal: 1_000 });
    installWorkers(['W1N1', 'W2N1']);

    expect(selectColonyUpgradeTarget([west, east])).toBe(east);
  });
});

function makeColony({
  roomName,
  level = 3,
  progress = 100,
  progressTotal = 1_000,
  spawnCount = 1,
  ticksToDowngrade
}: {
  roomName: string;
  level?: number;
  progress?: number;
  progressTotal?: number;
  spawnCount?: number;
  ticksToDowngrade?: number;
}): ColonySnapshot {
  const room = {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      level,
      progress,
      progressTotal,
      ...(typeof ticksToDowngrade === 'number' ? { ticksToDowngrade } : {})
    } as StructureController
  } as Room;
  const spawns = Array.from(
    { length: spawnCount },
    (_, index) =>
      ({
        name: `Spawn${index}-${roomName}`,
        room,
        isActive: jest.fn(() => true)
      }) as unknown as StructureSpawn
  );

  return {
    room,
    spawns,
    energyAvailable: 650,
    energyCapacityAvailable: 650
  };
}

function installWorkers(roomNames: string[]): void {
  const creeps = Object.fromEntries(
    roomNames.map((roomName, index) => [
      `Worker${index}-${roomName}`,
      {
        ticksToLive: 1_000,
        memory: { role: 'worker', colony: roomName }
      } as Creep
    ])
  );
  (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps };
}
