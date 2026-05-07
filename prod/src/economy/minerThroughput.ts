export interface RoomMinerThroughput {
  energyPerTick: number;
  regenEnergyPerTick: number;
  saturatedSourceCount: number;
  sourceCount: number;
}

export const MINER_THROUGHPUT_SOURCE_SATURATION_RATIO = 0.8;
export const MINER_THROUGHPUT_SOURCE_WORKLOAD_MAX_AGE = 25;

export function getRoomMinerThroughput(room: Room): RoomMinerThroughput {
  const workload = getFreshRoomSourceWorkload(getRoomName(room));
  if (!workload) {
    return createEmptyRoomMinerThroughput();
  }

  const records = Object.values(workload.sources ?? {}).filter(isUsableSourceWorkloadRecord);
  if (records.length === 0) {
    return createEmptyRoomMinerThroughput();
  }

  return records.reduce<RoomMinerThroughput>(
    (total, record) => {
      const regenEnergyPerTick = normalizePositiveNumber(record.regenEnergyPerTick);
      const harvestEnergyPerTick = normalizeNonNegativeNumber(record.harvestEnergyPerTick);
      const effectiveEnergyPerTick = Math.min(harvestEnergyPerTick, regenEnergyPerTick);

      return {
        energyPerTick: total.energyPerTick + effectiveEnergyPerTick,
        regenEnergyPerTick: total.regenEnergyPerTick + regenEnergyPerTick,
        saturatedSourceCount:
          total.saturatedSourceCount +
          (isSourceThroughputSaturated(effectiveEnergyPerTick, regenEnergyPerTick) ? 1 : 0),
        sourceCount: total.sourceCount + 1
      };
    },
    createEmptyRoomMinerThroughput()
  );
}

function getFreshRoomSourceWorkload(roomName: string): EconomyRoomSourceWorkloadMemory | null {
  const workload = (globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.sourceWorkloads?.[roomName];
  if (!isRoomSourceWorkloadMemory(workload)) {
    return null;
  }

  const gameTime = getGameTime();
  if (
    gameTime !== null &&
    (workload.updatedAt > gameTime ||
      gameTime - workload.updatedAt > MINER_THROUGHPUT_SOURCE_WORKLOAD_MAX_AGE)
  ) {
    return null;
  }

  return workload;
}

function isUsableSourceWorkloadRecord(record: EconomySourceWorkloadMemory): boolean {
  return (
    record.hasContainer === true &&
    normalizePositiveNumber(record.regenEnergyPerTick) > 0 &&
    normalizeNonNegativeNumber(record.harvestEnergyPerTick) > 0
  );
}

function isSourceThroughputSaturated(
  energyPerTick: number,
  regenEnergyPerTick: number
): boolean {
  return regenEnergyPerTick > 0 &&
    energyPerTick >= regenEnergyPerTick * MINER_THROUGHPUT_SOURCE_SATURATION_RATIO;
}

function isRoomSourceWorkloadMemory(value: unknown): value is EconomyRoomSourceWorkloadMemory {
  return (
    isRecord(value) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    isRecord(value.sources)
  );
}

function createEmptyRoomMinerThroughput(): RoomMinerThroughput {
  return {
    energyPerTick: 0,
    regenEnergyPerTick: 0,
    saturatedSourceCount: 0,
    sourceCount: 0
  };
}

function normalizePositiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getGameTime(): number | null {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function getRoomName(room: Room): string {
  return typeof room.name === 'string' ? room.name : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
