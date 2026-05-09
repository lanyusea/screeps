export interface WorkerBodyScalingProfile {
  minimumEnergyCapacity: number;
  minimumControllerLevel?: number;
  body: readonly BodyPartConstant[];
}

export interface WorkerBodyScalingOptions {
  currentWorkerCount?: number;
  controllerLevel?: number;
  energyAvailable?: number;
  emergency?: boolean;
}

export const WORKER_BODY_SCALING_EMERGENCY_ENERGY_THRESHOLD = 300;
export const WORKER_BODY_SCALING_FULL_THROUGHPUT_WORKER_COUNT = 3;

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
    minimumControllerLevel: 1,
    body: ['work', 'work', 'carry', 'move']
  },
  {
    minimumEnergyCapacity: 550,
    minimumControllerLevel: 2,
    body: ['work', 'work', 'carry', 'carry', 'move', 'move']
  },
  {
    minimumEnergyCapacity: 800,
    minimumControllerLevel: 3,
    body: ['work', 'work', 'work', 'carry', 'carry', 'move', 'move', 'move']
  }
];

const WORKER_BODY_SCALING_BOOTSTRAP_CAPS: readonly {
  maxCurrentWorkerCount: number;
  maximumEnergyCapacity: number;
}[] = [
  { maxCurrentWorkerCount: 0, maximumEnergyCapacity: 200 },
  { maxCurrentWorkerCount: 1, maximumEnergyCapacity: 300 },
  { maxCurrentWorkerCount: 2, maximumEnergyCapacity: 550 }
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
  const roomEnergyCapacity = getEffectiveWorkerBodyEnergyCapacity(
    normalizeEnergyAmount(energyCapacityAvailable),
    options
  );
  const availableEnergy = normalizeOptionalEnergyAmount(options.energyAvailable);
  const controllerLevel = normalizeOptionalEnergyAmount(options.controllerLevel);

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
    .filter(
      (candidate) =>
        normalizeEnergyAmount(candidate.minimumEnergyCapacity) <= roomEnergyCapacity &&
        satisfiesControllerLevel(candidate, controllerLevel)
    )
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

function getEffectiveWorkerBodyEnergyCapacity(
  roomEnergyCapacity: number,
  options: WorkerBodyScalingOptions
): number {
  const currentWorkerCount = normalizeOptionalEnergyAmount(options.currentWorkerCount);
  if (currentWorkerCount === undefined) {
    return roomEnergyCapacity;
  }

  const bootstrapCap = WORKER_BODY_SCALING_BOOTSTRAP_CAPS.find(
    (cap) => currentWorkerCount <= cap.maxCurrentWorkerCount
  );
  return bootstrapCap
    ? Math.min(roomEnergyCapacity, bootstrapCap.maximumEnergyCapacity)
    : roomEnergyCapacity;
}

function satisfiesControllerLevel(
  profile: WorkerBodyScalingProfile,
  controllerLevel: number | undefined
): boolean {
  return (
    controllerLevel === undefined ||
    profile.minimumControllerLevel === undefined ||
    controllerLevel >= profile.minimumControllerLevel
  );
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
