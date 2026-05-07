export const SUBSTANTIAL_CONTAINER_FILL_RATIO = 0.5;
export const CONTAINER_OVERFLOW_RISK_FILL_RATIO = 0.8;
export const NEAR_EMPTY_CONTAINER_RESERVATION_FILL_RATIO = 0.1;

export function getStoreEnergyCapacity(target: unknown): number | null {
  const store = (target as { store?: StoreDefinition } | null)?.store;
  if (!store) {
    return null;
  }

  const resource = getEnergyResource();
  const resourceCapacity = readCapacity(() => store.getCapacity?.(resource));
  if (resourceCapacity !== null) {
    return resourceCapacity;
  }

  const totalCapacity = readCapacity(() => store.getCapacity?.());
  if (totalCapacity !== null) {
    return totalCapacity;
  }

  const usedEnergy = getStoredEnergy(target);
  const freeEnergy = readCapacity(() => store.getFreeCapacity?.(resource));
  return freeEnergy === null ? null : usedEnergy + freeEnergy;
}

export function getContainerEnergyFillRatio(container: StructureContainer, energy = getStoredEnergy(container)): number | null {
  const capacity = getStoreEnergyCapacity(container);
  if (capacity === null || capacity <= 0) {
    return null;
  }

  return Math.max(0, Math.min(1, energy / capacity));
}

export function hasSubstantialContainerEnergy(container: StructureContainer, energy = getStoredEnergy(container)): boolean {
  const fillRatio = getContainerEnergyFillRatio(container, energy);
  return fillRatio !== null && fillRatio > SUBSTANTIAL_CONTAINER_FILL_RATIO;
}

export function isContainerOverflowRisk(container: StructureContainer, energy = getStoredEnergy(container)): boolean {
  const fillRatio = getContainerEnergyFillRatio(container, energy);
  return fillRatio !== null && fillRatio > CONTAINER_OVERFLOW_RISK_FILL_RATIO;
}

export function getReservableContainerEnergy(
  container: StructureContainer,
  energy = getStoredEnergy(container),
  reservedEnergy = 0
): number {
  const projectedEnergy = Math.max(0, energy - Math.max(0, reservedEnergy));
  const capacity = getStoreEnergyCapacity(container);
  if (capacity === null || capacity <= 0) {
    return projectedEnergy;
  }

  const fillRatio = Math.max(0, Math.min(1, energy / capacity));
  if (fillRatio <= NEAR_EMPTY_CONTAINER_RESERVATION_FILL_RATIO) {
    return 0;
  }

  if (fillRatio > CONTAINER_OVERFLOW_RISK_FILL_RATIO) {
    const overflowEnergy = Math.max(0, energy - capacity * CONTAINER_OVERFLOW_RISK_FILL_RATIO - Math.max(0, reservedEnergy));
    return Math.min(projectedEnergy, Math.floor(overflowEnergy));
  }

  return projectedEnergy;
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: StoreDefinition } | null)?.store;
  const usedCapacity = store?.getUsedCapacity?.(getEnergyResource());
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedEnergy = (store as Partial<Record<ResourceConstant, number>> | undefined)?.[getEnergyResource()];
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function readCapacity(read: () => number | null | undefined): number | null {
  const value = read();
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
}
