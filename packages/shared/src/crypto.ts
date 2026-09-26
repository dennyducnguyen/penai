import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/** sha256 hex — dùng cho hash API key. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Sinh API key mới dạng `psk_<base64url 32 bytes>`. */
export function generateApiKey(): string {
  return `psk_${randomBytes(32).toString("base64url")}`;
}

/** Token phiên web: 32 bytes base64url (cookie giữ thô, DB giữ sha256). */
export function generateSessionToken(): string {
  return `pss_${randomBytes(32).toString("base64url")}`;
}

// scrypt (node:crypto, không cần native dep). Định dạng:
//   scrypt$N$r$p$<salt b64>$<hash b64>
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const SEP = "$";
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), hash.toString("base64")].join(SEP);
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function masterKey(): Buffer {
  const b64 = process.env.PENAI_MASTER_KEY;
  if (!b64) throw new Error("Thiếu env PENAI_MASTER_KEY (base64 32 bytes)");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32)
    throw new Error("PENAI_MASTER_KEY phải là base64 của đúng 32 bytes");
  return key;
}

/**
 * Mã hóa secret at-rest bằng AES-256-GCM.
 * Định dạng: `v1.<iv b64>.<authTag b64>.<ciphertext b64>`
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1")
    throw new Error("Định dạng secret không hợp lệ");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivB64!, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64!, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
