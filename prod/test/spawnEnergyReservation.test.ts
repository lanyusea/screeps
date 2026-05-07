import { reserveSpawnEnergyForNextRequest } from '../src/economy/spawnEnergyReservation';

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
});
