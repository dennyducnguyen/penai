// Đóng gói trình soạn Markdown tách đôi (CodeMirror 6 + markdown-it + ánh xạ dòng) thành MỘT tệp IIFE commit vào repo:
//   apps/server/editor/penai-editor.src.js  →  apps/server/static/vendor/penai-editor.js
// Chạy lại khi sửa nguồn trình soạn hoặc nâng phiên bản thư viện:  node scripts/build-editor-vendor.mjs
// (Máy chủ không cần bước build: tệp đã đóng gói nằm sẵn trong git. Mermaid phục vụ thẳng từ node_modules.)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [`${root}apps/server/editor/penai-editor.src.js`],
  outfile: `${root}apps/server/static/vendor/penai-editor.js`,
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2020"],
  legalComments: "eof",
  banner: { js: "/* PenAI — trình soạn Markdown tách đôi. Tệp sinh tự động từ apps/server/editor/penai-editor.src.js (scripts/build-editor-vendor.mjs). CodeMirror 6, markdown-it: giấy phép MIT. */" },
  logLevel: "info",
});
