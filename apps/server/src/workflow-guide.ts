/** Tóm tắt định dạng — cùng nội dung với skill quy-trinh (bản ngắn cho AI bên ngoài). */
export const WORKFLOW_GUIDE = `# Định dạng quy trình PenAI (JSON dạng cây)

{ "name": "...", "description": "...",
  "triggers": [ {"type":"schedule","cron":"0 8 * * 1-5"} | {"type":"schedule","schedule":"every 2h"} | {"type":"webhook","methods":["POST"],"respond":"wait"|"async","auth":"token"|"hmac"} | {"type":"manual"} ],
  "inputs": { "ngay": {"type":"string|number|boolean|json","default":"{{ today() }}","required":false,"note":"..."} },
  "settings": { "concurrency":"skip|queue|parallel", "timeoutSec":600, "allowFromChat":false, "notifyOnError":{"channel":"telegram:Bot","to":"<chat>"} },
  "steps": [ ... ] }

Mỗi bước: { "id": "a_z_0_9" (duy nhất), "type": ..., "name"?, "retry"?: {"times":2,"delay":"10s"}, "onError"?: "stop"|"continue", "timeout"?: "30s", "disabled"?: true }
- http: method, url, headers, query, body, bodyType json|text|form, failOnStatus(false để không lỗi khi ≥400) → output {status, headers, body}
- code: code (JavaScript có return, không có fetch/require) → giá trị return
- if: cond, then[], else[] · switch: value, cases:[{value|when, steps[]}], default[]
- loop: over (mảng), as ("item"), max (≤1000), body[] — trong body dùng biến as, index, loop.first/last; {type:"break"} để thoát
- while: cond, max, body[] · parallel: branches:[[...],[...]] · wait: duration "30s" | until ISO
- set: values {ten: "{{ ... }}"} → vars.ten · stop: reason
- send: channel ("kind:Tên kênh" hoặc id), to (cuộc trò chuyện), text, files[]
- tool: tool, args, agent? (chạy bằng quyền/thư mục agent), approved (chỉ admin tick)
- mcp: server, tool, args
- agent: agent (key), message, json?: true (ép trả JSON → output.json), deliver?: {channel,to} (gửi câu trả lời thẳng vào chat) → output {text, json?}
- respond: status, headers, body (trả cho bên gọi webhook)
- subworkflow: workflow (id/slug), inputs, wait
- file: action read|write|append|list|delete, path, content (thư mục riêng của quy trình)
- shell: command, env (chỉ khi máy chủ bật workflows.allowShell và admin tick approved)

Biểu thức: "{{ JS }}" trong chuỗi (chuỗi chỉ gồm một {{ }} thì giữ kiểu); cond/over/value/code là JS.
Ngữ cảnh: inputs.*, trigger.* (webhook: body/query/method), steps.<id>.output / .error / .durationMs, vars.*, workflow.{id,name,runId}, secrets.TEN (chỉ trong http url/headers/query/body, mcp/tool args, shell env).
Hàm: today(±ngày), now(), formatDate(d,"DD/MM/YYYY HH:mm"), addDays, diffDays, weekday, json, parseJson, get(o,"a.b"), num, sum(arr,key), avg, min, max, count, groupBy(arr,key)→[{key,items,count}], uniq, sortBy(arr,key,desc), pluck, chunk, range, round, formatNumber, formatVND, slugify, truncate, base64, sha256, hmacSha256.

Quy trình làm: workflow_catalog (lấy đúng tên kênh/tool/MCP/agent) → workflow_create → workflow_test dryRun → sửa theo lỗi → báo link Dashboard.`;
