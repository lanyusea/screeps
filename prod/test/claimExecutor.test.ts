import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../src/telemetry/runtimeSummary';
import {
  refreshAutonomousExpansionClaimIntent,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../src/territory/claimExecutor';
import type {
  OccupationRecommendationReport,
  OccupationRecommendationScore
} from '../src/territory/occupationRecommendation';

describe('autonomous expansion claim executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { rooms: {} };
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('records a claim intent for the top scored claimable adjacent room', () => {
    const colony = makeColony();
    const targetRoom = makeTargetRoom('W2N1', { controllerId: 'controller2' as Id<StructureController> });
    (Game.rooms as Record<string, Room>).W2N1 = targetRoom;
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(
      colony,
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      100,
      events
    );

    expect(evaluation).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      score: 1_200
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        controllerId: 'controller2'
      }
    ]);
    expect(events).toEqual([
      {
        type: 'territoryClaim',
        roomName: 'W1N1',
        colony: 'W1N1',
        phase: 'intent',
        targetRoom: 'W2N1',
        controllerId: 'controller2',
        score: 1_200
      }
    ]);
  });

  it('does not record a claim when no adjacent scoring candidate exists', () => {
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(makeColony(), makeReport([]), 101, events);

    expect(evaluation).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'noAdjacentCandidate'
    });
    expect(Memory.territory).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('keeps an existing autonomous claim target when scoring reports it as configured', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          source: 'configured',
          action: 'occupy'
        })
      ]),
      104
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 104,
        controllerId: 'controller2'
      }
    ]);
  });

  it('does not record a claim when home energy capacity cannot build a claimer', () => {
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony({ energyCapacityAvailable: 600 }),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      102,
      events
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'energyCapacityLow'
    });
    expect(Memory.territory).toBeUndefined();
    expect(events).toContainEqual({
      type: 'territoryClaim',
      roomName: 'W1N1',
      colony: 'W1N1',
      phase: 'skip',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'energyCapacityLow',
      score: 1_200
    });
  });

  it('defers the reserve fallback while the target controller is on cooldown', () => {
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>,
      upgradeBlocked: 25
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      103
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'controllerCooldown'
    });
    expect(shouldDeferOccupationRecommendationForExpansionClaim(evaluation)).toBe(true);
    expect(Memory.territory).toBeUndefined();
  });

  it('marks and emits a gclInsufficient skip when expansion capacity is exceeded', () => {
    const colony = makeColony();
    (Game.rooms as Record<string, Room>) = {
      W1N1: colony.room,
      W2N1: makeTargetRoom('W2N1', {
        controllerId: 'controller2' as Id<StructureController>
      })
    };
    (Game as { gcl: { level: number } }).gcl = { level: 1 };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      colony,
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      104
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'gclInsufficient'
    });
    expect(shouldDeferOccupationRecommendationForExpansionClaim(evaluation)).toBe(false);
    expect(Memory.territory).toBeUndefined();
  });
});

function makeColony({
  energyAvailable = 650,
  energyCapacityAvailable = 650
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 }
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable,
    energyCapacityAvailable
  };
}

function makeReport(candidates: OccupationRecommendationScore[]): OccupationRecommendationReport {
  return {
    candidates,
    next: candidates[0] ?? null,
    followUpIntent: null
  };
}

function makeCandidate({
  roomName,
  controllerId,
  source = 'adjacent',
  action = 'reserve'
}: {
  roomName: string;
  controllerId?: Id<StructureController>;
  source?: OccupationRecommendationScore['source'];
  action?: OccupationRecommendationScore['action'];
}): OccupationRecommendationScore {
  return {
    roomName,
    action,
    score: 1_200,
    evidenceStatus: 'sufficient',
    source,
    evidence: ['room visible', 'controller is available', '1 sources visible'],
    preconditions: [],
    risks: [],
    routeDistance: 1,
    roadDistance: 1,
    sourceCount: 1,
    ...(controllerId ? { controllerId } : {})
  };
}

function makeTargetRoom(
  roomName: string,
  {
    controllerId,
    upgradeBlocked = 0,
    hostileCreeps = [],
    hostileStructures = []
  }: {
    controllerId: Id<StructureController>;
    upgradeBlocked?: number;
    hostileCreeps?: Creep[];
    hostileStructures?: AnyStructure[];
  }
): Room {
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      ...(upgradeBlocked > 0 ? { upgradeBlocked } : {})
    } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      return [];
    })
  } as unknown as Room;
}
