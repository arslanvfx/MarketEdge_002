/**
 * Small promise queue for writes that must reach persistent storage in the
 * same order they were requested. A rejected job never poisons later jobs.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}