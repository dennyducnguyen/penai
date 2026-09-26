// In logo SVG mặc định (theo theme) ra stdout — dùng để làm lại docs/assets/logo.svg:
//   pnpm exec tsx scripts/print-logo.ts [xanh-duong|tim|xanh-ngoc] > docs/assets/logo.svg
import { BrandingSchema } from "../packages/shared/src/index.js";
import { defaultLogoSvg } from "../apps/server/src/branding.js";

const theme = process.argv[2] ?? "xanh-duong";
process.stdout.write(defaultLogoSvg(BrandingSchema.parse({ theme })) + "\n");
