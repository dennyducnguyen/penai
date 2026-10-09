import { describe, expect, it } from "vitest";
import { PhotoBurst, readPhotoAcknowledgement } from "../src/photo-burst.js";

describe("Zalo photo bursts", () => {
  it("acknowledges the first photo, suppresses a sliding 30-second burst, and resets on text", () => {
    const bursts = new PhotoBurst();
    expect(bursts.acknowledge("ch:direct:1:sender", 0)).toBe(true);
    expect(bursts.acknowledge("ch:direct:1:sender", 20_000)).toBe(false);
    expect(bursts.acknowledge("ch:direct:1:sender", 40_000)).toBe(false);
    expect(bursts.acknowledge("ch:direct:1:sender", 70_000)).toBe(true);
    bursts.reset("ch:direct:1:sender");
    expect(bursts.acknowledge("ch:direct:1:sender", 70_001)).toBe(true);
  });
  it("isolates channel, conversation and sender and defaults to a short acknowledgement", () => {
    const bursts = new PhotoBurst();
    for (const key of ["a:1:x", "b:1:x", "a:2:x", "a:1:y"]) expect(bursts.acknowledge(key, 0)).toBe(true);
    expect(readPhotoAcknowledgement({})).toBe("short");
    expect(readPhotoAcknowledgement({ photo_ack: "off" })).toBe("off");
    expect(readPhotoAcknowledgement({ photo_ack: "invalid" })).toBe("short");
  });
});
