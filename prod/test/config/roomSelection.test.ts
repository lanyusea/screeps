import {
  ACTIVE_OFFICIAL_ROOM_SELECTION,
  LOGISTICS_ROOM_SELECTION,
  OFFICIAL_ROOM_CANDIDATES,
  PRODUCTION_ROOM_SELECTION_LITERAL_NAMES,
  TERRITORY_EXPANSION_ROOM_SELECTION
} from '../../src/config/roomSelection';

declare function require(moduleName: string): unknown;
declare const __dirname: string;

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
  resolve(...parts: string[]): string;
  sep: string;
};

describe('room selection config', () => {
  it('records the active official target and prior room candidates in one config surface', () => {
    expect(ACTIVE_OFFICIAL_ROOM_SELECTION).toEqual({
      branch: 'main',
      shard: 'shardX',
      roomName: 'E29N55',
      spawn: { name: 'Spawn1', x: 17, y: 24 }
    });
    expect(OFFICIAL_ROOM_CANDIDATES[0]).toMatchObject({
      shard: 'shardX',
      roomName: 'E29N55',
      status: 'active',
      spawn: { name: 'Spawn1', x: 17, y: 24 }
    });
    expect(OFFICIAL_ROOM_CANDIDATES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shard: 'shardX',
          roomName: 'W3N9',
          status: 'fallback',
          spawn: { name: 'Spawn1', x: 35, y: 23 }
        })
      ])
    );
  });

  it('centralizes logistics corridors and static expansion targets', () => {
    expect(LOGISTICS_ROOM_SELECTION).toMatchObject({
      corridorRooms: ['E17S58', 'E17S59', 'E18S59'],
      safeTransitRooms: ['E17S59'],
      localFirstEnergyRooms: ['E17S58', 'E18S59'],
      localFirstSourceRoom: 'E17S59',
      prioritizedExportRoutes: [{ sourceRoom: 'E17S59', targetRoom: 'E18S59' }]
    });
    expect(TERRITORY_EXPANSION_ROOM_SELECTION.scoutTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony: ACTIVE_OFFICIAL_ROOM_SELECTION.roomName,
          nearestOwnedRoom: ACTIVE_OFFICIAL_ROOM_SELECTION.roomName,
          scoutOnly: true
        })
      ])
    );
  });

  it('keeps configured production room literals out of business modules', () => {
    const sourceRoot = path.resolve(__dirname, '../../src');
    const configFile = path.join(sourceRoot, 'config', 'roomSelection.ts');
    const offenders: string[] = [];

    for (const filePath of collectTypeScriptFiles(sourceRoot)) {
      if (filePath === configFile) {
        continue;
      }

      const text = fs.readFileSync(filePath, 'utf8');
      for (const roomLiteral of PRODUCTION_ROOM_SELECTION_LITERAL_NAMES) {
        if (hasQuotedLiteral(text, roomLiteral)) {
          offenders.push(`${path.relative(sourceRoot, filePath)} contains ${roomLiteral}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasQuotedLiteral(text: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(['"\`])${escaped}\\1`).test(text);
}
