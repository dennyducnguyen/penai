import { describe, expect, it } from "vitest";
import { audioFormatOf, VOICE_UNSUPPORTED_NOTE, type InboundMedia } from "@penai/channels";
import { VOICE_ATTACHED_NOTE, mergeMediaText, voiceForModel } from "../src/channels-runtime.js";

const rtWith = (modalities: string[] | null) => ({
  providers: {
    get: () => ({ inputModalities: async () => modalities }),
  },
});

const voice = (): InboundMedia => ({
  kind: "voice",
  name: "voice.ogg",
  note: VOICE_UNSUPPORTED_NOTE,
  audio: { data: "T2dnUw==", format: "ogg" },
});

describe("audioFormatOf", () => {
  it("đổi mime/đuôi file sang định dạng input_audio", () => {
    expect(audioFormatOf("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioFormatOf("audio/mp4")).toBe("m4a");
    expect(audioFormatOf("audio/mpeg")).toBe("mp3");
    expect(audioFormatOf("", "tin.amr")).toBe("amr");
    expect(audioFormatOf(undefined, "x.opus")).toBe("ogg");
  });
});

describe("voiceForModel", () => {
  it("model nghe được → trả âm thanh và đổi ghi chú", async () => {
    const media = [voice()];
    const audio = await voiceForModel(rtWith(["text", "audio"]), "ws", "hoiai", "flash", media);
    expect(audio).toEqual([{ data: "T2dnUw==", format: "ogg" }]);
    expect(mergeMediaText("", media)).toContain(VOICE_ATTACHED_NOTE);
  });

  it("model không nghe được / provider không khai báo → giữ ghi chú cũ, không gửi âm thanh", async () => {
    for (const modalities of [["text", "image"], null]) {
      const media = [voice()];
      expect(await voiceForModel(rtWith(modalities), "ws", "p", "m", media)).toEqual([]);
      expect(media[0]!.note).toBe(VOICE_UNSUPPORTED_NOTE);
    }
  });

  it("provider lỗi khi hỏi khả năng → coi như không nghe được", async () => {
    const rt = { providers: { get: () => { throw new Error("chưa cấu hình"); } } };
    expect(await voiceForModel(rt, "ws", "p", "m", [voice()])).toEqual([]);
  });
});
