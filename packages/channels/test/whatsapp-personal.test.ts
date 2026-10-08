import { describe, expect, it } from "vitest";
import {
  describeWhatsappContent,
  isPersonalChannelKind,
  isValidThreadId,
  isWhatsappThreadId,
  normalizeWhatsappPhone,
  personalPlatformLabel,
  whatsappThreadToJid,
} from "../src/index.js";

describe("WhatsApp cá nhân — tiện ích", () => {
  it("chuẩn hóa số điện thoại: số Việt Nam bắt đầu bằng 0 → 84…", () => {
    expect(normalizeWhatsappPhone("0938 583 264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("+84 938-583-264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("0084938583264")).toBe("84938583264");
    expect(normalizeWhatsappPhone("6591234567")).toBe("6591234567");
  });

  it("mã hội thoại ↔ JID", () => {
    expect(whatsappThreadToJid("84938583264")).toBe("84938583264@s.whatsapp.net");
    expect(whatsappThreadToJid("120363041234567890@g.us")).toBe("120363041234567890@g.us");
    expect(whatsappThreadToJid("123456789012345@lid")).toBe("123456789012345@lid");
    expect(isWhatsappThreadId("84938583264")).toBe(true);
    expect(isWhatsappThreadId("84938583264-1600000000@g.us")).toBe(true);
    expect(isWhatsappThreadId("status@broadcast")).toBe(false);
    expect(isWhatsappThreadId("../etc/passwd")).toBe(false);
  });

  it("mã hội thoại hợp lệ theo từng nền tảng", () => {
    expect(isValidThreadId("zalo_personal", "8417834533475765420")).toBe(true);
    expect(isValidThreadId("zalo_personal", "84938583264@s.whatsapp.net")).toBe(false);
    expect(isValidThreadId("whatsapp_personal", "120363041234567890@g.us")).toBe(true);
    expect(isValidThreadId("whatsapp_personal", "abc")).toBe(false);
    expect(isPersonalChannelKind("whatsapp_personal")).toBe(true);
    expect(isPersonalChannelKind("whatsapp")).toBe(false);
    expect(personalPlatformLabel("whatsapp_personal")).toBe("WhatsApp");
  });

  it("mô tả nội dung tin cho Inbox", () => {
    expect(describeWhatsappContent({ conversation: "Xin chào" })).toEqual({ contentType: "text", text: "Xin chào" });
    expect(describeWhatsappContent({ extendedTextMessage: { text: "Trả lời" } })).toEqual({ contentType: "text", text: "Trả lời" });
    expect(describeWhatsappContent({ imageMessage: { caption: "Ảnh mẫu" } })).toEqual({ contentType: "photo", text: "Ảnh mẫu" });
    expect(describeWhatsappContent({ documentMessage: { fileName: "bao-gia.pdf", fileLength: 2048 } })).toEqual({
      contentType: "file",
      text: "",
      media: { name: "bao-gia.pdf", size: 2048 },
    });
    // Tin tự hủy / xem một lần bọc nội dung bên trong
    expect(describeWhatsappContent({ ephemeralMessage: { message: { conversation: "Tin tự hủy" } } })).toEqual({
      contentType: "text",
      text: "Tin tự hủy",
    });
    // Không phải nội dung trò chuyện
    expect(describeWhatsappContent({ reactionMessage: { text: "❤️" } })).toBeNull();
    expect(describeWhatsappContent({ protocolMessage: {} })).toBeNull();
    expect(describeWhatsappContent(null)).toBeNull();
  });
});
