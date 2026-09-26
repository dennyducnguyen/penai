import { describe, expect, it } from "vitest";
import { supportedChannelKinds, isChannelKindSupported } from "../src/manager.js";
import { parseWhatsappWebhook } from "../src/whatsapp.js";

describe("factory hỗ trợ 4 kênh", () => {
  it("telegram, discord, slack, whatsapp", () => {
    const kinds = supportedChannelKinds();
    for (const k of ["telegram", "discord", "slack", "whatsapp"]) {
      expect(isChannelKindSupported(k)).toBe(true);
      expect(kinds).toContain(k);
    }
  });
});

describe("parse WhatsApp Cloud API webhook", () => {
  it("trích text message + tên người gửi", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "84900000000", profile: { name: "Anh Đức" } }],
                messages: [
                  { from: "84900000000", type: "text", text: { body: "xin chào bot" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const msgs = parseWhatsappWebhook("chan-1", payload);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("xin chào bot");
    expect(msgs[0]!.senderId).toBe("84900000000");
    expect(msgs[0]!.senderName).toBe("Anh Đức");
    expect(msgs[0]!.channelKind).toBe("whatsapp");
  });

  it("bỏ qua message không phải text (ảnh, status)", () => {
    const payload = {
      entry: [
        { changes: [{ value: { messages: [{ from: "x", type: "image" }] } }] },
      ],
    };
    expect(parseWhatsappWebhook("c", payload)).toHaveLength(0);
  });

  it("payload rỗng → mảng rỗng", () => {
    expect(parseWhatsappWebhook("c", {})).toHaveLength(0);
    expect(parseWhatsappWebhook("c", { entry: [] })).toHaveLength(0);
  });
});
