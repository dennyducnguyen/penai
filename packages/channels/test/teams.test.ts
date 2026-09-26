import { describe, expect, it } from "vitest";
import { TeamsChannel, parseTeamsActivity, parseTeamsCardAction, verifyTeamsJwt } from "../src/teams.js";
import type { ChannelDeps } from "../src/types.js";

const deps = (over: Partial<ChannelDeps> = {}): ChannelDeps => ({
  id: "ch-teams",
  name: "PenAI Teams",
  token: "secret",
  config: { appId: "11111111-2222-4333-8444-555555555555", tenantId: "35ee052b-x" },
  requirePairing: true,
  onInbound: async () => ({ kind: "ignore" as const }),
  ...over,
});

describe("parseTeamsActivity", () => {
  const base = {
    type: "message",
    serviceUrl: "https://smba.trafficmanager.net/apac/",
    from: { id: "29:user1", name: "Nguyễn Văn A" },
    recipient: { id: "28:11111111-2222-4333-8444-555555555555" },
  };

  it("chat cá nhân: direct + mentioned mặc định", () => {
    const msg = parseTeamsActivity("ch-teams", {
      ...base,
      text: "xin chào bot",
      conversation: { id: "a:1conv", conversationType: "personal" },
    });
    expect(msg).toMatchObject({
      channelKind: "msteams",
      chatKey: "a:1conv",
      senderId: "29:user1",
      senderName: "Nguyễn Văn A",
      text: "xin chào bot",
      peerKind: "direct",
      mentioned: true,
    });
  });

  it("channel/group: strip tag <at> và set mentioned theo entities", () => {
    const msg = parseTeamsActivity("ch-teams", {
      ...base,
      text: "<at>PenAI Teams</at> báo cáo doanh số",
      conversation: { id: "19:xyz@thread.tacv2;messageid=1", conversationType: "channel" },
      entities: [
        { type: "mention", mentioned: { id: "28:11111111-2222-4333-8444-555555555555", name: "PenAI Teams" } },
      ],
    });
    expect(msg!.text).toBe("báo cáo doanh số");
    expect(msg!.peerKind).toBe("group");
    expect(msg!.mentioned).toBe(true);
  });

  it("group không tag bot → mentioned=false; non-message/không text → null", () => {
    const noTag = parseTeamsActivity("ch-teams", {
      ...base,
      text: "nói chuyện với nhau thôi",
      conversation: { id: "19:g", conversationType: "groupChat" },
      entities: [],
    });
    expect(noTag!.mentioned).toBe(false);
    expect(parseTeamsActivity("ch-teams", { type: "conversationUpdate" })).toBeNull();
    expect(
      parseTeamsActivity("ch-teams", { ...base, text: "", conversation: { id: "x" } }),
    ).toBeNull();
  });
});

describe("TeamsChannel", () => {
  it("start yêu cầu appId + secret; nhớ serviceUrl theo hội thoại", async () => {
    await expect(new TeamsChannel(deps({ config: {} })).start()).rejects.toThrow(/appId/);
    await expect(new TeamsChannel(deps({ token: "" })).start()).rejects.toThrow(/secret/);
    const ch = new TeamsChannel(deps());
    await ch.start();
    ch.noteActivity({
      type: "message",
      serviceUrl: "https://smba.trafficmanager.net/apac/",
      conversation: { id: "a:1conv" },
    });
    // chưa có serviceUrl cho hội thoại lạ và chưa từng inbound → send phải báo rõ
    const ch2 = new TeamsChannel(deps());
    await expect(ch2.send({ chatKey: "a:khac", text: "hi" })).rejects.toThrow(/serviceUrl/);
  });
});

describe("send theo senderId (tin chào mừng pairing)", () => {
  it("map senderId → conversation.id từ inbound; gửi tới đúng hội thoại", async () => {
    const ch = new TeamsChannel(deps());
    const posted: Array<{ chatKey: string }> = [];
    ch.postActivity = async (chatKey, _activity) => {
      posted.push({ chatKey });
      return "id-1";
    };
    ch.noteActivity({
      type: "message",
      serviceUrl: "https://smba.trafficmanager.net/apac/",
      from: { id: "29:user1" },
      conversation: { id: "a:1conv", conversationType: "personal" },
    });
    // approve pairing gửi theo external_user_id ("29:...") — phải resolve về "a:1conv"
    await ch.send({ chatKey: "29:user1", text: "Chào mừng!" });
    expect(posted[0]!.chatKey).toBe("a:1conv");
    // conversation id thật thì gửi thẳng
    await ch.send({ chatKey: "a:1conv", text: "tin thường" });
    expect(posted[1]!.chatKey).toBe("a:1conv");
  });
});

describe("TeamsStream — giao thức streaming chat 1-1", () => {
  function mockChannel() {
    const posts: Array<Record<string, unknown>> = [];
    const ch = new TeamsChannel(deps());
    let n = 0;
    ch.postActivity = async (_chatKey, activity) => {
      posts.push(activity);
      n += 1;
      return `act-${n}`;
    };
    return { ch, posts };
  }

  it("update đầu mở stream, các update sau mang streamId, final chốt đúng", async () => {
    const { ch, posts } = mockChannel();
    const s = ch.createStream("a:1");
    s.push("Xin ");
    await new Promise((r) => setTimeout(r, 50)); // tick đầu chạy ngay
    s.push("chào bạn");
    const ok = await s.finish("Xin chào bạn — câu trả lời đầy đủ.");
    expect(ok).toBe(true);
    const first = posts[0]!;
    expect(first.type).toBe("typing");
    const firstEnt = (first.entities as Array<Record<string, unknown>>)[0]!;
    expect(firstEnt.streamType).toBe("streaming");
    expect(firstEnt.streamSequence).toBe(1);
    expect(firstEnt.streamId).toBeUndefined();
    const last = posts[posts.length - 1]!;
    expect(last.type).toBe("message");
    const lastEnt = (last.entities as Array<Record<string, unknown>>)[0]!;
    expect(lastEnt.streamType).toBe("final");
    expect(lastEnt.streamId).toBe("act-1");
    expect(last.text).toContain("đầy đủ");
  });

  it("post lỗi → stream chết, finish trả false để caller gửi tin thường", async () => {
    const ch = new TeamsChannel(deps());
    ch.postActivity = async () => {
      throw new Error("giả lập Teams từ chối");
    };
    const s = ch.createStream("a:1");
    s.push("delta");
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.finish("final")).toBe(false);
  });

  it("không có delta nào (trả lời ngắn/pairing) → finish false, không post gì", async () => {
    const { ch, posts } = mockChannel();
    const s = ch.createStream("a:1");
    expect(await s.finish("chỉ gửi thường")).toBe(false);
    expect(posts).toHaveLength(0);
  });
});

describe("parseTeamsCardAction — bấm nút Adaptive Card", () => {
  it("activity có value.penaiData → ChannelCallback; tin thường → null", () => {
    const cb = parseTeamsCardAction("ch-teams", {
      type: "message",
      value: { penaiData: '{"pac":"a1b2c3d4","v":"approve"}' },
      from: { id: "29:user1", name: "Đức" },
      conversation: { id: "a:1conv" },
      replyToId: "msg-42",
    });
    expect(cb).toMatchObject({
      channelKind: "msteams",
      chatKey: "a:1conv",
      senderId: "29:user1",
      senderName: "Đức",
      data: '{"pac":"a1b2c3d4","v":"approve"}',
      messageId: "msg-42",
    });
    expect(
      parseTeamsCardAction("ch-teams", {
        type: "message",
        text: "tin thường",
        from: { id: "29:u" },
        conversation: { id: "a:1" },
      }),
    ).toBeNull();
  });
});

describe("verifyTeamsJwt — fail-closed", () => {
  const appId = "11111111-2222-4333-8444-555555555555";
  it("thiếu header / sai định dạng / JWT rác → false", async () => {
    expect(await verifyTeamsJwt(undefined, appId, "")).toBe(false);
    expect(await verifyTeamsJwt("Basic abc", appId, "")).toBe(false);
    expect(await verifyTeamsJwt("Bearer khong-phai-jwt", appId, "")).toBe(false);
    const fake = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ aud: appId, iss: "https://api.botframework.com", exp: 9999999999 })).toString("base64url"),
      "sig",
    ].join(".");
    expect(await verifyTeamsJwt(`Bearer ${fake}`, appId, "")).toBe(false); // alg none bị chặn
  });
  it("aud/iss sai → false trước khi cần fetch key", async () => {
    const mk = (payload: Record<string, unknown>) =>
      "Bearer " +
      [
        Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "c2ln",
      ].join(".");
    expect(
      await verifyTeamsJwt(mk({ aud: "app-khac", iss: "https://api.botframework.com", exp: 9999999999 }), appId, ""),
    ).toBe(false);
    expect(
      await verifyTeamsJwt(mk({ aud: appId, iss: "https://ke-gian.example.com", exp: 9999999999 }), appId, ""),
    ).toBe(false);
    expect(
      await verifyTeamsJwt(mk({ aud: appId, iss: "https://api.botframework.com", exp: 1 }), appId, ""),
    ).toBe(false);
  });
});
