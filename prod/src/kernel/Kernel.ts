import { cleanupDeadCreepMemory, initializeMemory } from '../memory/schema';
import { runDefense } from '../defense/defenseLoop';
import { runEconomy } from '../economy/economyLoop';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export interface KernelDependencies {
  initializeMemory: () => void;
  cleanupDeadCreepMemory: () => void;
  runDefense: () => RuntimeTelemetryEvent[];
  runEconomy: (telemetryEvents?: RuntimeTelemetryEvent[]) => void;
}

export class Kernel {
  public constructor(
    private readonly dependencies: KernelDependencies = {
      initializeMemory,
      cleanupDeadCreepMemory,
      runDefense,
      runEconomy
    }
  ) {}

  public run(): void {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
    const defenseEvents = this.dependencies.runDefense();
    this.dependencies.runEconomy(defenseEvents);
  }
}
