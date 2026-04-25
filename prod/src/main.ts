import { Kernel } from './kernel/Kernel';

const kernel = new Kernel();

export function loop(): void {
  kernel.run();
}
