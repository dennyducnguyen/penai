/**
 * Lịch hẹn agent tự đặt khi chat (tool cron_create / cron_list / cron_update /
 * cron_delete) — phần runtime sau toolCtx.cron.
 *
 * Lịch nhớ NƠI TẠO (origin): tới giờ CronRunner chạy agent bằng đúng thư mục +
 * quyền của người nhờ đặt lịch và gửi kết quả về đúng cuộc trò chuyện
 * (cron-delivery.ts). Chặn lạm dụng: lịch lặp tối thiểu 5 phút một lần, mỗi
 * người tối đa 20 lịch đang bật; người dùng kênh chỉ thấy/sửa lịch của mình hoặc
 * lịch gửi về chính cuộc trò chuyện đang chat, và chỉ người tạo mới sửa được nội
 * dung việc (lượt chạy dùng thư mục riêng của người tạo).
 */
import type { WorkspaceContext } from "@penai/shared";
import {
  countActiveCronJobsByOwner,
  createCronJob,
  deleteCronJob,
  findUserById,
  listCronJobsForAgent,
  recordAudit,
  updateCronJob,
  type CronJobRow,
  type CronOrigin,
  type Db,
} from "@penai/db";
import {
  describeSchedule,
  formatDuration,
  formatInZone,
  minIntervalMs,
  nextRun,
  normalizeSchedule,
} from "@penai/core";
import type { ToolContext } from "@penai/tools";

export const CRON_MIN_INTERVAL_MS = 5 * 60_000;
export const CRON_MAX_ACTIVE_PER_OWNER = 20;

export type CronToolApi = NonNullable<ToolContext["cron"]>;

export interface CronToolScope {
  agentId: string;
  /** Người đang chat = chủ lịch: "<kênh>-<id người gửi>" | "web-<user id>". */
  ownerKey: string;
  /** Cuộc trò chuyện đang chat (trường `deliver` đặt lúc tạo lịch). */
  origin: CronOrigin;
  /** Quản trị viên chat trên web: thấy/sửa mọi lịch của agent. */
  seeAll: boolean;
  /** Múi giờ của doanh nghiệp (config.timezone). */
  timezone: string;
}

/** Nơi gửi kết quả, viết cho người đọc. */
export function deliverLabel(origin: CronOrigin | null, current?: CronOrigin): string {
  if (!origin) return "không gửi tin (quản trị viên tạo ở Dashboard)";
  if (!origin.deliver) return "không gửi tin (chạy ngầm — xem kết quả ở Dashboard → Cron)";
  if (origin.kind === "channel") {
    if (current?.kind === "channel" && current.channelId === origin.channelId && current.chatKey === origin.chatKey) {
      return "cuộc trò chuyện này";
    }
    return (
      `${origin.channelName ?? origin.channelKind}` +
      (origin.peerKind === "group" ? " (nhóm)" : "") +
      (origin.senderName ? ` · ${origin.senderName}` : "")
    );
  }
  if (current?.kind === "web" && current.userId === origin.userId) {
    return "trang Chat trên web (mỗi lần chạy là một phiên mới tên ⏰ + tên lịch)";
  }
  return `trang Chat trên web của ${origin.userName ?? "người tạo"}`;
}

const isOnce = (schedule: string) => /^at\s/i.test(schedule.trim());

export function makeCronToolApi(db: Db, ctx: WorkspaceContext, scope: CronToolScope): CronToolApi {
  const tz = scope.timezone;
  const chat =
    scope.origin.kind === "channel"
      ? { channelId: scope.origin.channelId, chatKey: scope.origin.chatKey }
      : undefined;
  const visible = (includeDisabled: boolean, limit = 50) =>
    listCronJobsForAgent(
      db,
      ctx,
      scope.agentId,
      scope.seeAll ? { all: true } : { ownerKey: scope.ownerKey, ...(chat ? { chat } : {}) },
      { includeDisabled, limit },
    );

  const line = (row: CronJobRow, now: Date): string => {
    const once = isOnce(row.schedule);
    const when = once ? "một lần" : describeSchedule(row.schedule, row.timezone);
    const state = row.enabled
      ? `lần tới ${formatInZone(row.nextRun, tz)} (còn ${formatDuration(row.nextRun.getTime() - now.getTime())})`
      : once && row.lastRun
        ? `đã chạy lúc ${formatInZone(row.lastRun, tz)}`
        : "đang tạm dừng";
    const prompt = row.prompt.replace(/\s+/g, " ").trim();
    return (
      `#${row.id.slice(0, 8)} · "${row.name}" · ${when} · ${state} · gửi về: ${deliverLabel(row.origin, scope.origin)}` +
      (row.createdVia === "dashboard" ? " · quản trị viên tạo" : "") +
      `\n   việc: ${prompt.length > 160 ? prompt.slice(0, 160) + "…" : prompt}`
    );
  };

  const resolveJob = async (idInput: string): Promise<CronJobRow> => {
    const prefix = idInput.trim().replace(/^#/, "").toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(prefix)) {
      throw new Error(`Id "${idInput}" không hợp lệ — dùng id cron_list hiển thị (vd 3f9a1c2e).`);
    }
    const rows = (await visible(true, 500)).filter((r) => r.id.startsWith(prefix));
    if (!rows.length) {
      throw new Error(`Không tìm thấy lịch #${prefix} trong các lịch bạn quản lý được — gọi cron_list để xem id.`);
    }
    if (rows.length > 1) throw new Error(`Có ${rows.length} lịch cùng bắt đầu bằng "${prefix}" — ghi thêm ký tự của id.`);
    return rows[0]!;
  };

  const assertNotTooFrequent = (schedule: string, now: Date) => {
    if (minIntervalMs(schedule, now, tz) < CRON_MIN_INTERVAL_MS) {
      throw new Error("Lịch lặp lại dày quá — tối thiểu 5 phút một lần.");
    }
  };

  const assertUnderLimit = async (ownerKey: string | null) => {
    if (!ownerKey) return;
    if ((await countActiveCronJobsByOwner(db, ctx, ownerKey)) >= CRON_MAX_ACTIVE_PER_OWNER) {
      throw new Error(
        `Đã có ${CRON_MAX_ACTIVE_PER_OWNER} lịch đang bật — xóa bớt (cron_list → cron_delete) ` +
          "hoặc tạm dừng lịch cũ trước khi bật thêm.",
      );
    }
  };

  return {
    async create(input) {
      const name = input.name.trim();
      const prompt = input.prompt.trim();
      if (!name || !prompt) throw new Error("Thiếu tên lịch hoặc nội dung việc cần làm.");
      const now = new Date();
      const schedule = normalizeSchedule(input.schedule, now, tz);
      const first = nextRun(schedule, now, tz);
      if (!first) throw new Error(`Thời điểm đó đã qua — bây giờ là ${formatInZone(now, tz)} (${tz}).`);
      assertNotTooFrequent(schedule, now);
      await assertUnderLimit(scope.ownerKey);
      let origin: CronOrigin = { ...scope.origin, deliver: input.deliver };
      if (origin.kind === "web" && !origin.userName) {
        const user = await findUserById(db, origin.userId).catch(() => null);
        const label = user?.name?.trim() || user?.email;
        if (label) origin = { ...origin, userName: label };
      }
      const row = await createCronJob(db, ctx, {
        agentId: scope.agentId,
        name: name.slice(0, 80),
        schedule,
        prompt,
        nextRun: first,
        timezone: tz,
        createdVia: "agent",
        ownerKey: scope.ownerKey,
        origin,
      });
      await recordAudit(db, ctx, "cron.agent_create", {
        id: row.id,
        agentId: scope.agentId,
        name: row.name,
        schedule,
        ownerKey: scope.ownerKey,
        deliver: input.deliver,
      });
      const once = isOnce(schedule);
      return [
        `Đã tạo lịch #${row.id.slice(0, 8)} "${row.name}" — ${once ? "chạy một lần" : describeSchedule(schedule, tz)}.`,
        `${once ? "Thời điểm chạy" : "Lần chạy đầu"}: ${formatInZone(first, tz)} ` +
          `(còn ${formatDuration(first.getTime() - now.getTime())}; múi giờ ${tz}).`,
        `Kết quả gửi về: ${deliverLabel(origin, scope.origin)}.`,
      ].join("\n");
    },

    async list({ includeDone }) {
      const rows = await visible(includeDone);
      if (!rows.length) {
        return includeDone
          ? "Chưa có lịch hẹn nào."
          : "Không có lịch hẹn nào đang bật (includeDone=true để xem cả lịch đã chạy xong / tạm dừng).";
      }
      const now = new Date();
      return `Bây giờ: ${formatInZone(now, tz)} (${tz}).\n` + rows.map((r) => line(r, now)).join("\n");
    },

    async update(input) {
      const row = await resolveJob(input.id);
      const now = new Date();
      const patch: Parameters<typeof updateCronJob>[3] = {};
      if (input.name !== undefined) {
        const n = input.name.trim();
        if (!n) throw new Error("Tên lịch không được để trống.");
        patch.name = n.slice(0, 80);
      }
      if (input.prompt !== undefined) {
        // Lượt chạy dùng thư mục + quyền của NGƯỜI TẠO — người khác trong nhóm
        // sửa nội dung việc là đường vòng đọc file riêng của người tạo.
        if (!scope.seeAll && row.ownerKey !== scope.ownerKey) {
          throw new Error(
            "Chỉ người tạo lịch mới sửa được nội dung việc. Bạn có thể tạm dừng, đổi giờ hoặc xóa lịch này, rồi tạo lịch mới của mình.",
          );
        }
        const p = input.prompt.trim();
        if (!p) throw new Error("Nội dung việc không được để trống.");
        patch.prompt = p;
      }
      let schedule = row.schedule;
      let rowTz = row.timezone;
      if (input.schedule !== undefined) {
        schedule = normalizeSchedule(input.schedule, now, tz);
        rowTz = tz;
        assertNotTooFrequent(schedule, now);
        patch.schedule = schedule;
        patch.timezone = tz;
      }
      // Đổi lịch = muốn lịch chạy lại (kể cả lịch một lần đã chạy xong), trừ khi tắt rõ ràng.
      const enable = input.enabled ?? (input.schedule !== undefined ? true : undefined);
      if (enable === true && (input.schedule !== undefined || !row.enabled)) {
        const next = nextRun(schedule, now, rowTz);
        if (!next) {
          throw new Error(
            `Lịch một lần này đã qua thời điểm chạy — truyền schedule mới. Bây giờ là ${formatInZone(now, tz)} (${tz}).`,
          );
        }
        if (!row.enabled) await assertUnderLimit(row.ownerKey);
        patch.enabled = true;
        patch.nextRun = next;
      } else if (enable === false) {
        patch.enabled = false;
      }
      const updated = await updateCronJob(db, ctx, row.id, patch);
      if (!updated) throw new Error("Lịch không còn tồn tại.");
      await recordAudit(db, ctx, "cron.agent_update", {
        id: row.id,
        agentId: scope.agentId,
        by: scope.ownerKey,
        changed: Object.keys(patch),
      });
      return `Đã cập nhật lịch:\n${line(updated, now)}`;
    },

    async remove(idInput) {
      const row = await resolveJob(idInput);
      await deleteCronJob(db, ctx, row.id);
      await recordAudit(db, ctx, "cron.agent_delete", {
        id: row.id,
        agentId: scope.agentId,
        name: row.name,
        by: scope.ownerKey,
      });
      return `Đã xóa lịch #${row.id.slice(0, 8)} "${row.name}".`;
    },
  };
}
