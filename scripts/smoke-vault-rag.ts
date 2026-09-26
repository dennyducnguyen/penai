export {};

const baseUrl = (process.env.PENAI_SMOKE_URL ?? "http://127.0.0.1:18800").replace(/\/$/, "");
const apiKey = process.env.PENAI_SMOKE_API_KEY;
if (!apiKey) throw new Error("Thiếu PENAI_SMOKE_API_KEY");

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`);
  return json;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`);
}

const suffix = Date.now().toString(36);
let collectionId = "";
let documentId = "";
let sessionId = "";
let conversationTested = false;
let autoRetrieveTested = false;
try {
  const settings = (await api("/v1/vault/settings")).settings as { chunkTokens: number };
  assert(settings.chunkTokens === 800, `chunk mặc định phải là 800, hiện là ${settings.chunkTokens}`);

  const options = await api("/v1/vault/access-options") as unknown as {
    agents: Array<{ id: string; key: string }>;
    principals: Array<{ id: string; displayName: string }>;
    conversations: Array<{ id: string }>;
  };
  assert(options.agents.length >= 2, "cần ít nhất 2 agent để kiểm ACL agent");
  assert(options.principals.length >= 2, "cần ít nhất 2 principal để kiểm ACL người dùng");
  const [agentA, agentB] = options.agents;
  const [principalA, principalB] = options.principals;

  const created = await api("/v1/vault/collections", {
    method: "POST",
    body: { slug: `smoke-rag-${suffix}`, name: `Smoke RAG ${suffix}`, description: "Dữ liệu tạm cho smoke test" },
  });
  collectionId = (created.collection as { id: string }).id;

  const marker = `HELIOS-${suffix.toUpperCase()}`;
  const saved = await api("/v1/vault", {
    method: "POST",
    body: {
      collectionId,
      slug: `smoke-doc-${suffix}`,
      title: "Chính sách thành viên Bạch Kim",
      content: `# Hoàn trả\n\nKhách hàng hạng Bạch Kim được đổi hoặc hoàn trả sản phẩm trong ba mươi ngày kể từ ngày nhận hàng. Mã kiểm chứng nội bộ là ${marker}.\n\n# Hỗ trợ\n\nYêu cầu phải kèm hóa đơn điện tử.`,
    },
  });
  const savedDoc = saved.doc as { id: string };
  const index = saved.index as { chunks: number; embedded: boolean };
  documentId = savedDoc.id;
  assert(index.chunks >= 1, "tài liệu phải sinh ít nhất một chunk");
  assert(index.embedded, "production phải index bằng Gemini embedding, không chỉ FTS");

  async function hits(agentId: string, principalId: string, query: string) {
    const result = await api(`/v1/vault-search?q=${encodeURIComponent(query)}&agentId=${agentId}&principalId=${principalId}`);
    return result.hits as Array<{ documentId: string; sources: string[] }>;
  }

  let found = await hits(agentA!.id, principalA!.id, marker);
  assert(found.some((h) => h.documentId === documentId && h.sources.includes("lexical")), "grant all/all phải tìm thấy bằng FTS");

  found = await hits(agentA!.id, principalA!.id, "thời hạn hoàn hàng cho hội viên cao cấp");
  assert(found.some((h) => h.documentId === documentId && h.sources.includes("vector")), "semantic query phải tìm thấy bằng vector");

  await api(`/v1/vault/collections/${collectionId}/grants`, {
    method: "PUT",
    body: { grants: [{ agentId: agentA!.id, audienceType: "all" }] },
  });
  assert((await hits(agentA!.id, principalA!.id, marker)).some((h) => h.documentId === documentId), "agent được cấp phải thấy");
  assert(!(await hits(agentB!.id, principalA!.id, marker)).some((h) => h.documentId === documentId), "agent không được cấp không được thấy");

  await api(`/v1/vault/collections/${collectionId}/grants`, {
    method: "PUT",
    body: { grants: [{ agentId: agentA!.id, audienceType: "principal", principalId: principalA!.id }] },
  });
  assert((await hits(agentA!.id, principalA!.id, marker)).some((h) => h.documentId === documentId), "principal được cấp phải thấy");
  assert(!(await hits(agentA!.id, principalB!.id, marker)).some((h) => h.documentId === documentId), "principal khác không được thấy");

  if (options.conversations[0]) {
    await api(`/v1/vault/collections/${collectionId}/grants`, {
      method: "PUT",
      body: { grants: [{ agentId: agentA!.id, audienceType: "conversation", conversationId: options.conversations[0].id }] },
    });
    const withConversation = await api(`/v1/vault-search?q=${encodeURIComponent(marker)}&agentId=${agentA!.id}&principalId=${principalA!.id}&conversationId=${options.conversations[0].id}`);
    assert((withConversation.hits as Array<{ documentId: string }>).some((h) => h.documentId === documentId), "conversation được cấp phải thấy");
    assert(!(await hits(agentA!.id, principalA!.id, marker)).some((h) => h.documentId === documentId), "không có conversation đúng phải bị chặn");
    conversationTested = true;
  }

  const agentRows = (await api("/v1/agents")).agents as Array<{ id: string; key: string; provider: string }>;
  const chatAgent = agentRows.find((a) => a.key === "test-claude") ?? agentRows.find((a) => a.provider === "claude-code") ?? agentRows[0];
  assert(chatAgent, "cần một agent để kiểm auto-retrieval");
  await api(`/v1/vault/collections/${collectionId}/grants`, {
    method: "PUT",
    body: { grants: [{ agentId: chatAgent.id, audienceType: "all" }] },
  });
  const session = await api("/v1/sessions", {
    method: "POST",
    body: { agentKey: chatAgent.key, title: `smoke-auto-rag-${suffix}` },
  });
  sessionId = (session.session as { id: string }).id;
  const chat = await api("/v1/chat", {
    method: "POST",
    body: {
      sessionId,
      stream: false,
      message: "Theo Kho tri thức, mã kiểm chứng nội bộ trong chính sách hoàn trả Bạch Kim là gì? Chỉ trả đúng mã.",
    },
  });
  assert(String(chat.finalText ?? "").includes(marker), "agent phải nhận được mã qua auto-retrieval trước LLM");
  autoRetrieveTested = true;

  await api(`/v1/vault/collections/${collectionId}/grants`, { method: "PUT", body: { grants: [] } });
  assert(!(await hits(agentA!.id, principalA!.id, marker)).some((h) => h.documentId === documentId), "Collection không grant phải fail-closed");

  console.log(JSON.stringify({
    ok: true,
    chunks: index.chunks,
    embedded: index.embedded,
    acl: `all/agent/principal/${conversationTested ? "conversation/" : ""}fail-closed`,
    autoRetrieve: autoRetrieveTested,
  }));
} finally {
  if (sessionId) await api(`/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  if (documentId) await api(`/v1/vault/${documentId}`, { method: "DELETE" }).catch(() => undefined);
  if (collectionId) await api(`/v1/vault/collections/${collectionId}`, { method: "DELETE" }).catch(() => undefined);
}
