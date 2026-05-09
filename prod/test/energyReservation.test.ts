import { getEnergyReservationScore } from '../src/economy/energyReservation';

describe('energyReservation', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      RESOURCE_ENERGY: 'energy'
    });
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  });

  it('counts loaded cross-room haulers as pending spawn reservation refill energy', () => {
    const room = makeRoom('W2N1', 300, 800);
    installGame(room, {
      CrossRoomHauler1: makeCrossRoomHauler('W1N1', 'W2N1', 250, 'delivering')
    });
    installSpawnReservation('W2N1', 650);

    expect(getEnergyReservationScore(room)).toMatchObject({
      pendingHaulerDeliveryEnergy: 250,
      reservedSpawnEnergy: 650,
      reservedSpawnRefillEnergy: 250,
      reservationScore: 550,
      unmetSpawnEnergyReservation: 350
    });
  });

  it('ignores cross-room haulers returning home with undelivered energy', () => {
    const room = makeRoom('W2N1', 300, 800);
    installGame(room, {
      CrossRoomHauler1: makeCrossRoomHauler('W1N1', 'W2N1', 250, 'returning')
    });
    installSpawnReservation('W2N1', 650);

    expect(getEnergyReservationScore(room)).toMatchObject({
      pendingHaulerDeliveryEnergy: 0,
      reservedSpawnRefillEnergy: 0,
      reservationScore: 300,
      unmetSpawnEnergyReservation: 350
    });
  });
});

function makeRoom(
  roomName: string,
  energyAvailable: number,
  energyCapacityAvailable: number
): Room {
  return {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable
  } as Room;
}

function makeCrossRoomHauler(
  homeRoom: string,
  targetRoom: string,
  energy: number,
  state: CreepCrossRoomHaulerMemory['state']
): Creep {
  return {
    memory: {
      role: 'crossRoomHauler',
      colony: homeRoom,
      crossRoomHauler: {
        homeRoom,
        targetRoom,
        sourceId: `${homeRoom}-storage` as Id<AnyStoreStructure>,
        state
      }
    },
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
    }
  } as unknown as Creep;
}

function installGame(room: Room, creeps: Record<string, Creep>): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    rooms: { [room.name]: room },
    creeps
  };
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
}

function installSpawnReservation(roomName: string, reservedEnergy: number): void {
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
    economy: {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          [roomName]: {
            bodyCost: reservedEnergy,
            creepName: `worker-${roomName}-100`,
            reservedAt: 99,
            reservedEnergy,
            role: 'worker',
            roomName,
            updatedAt: 99
          }
        }
      }
    }
  };
}
