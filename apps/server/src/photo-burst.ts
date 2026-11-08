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

/**
 * Khách chỉ gửi ảnh (chưa nhắn yêu cầu): "short" = xác nhận ngắn ở ảnh đầu, "off" = im lặng chỉ lưu,
 * "ai" = AI trả lời luôn (mặc định của Fanpage/Instagram — khách hay gửi ảnh sản phẩm để hỏi).
 */
export function readPhotoAcknowledgement(config: Record<string, unknown>, kind = ""): "short" | "off" | "ai" {
  const v = config["photo_ack"];
  if (v === "off" || v === "short" || v === "ai") return v;
  return kind === "facebook" || kind === "instagram" ? "ai" : "short";
}
