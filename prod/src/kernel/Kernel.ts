import { cleanupDeadCreepMemory, initializeMemory } from '../memory/schema';

export interface KernelDependencies {
  initializeMemory: () => void;
  cleanupDeadCreepMemory: () => void;
}

export class Kernel {
  public constructor(
    private readonly dependencies: KernelDependencies = {
      initializeMemory,
      cleanupDeadCreepMemory
    }
  ) {}

  public run(): void {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
  }
}
