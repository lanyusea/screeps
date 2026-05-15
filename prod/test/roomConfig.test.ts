import {
  ACTIVE_OFFICIAL_ROOM,
  CORRIDOR_EXPORTER_PRIORITY_PAIRS,
  ECONOMY_CORRIDOR_ROOMS,
  LOCAL_FIRST_ENERGY_ROOMS,
  LOCAL_FIRST_SOURCE_ROOMS,
  OFFICIAL_ROOM_CANDIDATES,
  OFFICIAL_SHARD,
  SAFE_TRANSIT_ALLOWLIST,
  STATIC_EXPANSION_SCOUT_TARGETS,
  STRATEGY_SUPPORTED_ROOMS,
  STRATEGY_SUPPORTED_SHARDS
} from '../src/config/roomConfig';
import {
  DEFAULT_E18S59_LOCAL_FIRST_ENERGY_ROOM,
  DEFAULT_LOCAL_FIRST_ENERGY_ROOM,
  DEFAULT_LOCAL_FIRST_ENERGY_ROOMS,
  DEFAULT_LOCAL_FIRST_SOURCE_ROOM
} from '../src/economy/localEnergyStrategy';
import { MULTI_ROOM_ENERGY_CORRIDOR_ROOMS } from '../src/economy/multiRoomEnergy';
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
  it('captures the current official room and historical candidates in one place', () => {
    expect(OFFICIAL_SHARD).toBe('shardX');
    expect(ACTIVE_OFFICIAL_ROOM).toBe('W3N9');
    expect(OFFICIAL_ROOM_CANDIDATES).toEqual(['E17S59', 'E26S49', 'E19S57', 'W3N9']);
    expect(STRATEGY_SUPPORTED_SHARDS).toEqual([OFFICIAL_SHARD]);
    expect(STRATEGY_SUPPORTED_ROOMS).toEqual([ACTIVE_OFFICIAL_ROOM]);
  });

  it('keeps business exports wired to the central room config', () => {
    expect(MULTI_ROOM_ENERGY_CORRIDOR_ROOMS).toEqual(ECONOMY_CORRIDOR_ROOMS);
    expect(DEFAULT_LOCAL_FIRST_ENERGY_ROOM).toBe(LOCAL_FIRST_ENERGY_ROOMS[0]);
    expect(DEFAULT_E18S59_LOCAL_FIRST_ENERGY_ROOM).toBe(LOCAL_FIRST_ENERGY_ROOMS[1]);
    expect(DEFAULT_LOCAL_FIRST_SOURCE_ROOM).toBe(LOCAL_FIRST_SOURCE_ROOMS[0]);
    expect(DEFAULT_LOCAL_FIRST_ENERGY_ROOMS).toEqual(LOCAL_FIRST_ENERGY_ROOMS);
    expect([...safeTransitAllowlist]).toEqual([...SAFE_TRANSIT_ALLOWLIST]);
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual(STATIC_EXPANSION_SCOUT_TARGETS);
    expect(CORRIDOR_EXPORTER_PRIORITY_PAIRS.length).toBeGreaterThan(0);
  });

  it('keeps protected room literals out of production business modules', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const allowedConfigPath = normalizePath(path.join(sourceRoot, 'config', 'roomConfig.ts'));
    const protectedLiterals = getProtectedRoomConfigLiterals();
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(sourceRoot)) {
      if (normalizePath(filePath) === allowedConfigPath) {
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
  const values = new Set<string>([
    OFFICIAL_SHARD,
    ACTIVE_OFFICIAL_ROOM,
    ...OFFICIAL_ROOM_CANDIDATES,
    ...STRATEGY_SUPPORTED_SHARDS,
    ...STRATEGY_SUPPORTED_ROOMS,
    ...ECONOMY_CORRIDOR_ROOMS,
    ...LOCAL_FIRST_ENERGY_ROOMS,
    ...LOCAL_FIRST_SOURCE_ROOMS,
    ...SAFE_TRANSIT_ALLOWLIST
  ]);

  for (const pair of CORRIDOR_EXPORTER_PRIORITY_PAIRS) {
    values.add(pair.sourceRoom);
    values.add(pair.targetRoom);
  }

  for (const target of STATIC_EXPANSION_SCOUT_TARGETS) {
    values.add(target.colony);
    values.add(target.roomName);
    values.add(target.nearestOwnedRoom);
  }

  return values;
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

function normalizePath(filePath: string): string {
  return filePath.split('\\').join('/');
}
