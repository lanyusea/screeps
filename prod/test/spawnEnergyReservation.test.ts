import {
  getReservedSpawnEnergy,
  getSpawnEnergyReservationTransferThreshold,
  selectSpawnEnergyReservationRefillTarget,
  reserveSpawnEnergyForNextRequest
} from '../src/economy/spawnEnergyReservation';

describe('spawnEnergyReservation', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_SPAWN: 'spawn'
    });
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
        reservedAt: expect.any(Number),
        reservedEnergy: 300,
        role: 'worker',
        roomName: 'W1N1',
        updatedAt: expect.any(Number)
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

  it('selects a nearby spawn refill target while the queued body reservation is unmet', () => {
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      structureType: 'spawn',
      store: {
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 51 : 0)),
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 249 : 0))
      }
    } as unknown as StructureSpawn;
    const room = {
      name: 'W1N1',
      energyAvailable: 400,
      memory: { spawnEnergyReservation: { transferThreshold: 250 } },
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type !== FIND_MY_STRUCTURES) {
          return [];
        }

        const structures = [spawn as unknown as AnyOwnedStructure];
        return options?.filter ? structures.filter(options.filter) : structures;
      })
    } as unknown as Room;
    const creep = {
      room,
      store: { getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)) },
      pos: { getRangeTo: jest.fn().mockReturnValue(2) }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: room },
      time: 100
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 99,
          rooms: {
            W1N1: {
              bodyCost: 650,
              creepName: 'worker-W1N1-101',
              reservedAt: 99,
              reservedEnergy: 650,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 99
            }
          }
        }
      }
    };

    expect(getSpawnEnergyReservationTransferThreshold(room)).toBe(250);
    expect(selectSpawnEnergyReservationRefillTarget(creep)).toMatchObject({
      spawn,
      spawnEnergy: 249,
      threshold: 250,
      unmetReservedEnergy: 250
    });
  });
});
