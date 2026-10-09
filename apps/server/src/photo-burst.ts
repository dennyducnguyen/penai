/** Zalo photo acknowledgements are scoped to one channel, conversation and sender. */
export class PhotoBurst {
  private last = new Map<string, number>();
  acknowledge(key: string, now = Date.now()): boolean {
    const previous = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, now);
    if (this.last.size > 2000) this.last.delete(this.last.keys().next().value!);
    return previous === undefined || now - previous >= 30_000;
  }
  reset(key: string): void { this.last.delete(key); }
}

export function readPhotoAcknowledgement(config: Record<string, unknown>): "short" | "off" {
  return config["photo_ack"] === "off" ? "off" : "short";
}
