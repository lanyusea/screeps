import { cleanupDeadCreepMemory, initializeMemory } from '../memory/schema';
import { runEconomy } from '../economy/economyLoop';

export interface KernelDependencies {
  initializeMemory: () => void;
  cleanupDeadCreepMemory: () => void;
  runEconomy: () => void;
}

export class Kernel {
  public constructor(
    private readonly dependencies: KernelDependencies = {
      initializeMemory,
      cleanupDeadCreepMemory,
      runEconomy
    }
  ) {}

  public run(): void {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
    this.dependencies.runEconomy();
  }
}
