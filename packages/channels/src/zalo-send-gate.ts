/** Serialize message requests, including concurrent photos inside zca-js albums. */
export class ZaloSendGate {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStarted = 0;
  constructor(private gapMs = 500) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.gapMs - (Date.now() - this.lastStarted);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastStarted = Date.now();
      return task();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async drain(): Promise<void> { await this.tail; }
}

export function isZaloSendRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const url = new URL(input instanceof Request ? input.url : String(input));
  return method.toUpperCase() === "POST" &&
    /^\/api\/(message|group)\/(photo_original\/(send|upload)|sms|sendmsg|mention|quote|gif|asyncfile\/msg)\/?$/.test(url.pathname);
}
