export interface WorkerBodyScalingProfile {
  minimumEnergyCapacity: number;
  body: readonly BodyPartConstant[];
}

export interface WorkerBodyScalingOptions {
  energyAvailable?: number;
  emergency?: boolean;
}

export const WORKER_BODY_SCALING_EMERGENCY_ENERGY_THRESHOLD = 300;

export const WORKER_BODY_SCALING_EMERGENCY_FALLBACK: readonly BodyPartConstant[] = [
  'work',
  'carry',
  'move'
];

export const WORKER_BODY_SCALING_PROFILES: readonly WorkerBodyScalingProfile[] = [
  {
    minimumEnergyCapacity: 0,
    body: ['work', 'carry', 'move']
  },
  {
    minimumEnergyCapacity: 300,
    body: ['work', 'work', 'carry', 'move']
  },
  {
    minimumEnergyCapacity: 550,
    body: ['work', 'work', 'carry', 'carry', 'move', 'move']
  },
  {
    minimumEnergyCapacity: 800,
    body: ['work', 'work', 'work', 'carry', 'carry', 'move', 'move', 'move']
  }
];

const BODY_PART_COSTS: Record<BodyPartConstant, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

export function buildScaledWorkerBody(
  energyCapacityAvailable: number,
  options: WorkerBodyScalingOptions = {}
): BodyPartConstant[] {
  const roomEnergyCapacity = normalizeEnergyAmount(energyCapacityAvailable);
  const availableEnergy = normalizeOptionalEnergyAmount(options.energyAvailable);

  if (
    options.emergency === true &&
    availableEnergy !== undefined &&
    availableEnergy < WORKER_BODY_SCALING_EMERGENCY_ENERGY_THRESHOLD
  ) {
    return canAffordBody(WORKER_BODY_SCALING_EMERGENCY_FALLBACK, availableEnergy)
      ? [...WORKER_BODY_SCALING_EMERGENCY_FALLBACK]
      : [];
  }

  const profile = [...WORKER_BODY_SCALING_PROFILES]
    .filter((candidate) => normalizeEnergyAmount(candidate.minimumEnergyCapacity) <= roomEnergyCapacity)
    .sort((left, right) => right.minimumEnergyCapacity - left.minimumEnergyCapacity)
    .find((candidate) => availableEnergy === undefined || canAffordBody(candidate.body, availableEnergy));

  return profile ? [...profile.body] : [];
}

export function getScaledWorkerBodyCost(body: readonly BodyPartConstant[]): number {
  return body.reduce((total, part) => total + BODY_PART_COSTS[part], 0);
}

function canAffordBody(body: readonly BodyPartConstant[], energyAvailable: number): boolean {
  return getScaledWorkerBodyCost(body) <= energyAvailable;
}

function normalizeOptionalEnergyAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return normalizeEnergyAmount(value);
}

function normalizeEnergyAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
