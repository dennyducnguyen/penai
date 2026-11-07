/**
 * Mẫu quy trình có sẵn (Dashboard → Quy trình → Tạo từ mẫu). Mẫu dùng tên kênh/
 * agent/MCP giả định — người dùng sửa lại sau khi tạo.
 */
import type { WorkflowDefinition } from "./definition.js";

export interface WorkflowTemplate {
  key: string;
  title: string;
  summary: string;
  definition: WorkflowDefinition;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "bao-cao-sang",
    title: "Báo cáo buổi sáng theo lịch",
    summary: "8h sáng thứ Hai–thứ Sáu gọi API lấy số liệu, tính tổng, nhờ agent viết nhận xét rồi gửi vào nhóm chat.",
    definition: {
      name: "Báo cáo buổi sáng",
      description: "Mỗi sáng lấy số liệu từ API, tổng hợp và gửi vào nhóm chat.",
      triggers: [{ type: "schedule", cron: "0 8 * * 1-5" }, { type: "manual" }],
      inputs: { ngay: { type: "string", default: "{{ today(-1) }}", note: "Ngày lấy số liệu (YYYY-MM-DD)" } },
      steps: [
        {
          id: "lay_so_lieu",
          type: "http",
          name: "Lấy số liệu",
          method: "GET",
          url: "https://dummyjson.com/carts?limit=5",
          retry: { times: 2, delay: "10s" },
        },
        {
          id: "tong_hop",
          type: "code",
          name: "Tính tổng",
          code: "const ds = steps.lay_so_lieu.output.body.carts || [];\nreturn { so_don: ds.length, tong: sum(ds, 'total') };",
        },
        {
          id: "co_don",
          type: "if",
          cond: "steps.tong_hop.output.so_don > 0",
          then: [
            {
              id: "nhan_xet",
              type: "agent",
              agent: "tro-ly",
              message: "Viết 2 câu nhận xét ngắn (tiếng Việt) từ số liệu bán hàng ngày {{ inputs.ngay }}: {{ json(steps.tong_hop.output) }}",
              onError: "continue",
            },
            {
              id: "gui_nhom",
              type: "send",
              channel: "telegram:Bot",
              to: "<id nhóm chat>",
              text: "📊 Ngày {{ inputs.ngay }}: {{ steps.tong_hop.output.so_don }} đơn, tổng {{ formatVND(steps.tong_hop.output.tong) }}.\n{{ steps.nhan_xet.output.text }}",
            },
          ],
          else: [{ id: "khong_co", type: "stop", reason: "Không có đơn" }],
        },
      ],
    },
  },
  {
    key: "webhook-nhan-don",
    title: "Webhook nhận đơn, trả JSON",
    summary: "Hệ thống ngoài gọi link webhook gửi đơn hàng; quy trình kiểm tra, trả kết quả ngay và báo nhân viên.",
    definition: {
      name: "Nhận đơn qua webhook",
      description: "Nhận đơn từ website/app, kiểm tra dữ liệu, trả JSON cho bên gọi và báo vào chat.",
      triggers: [{ type: "webhook", methods: ["POST"], respond: "wait", timeoutSec: 30 }],
      inputs: {
        ten: { type: "string", required: true, note: "Tên khách" },
        sdt: { type: "string", required: true, note: "Số điện thoại" },
        tong: { type: "number", default: 0, note: "Tổng tiền" },
      },
      steps: [
        {
          id: "kiem_tra",
          type: "code",
          code: "const sdt = String(inputs.sdt).replace(/\\D/g, '');\nreturn { hop_le: sdt.length >= 9, sdt };",
        },
        {
          id: "hop_le",
          type: "if",
          cond: "steps.kiem_tra.output.hop_le",
          then: [
            { id: "tra_ok", type: "respond", status: 200, body: { ok: true, ma: "{{ workflow.runId }}" } },
            {
              id: "bao_nv",
              type: "send",
              channel: "telegram:Bot",
              to: "<id nhóm nhân viên>",
              text: "🛒 Đơn mới: {{ inputs.ten }} — {{ steps.kiem_tra.output.sdt }} — {{ formatVND(inputs.tong) }}",
            },
          ],
          else: [{ id: "tra_loi", type: "respond", status: 400, body: { ok: false, error: "Số điện thoại không hợp lệ" } }],
        },
      ],
    },
  },
  {
    key: "lap-mcp",
    title: "Lặp danh sách, gọi MCP từng mục",
    summary: "Lấy danh sách từ API, lặp từng phần tử gọi một tool MCP (không qua AI), gom kết quả.",
    definition: {
      name: "Lặp danh sách gọi MCP",
      triggers: [{ type: "manual" }],
      steps: [
        { id: "lay_ds", type: "http", method: "GET", url: "https://dummyjson.com/users?limit=3&select=firstName,email" },
        {
          id: "tung_nguoi",
          type: "loop",
          over: "steps.lay_ds.output.body.users",
          as: "nguoi",
          max: 50,
          body: [
            {
              id: "goi_mcp",
              type: "mcp",
              server: "<tên MCP server>",
              tool: "<tên tool>",
              args: { name: "{{ nguoi.firstName }}", email: "{{ nguoi.email }}" },
              onError: "continue",
            },
          ],
        },
        { id: "ket_qua", type: "code", code: "return { da_xu_ly: steps.tung_nguoi.output.count };" },
      ],
    },
  },
  {
    key: "nho-agent-tra-loi-chat",
    title: "Nhờ agent làm việc rồi trả lời vào chat",
    summary: "Theo lịch hoặc webhook, giao việc cho agent (agent dùng đủ tool của nó) và gửi câu trả lời thẳng vào một cuộc trò chuyện Zalo/Telegram.",
    definition: {
      name: "Agent tổng hợp tin sáng",
      triggers: [{ type: "schedule", cron: "30 7 * * *" }, { type: "manual" }],
      steps: [
        {
          id: "giao_viec",
          type: "agent",
          agent: "tro-ly",
          message: "Tìm 5 tin công nghệ nổi bật 24 giờ qua, tóm tắt mỗi tin 1 câu kèm link.",
          deliver: { channel: "zalo_personal:Zalo", to: "<thread id>" },
          timeout: "5m",
        },
      ],
    },
  },
  {
    key: "theo-doi-website",
    title: "Theo dõi website, báo khi lỗi",
    summary: "Mỗi 15 phút kiểm tra một trang web; trang lỗi hoặc chậm thì gửi cảnh báo.",
    definition: {
      name: "Theo dõi website",
      triggers: [{ type: "schedule", schedule: "every 15m" }],
      settings: { concurrency: "skip" },
      steps: [
        {
          id: "kiem_tra",
          type: "http",
          method: "GET",
          url: "https://example.com",
          failOnStatus: false,
          timeout: "20s",
          onError: "continue",
        },
        {
          id: "loi",
          type: "if",
          cond: "!steps.kiem_tra.output || steps.kiem_tra.output.status >= 400 || steps.kiem_tra.durationMs > 10000",
          then: [
            {
              id: "canh_bao",
              type: "send",
              channel: "telegram:Bot",
              to: "<id chat quản trị>",
              text: "⚠️ example.com lỗi: {{ steps.kiem_tra.error || ('HTTP ' + steps.kiem_tra.output.status) }} ({{ steps.kiem_tra.durationMs }} ms)",
            },
          ],
        },
      ],
    },
  },
];
