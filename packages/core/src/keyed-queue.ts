/**
 * Serialize công việc theo key (vd sessionId): cùng key chạy tuần tự,
 * khác key chạy song song. Queue của key rỗng thì xóa entry — không leak.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }

  /** Số key đang có việc chạy/chờ — phục vụ test & giám sát. */
  size(): number {
    return this.tails.size;
  }
}
