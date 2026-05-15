import {
  OFFICIAL_ROOM_CANDIDATES,
  OFFICIAL_SHARD,
  STRATEGIC_FOCUS_ROOM,
  STRATEGIC_ROOM_AUDIT_LITERALS,
  STRATEGY_SUPPORTED_ROOMS,
  STRATEGY_SUPPORTED_SHARDS
} from '../src/config/roomConfig';
import {
  getRuntimeCurrentRoomName,
  getRuntimeOwnedRoomNames
} from '../src/config/runtimeRooms';
import {
  DEFAULT_E18S59_LOCAL_FIRST_ENERGY_ROOM,
  DEFAULT_LOCAL_FIRST_ENERGY_ROOM,
  DEFAULT_LOCAL_FIRST_ENERGY_ROOMS,
  DEFAULT_LOCAL_FIRST_SOURCE_ROOM
} from '../src/economy/localEnergyStrategy';
import { MULTI_ROOM_ENERGY_CORRIDOR_ROOMS, getMultiRoomEnergyCorridorRooms } from '../src/economy/multiRoomEnergy';
import { safeTransitAllowlist } from '../src/economy/roomLogistics';
import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../src/territory/expansionConfig';

declare const process: { cwd(): string };
declare const require: (moduleName: string) => unknown;

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const fs = require('fs') as {
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
  readFileSync(path: string, encoding: 'utf8'): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};
const ts = require('typescript') as typeof import('typescript');

describe('room config', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('captures strategic official room state in one place', () => {
    expect(OFFICIAL_SHARD).toBe('shardX');
    expect(STRATEGIC_FOCUS_ROOM).toBe('W3N9');
    expect(OFFICIAL_ROOM_CANDIDATES).toEqual(['E17S59', 'E26S49', 'E19S57', 'W3N9']);
    expect(STRATEGY_SUPPORTED_SHARDS).toEqual([OFFICIAL_SHARD]);
    expect(STRATEGY_SUPPORTED_ROOMS).toEqual([STRATEGIC_FOCUS_ROOM]);
  });

  it('keeps tactical defaults runtime- or Memory-configured instead of strategic-room driven', () => {
    expect(MULTI_ROOM_ENERGY_CORRIDOR_ROOMS).toEqual([]);
    expect(DEFAULT_LOCAL_FIRST_ENERGY_ROOM).toBeUndefined();
    expect(DEFAULT_E18S59_LOCAL_FIRST_ENERGY_ROOM).toBeUndefined();
    expect(DEFAULT_LOCAL_FIRST_SOURCE_ROOM).toBeUndefined();
    expect(DEFAULT_LOCAL_FIRST_ENERGY_ROOMS).toEqual([]);
    expect([...safeTransitAllowlist]).toEqual([]);
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual([]);
  });

  it('discovers runtime owned and current rooms from live owned spawns', () => {
    const spawnRoom = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {},
      spawns: {
        Spawn1: makeSpawn('Spawn1', spawnRoom)
      }
    };

    expect(getRuntimeOwnedRoomNames()).toEqual(['W8N3']);
    expect(getRuntimeCurrentRoomName()).toBe('W8N3');
  });

  it('discovers visible owned rooms and sorts them deterministically', () => {
    const spawnRoom = makeOwnedRoom('W8N3');
    const visibleRoom = makeOwnedRoom('W1N1');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: spawnRoom,
        W1N1: visibleRoom
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', spawnRoom)
      }
    };

    expect(getRuntimeOwnedRoomNames()).toEqual(['W1N1', 'W8N3']);
    expect(getRuntimeCurrentRoomName()).toBe('W1N1');
    expect(getMultiRoomEnergyCorridorRooms()).toEqual(['W1N1', 'W8N3']);
  });

  it('allows explicit Memory runtime room config to override live current room selection', () => {
    const spawnRoom = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: spawnRoom
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', spawnRoom)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'W5N5',
        ownedRoomNames: ['W5N5']
      }
    };

    expect(getRuntimeOwnedRoomNames()).toEqual(['W5N5', 'W8N3']);
    expect(getRuntimeCurrentRoomName()).toBe('W5N5');
  });

  it('keeps protected room literals out of production business modules', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const allowedPaths = new Set(
      [
        path.join(sourceRoot, 'config', 'roomConfig.ts'),
        path.join(sourceRoot, 'config', 'runtimeRooms.ts'),
        path.join(sourceRoot, 'territory', 'expansionConfig.ts')
      ].map(normalizePath)
    );
    const protectedLiterals = getProtectedRoomConfigLiterals();
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(sourceRoot)) {
      if (allowedPaths.has(normalizePath(filePath))) {
        continue;
      }

      const relativePath = normalizePath(path.relative(sourceRoot, filePath));
      const sourceText = fs.readFileSync(filePath, 'utf8');
      const literals = collectStringLiteralValues(filePath, sourceText);
      for (const literal of literals) {
        if (protectedLiterals.has(literal)) {
          violations.push(`${relativePath}: ${literal}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function getProtectedRoomConfigLiterals(): Set<string> {
  return new Set<string>([
    OFFICIAL_SHARD,
    ...OFFICIAL_ROOM_CANDIDATES,
    ...STRATEGY_SUPPORTED_SHARDS,
    ...STRATEGY_SUPPORTED_ROOMS,
    ...STRATEGIC_ROOM_AUDIT_LITERALS
  ]);
}

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function collectStringLiteralValues(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: string[] = [];

  function visit(node: import('typescript').Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: { my: true }
  } as Room;
}

function makeSpawn(name: string, room: Room): StructureSpawn {
  return {
    name,
    my: true,
    room
  } as StructureSpawn;
}

function normalizePath(filePath: string): string {
  return filePath.split('\\').join('/');
}
