import {
  getReservedSpawnEnergy,
  reserveSpawnEnergyForNextRequest
} from '../src/economy/spawnEnergyReservation';

describe('spawnEnergyReservation', () => {
  beforeEach(() => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 100 };
    (globalThis as unknown as { Memory: unknown }).Memory = {};
  });

  it.each([
    ['root Memory', 'corrupt-memory'],
    ['economy memory', { economy: 'corrupt-economy' }]
  ])('replaces non-object %s before writing reservations', (_label, memoryValue) => {
    (globalThis as unknown as { Memory: unknown }).Memory = memoryValue;

    expect(() =>
      reserveSpawnEnergyForNextRequest(
        {
          bodyCost: 300,
          creepName: 'worker-W1N1-100',
          role: 'worker',
          roomName: 'W1N1'
        },
        100
      )
    ).not.toThrow();
    expect((globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.spawnEnergyReservation?.rooms.W1N1)
      .toMatchObject({
        bodyCost: 300,
        creepName: 'worker-W1N1-100',
        reservedEnergy: 300,
        role: 'worker',
        roomName: 'W1N1'
      });
  });

  it.each(['reservedAt', 'updatedAt'] as const)(
    'ignores corrupt reservations missing %s',
    (missingTimestamp) => {
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        rooms: { W1N1: {} as Room },
        time: 100
      };
      (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
        economy: {
          spawnEnergyReservation: {
            updatedAt: 99,
            rooms: {
              W1N1: {
                bodyCost: 400,
                creepName: 'claimer-W1N1-W2N1-99',
                ...(missingTimestamp === 'reservedAt' ? {} : { reservedAt: 99 }),
                reservedEnergy: 400,
                role: 'claimer',
                roomName: 'W1N1',
                ...(missingTimestamp === 'updatedAt' ? {} : { updatedAt: 99 })
              } as EconomySpawnEnergyReservationRoomMemory
            }
          }
        }
      };

      expect(getReservedSpawnEnergy('W1N1')).toBe(0);
    }
  );
});
