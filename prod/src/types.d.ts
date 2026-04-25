export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
  }

  interface CreepMemory {
    role?: string;
    task?: string;
  }
}
