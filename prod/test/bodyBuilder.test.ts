import { buildWorkerBody } from '../src/spawn/bodyBuilder';

describe('buildWorkerBody', () => {
  it('builds the smallest worker body at 200 energy', () => {
    expect(buildWorkerBody(200)).toEqual(['work', 'carry', 'move']);
  });

  it('scales worker bodies by repeating work/carry/move sets', () => {
    expect(buildWorkerBody(400)).toEqual(['work', 'carry', 'move', 'work', 'carry', 'move']);
  });

  it('caps worker body size at 50 parts', () => {
    expect(buildWorkerBody(10000)).toHaveLength(48);
  });

  it('returns an empty body when there is not enough energy for a worker set', () => {
    expect(buildWorkerBody(199)).toEqual([]);
  });
});
