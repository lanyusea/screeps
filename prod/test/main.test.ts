import { loop } from '../src/main';

describe('main loop entrypoint', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Memory }).Memory = {} as Memory;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
  });

  it('exports a callable Screeps loop', () => {
    expect(typeof loop).toBe('function');
  });

  it('runs the kernel without throwing', () => {
    expect(() => loop()).not.toThrow();
    expect(Memory.meta.version).toBe(1);
  });
});
