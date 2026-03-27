import { createLogger } from "./logger.ts";

const log = createLogger("task-queue");

export interface QueueTask<T = unknown> {
  id: string;
  label: string;
  execute: () => Promise<T>;
}

interface QueueEntry<T = unknown> {
  task: QueueTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * In-memory task queue with bounded concurrency.
 * Enqueue returns immediately; tasks run in background FIFO order.
 */
export class TaskQueue {
  private maxConcurrency: number;
  private running = 0;
  private queue: QueueEntry[] = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /** Number of tasks currently executing. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** True if the queue has capacity for another concurrent task. */
  get hasCapacity(): boolean {
    return this.running < this.maxConcurrency;
  }

  /**
   * Enqueue a task for background execution.
   * Returns a promise that resolves when the task completes,
   * but callers are free to ignore it (fire-and-forget).
   */
  enqueue<T>(task: QueueTask<T>): { promise: Promise<T>; position: number } {
    const position = this.queue.length + 1;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as QueueEntry);
    });

    log.info("Task enqueued", {
      id: task.id,
      label: task.label,
      position,
      active: this.running,
      pending: this.queue.length,
    });

    this.drain();
    return { promise, position };
  }

  private drain(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.running++;

      log.info("Task started", {
        id: entry.task.id,
        label: entry.task.label,
        active: this.running,
        pending: this.queue.length,
      });

      entry.task.execute().then(
        (result) => {
          this.running--;
          log.info("Task completed", {
            id: entry.task.id,
            label: entry.task.label,
            active: this.running,
            pending: this.queue.length,
          });
          entry.resolve(result);
          this.drain();
        },
        (err) => {
          this.running--;
          log.error("Task failed", {
            id: entry.task.id,
            label: entry.task.label,
            error: String(err),
            active: this.running,
            pending: this.queue.length,
          });
          entry.reject(err);
          this.drain();
        },
      );
    }
  }
}
