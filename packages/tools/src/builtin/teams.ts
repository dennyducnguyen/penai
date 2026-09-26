import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const delegateSchema = z.object({
  agent: z.string().min(1).describe("key của agent nhận việc (trong cùng workspace)."),
  task: z.string().min(1).describe("nội dung công việc cần agent kia thực hiện."),
});

export const delegateTool: ToolHandler<typeof delegateSchema> = {
  name: "delegate",
  description:
    "Giao một công việc con cho agent khác trong workspace và nhận lại kết quả. " +
    "Dùng khi việc cần chuyên môn/khả năng của agent khác.",
  schema: delegateSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.delegate) throw new Error("Delegation chưa được bật");
    return toolCtx.delegate(args.agent, args.task);
  },
};

const addTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
});
export const teamAddTaskTool: ToolHandler<typeof addTaskSchema> = {
  name: "team_add_task",
  description: "Thêm một công việc vào bảng công việc nhóm.",
  schema: addTaskSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.team) throw new Error("Agent không thuộc team nào");
    return toolCtx.team.addTask(args.title, args.description);
  },
};

const emptySchema = z.object({});
export const teamNextTaskTool: ToolHandler<typeof emptySchema> = {
  name: "team_next_task",
  description: "Nhận (claim) công việc tiếp theo trong bảng nhóm để xử lý.",
  schema: emptySchema,
  async execute(_args, toolCtx) {
    if (!toolCtx.team) throw new Error("Agent không thuộc team nào");
    return toolCtx.team.nextTask();
  },
};

const finishSchema = z.object({
  taskId: z.string().min(1),
  result: z.string().default(""),
});
export const teamFinishTaskTool: ToolHandler<typeof finishSchema> = {
  name: "team_finish_task",
  description: "Đánh dấu một công việc nhóm đã hoàn thành kèm kết quả.",
  schema: finishSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.team) throw new Error("Agent không thuộc team nào");
    return toolCtx.team.finishTask(args.taskId, args.result);
  },
};

export const teamListTasksTool: ToolHandler<typeof emptySchema> = {
  name: "team_list_tasks",
  description: "Xem bảng công việc của nhóm.",
  schema: emptySchema,
  async execute(_args, toolCtx) {
    if (!toolCtx.team) throw new Error("Agent không thuộc team nào");
    return toolCtx.team.listTasks();
  },
};
