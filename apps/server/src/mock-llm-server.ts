import { startMockLlm } from "@penai/providers/mock-llm";

const port = Number(process.env.MOCK_LLM_PORT ?? 18801);
const s = await startMockLlm(port);
console.log(`Mock LLM (OpenAI-compat) chạy tại ${s.url}`);
