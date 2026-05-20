import { isAutonomousTerritoryControlAllowedForColonyName } from '../src/territory/controlGate';

describe('autonomous territory control gate', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('fails closed when colony room visibility or controller data is missing', () => {
    expect(isAutonomousTerritoryControlAllowedForColonyName('W1N1')).toBe(false);

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: { name: 'W1N1' } as Room
      }
    };

    expect(isAutonomousTerritoryControlAllowedForColonyName('W1N1')).toBe(false);
  });

  it('allows only visible owned colonies at or above RCL5', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: {
          name: 'W1N1',
          controller: { my: true, level: 5 } as StructureController
        } as Room,
        W2N1: {
          name: 'W2N1',
          controller: { my: true, level: 4 } as StructureController
        } as Room,
        W3N1: {
          name: 'W3N1',
          controller: { my: false, level: 8 } as StructureController
        } as Room
      }
    };

    expect(isAutonomousTerritoryControlAllowedForColonyName('W1N1')).toBe(true);
    expect(isAutonomousTerritoryControlAllowedForColonyName('W2N1')).toBe(false);
    expect(isAutonomousTerritoryControlAllowedForColonyName('W3N1')).toBe(false);
  });
});
