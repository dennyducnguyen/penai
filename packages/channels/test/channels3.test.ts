import { describe, expect, it } from "vitest";
import { supportedChannelKinds } from "../src/manager.js";
import { parseZaloWebhook } from "../src/zalo.js";
import { parseFeishuWebhook } from "../src/feishu.js";

describe("6 kênh", () => {
  it("gồm zalo + feishu", () => {
    const k = supportedChannelKinds();
    expect(k).toContain("zalo");
    expect(k).toContain("feishu");
    expect(k.length).toBeGreaterThanOrEqual(6);
  });
});

describe("parse Zalo OA webhook", () => {
  it("user_send_text", () => {
    const msgs = parseZaloWebhook("c1", {
      event_name: "user_send_text",
      sender: { id: "u123" },
      message: { text: "chào shop" },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("chào shop");
    expect(msgs[0]!.channelKind).toBe("zalo");
  });
  it("bỏ event khác", () => {
    expect(parseZaloWebhook("c", { event_name: "follow", follower: { id: "x" } })).toHaveLength(0);
  });
});

describe("parse Feishu webhook", () => {
  it("im.message.receive_v1 text", () => {
    const msgs = parseFeishuWebhook("c2", {
      header: { event_type: "im.message.receive_v1" },
      event: {
        message: { chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "hello" }) },
        sender: { sender_id: { open_id: "ou_1" } },
      },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("hello");
    expect(msgs[0]!.senderId).toBe("ou_1");
  });
  it("bỏ event khác", () => {
    expect(parseFeishuWebhook("c", { header: { event_type: "other" } })).toHaveLength(0);
  });
});
