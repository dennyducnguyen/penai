/**
 * Thao tác nhỏ trên định nghĩa (PATCH ops / workflow_update ops) — dành cho việc
 * nhỏ như đổi lịch, chèn/xóa/di chuyển một bước. Sửa lớn thì gửi JSON đầy đủ.
 */
import { findStep, type StepBase, type WorkflowDefinition } from "./definition.js";

export type WorkflowOp =
  | { op: "set_step"; id: string; step: StepBase }
  | { op: "update_step"; id: string; fields: Record<string, unknown> }
  | { op: "insert"; step: StepBase; after?: string; before?: string; into?: { id: string; key: string } }
  | { op: "remove_step"; id: string }
  | { op: "move_step"; id: string; after?: string; before?: string; into?: { id: string; key: string } }
  | { op: "set_triggers"; triggers: WorkflowDefinition["triggers"] }
  | { op: "set"; key: "name" | "description" | "inputs" | "settings"; value: unknown };

export class OpError extends Error {}

/** Lấy mảng con theo key ("then", "else", "body", "default", "branches[1]", "cases[0].steps"). */
function childList(parent: StepBase, key: string, create: boolean): StepBase[] {
  const br = /^branches\[(\d+)\]$/.exec(key);
  if (br) {
    const i = Number(br[1]);
    if (!Array.isArray(parent.branches)) {
      if (!create) throw new OpError(`Bước "${parent.id}" không có branches`);
      parent.branches = [];
    }
    const arr = parent.branches as StepBase[][];
    while (create && arr.length <= i) arr.push([]);
    if (!arr[i]) throw new OpError(`Bước "${parent.id}" không có nhánh ${i}`);
    return arr[i]!;
  }
  const cs = /^cases\[(\d+)\]\.steps$/.exec(key);
  if (cs) {
    const c = (parent.cases as Array<{ steps: StepBase[] }> | undefined)?.[Number(cs[1])];
    if (!c) throw new OpError(`Bước "${parent.id}" không có cases[${cs[1]}]`);
    c.steps ??= [];
    return c.steps;
  }
  if (!["then", "else", "body", "default"].includes(key)) throw new OpError(`key "${key}" không hợp lệ (then, else, body, default, branches[i], cases[i].steps)`);
  if (!Array.isArray(parent[key])) {
    if (!create) throw new OpError(`Bước "${parent.id}" không có ${key}`);
    parent[key] = [];
  }
  return parent[key] as StepBase[];
}

function place(def: WorkflowDefinition, step: StepBase, where: { after?: string; before?: string; into?: { id: string; key: string } }): void {
  if (where.after || where.before) {
    const ref = findStep(def.steps, (where.after ?? where.before)!);
    if (!ref) throw new OpError(`Không có bước "${where.after ?? where.before}"`);
    ref.list.splice(ref.index + (where.after ? 1 : 0), 0, step);
    return;
  }
  if (where.into) {
    const parent = findStep(def.steps, where.into.id);
    if (!parent) throw new OpError(`Không có bước "${where.into.id}"`);
    childList(parent.step, where.into.key, true).push(step);
    return;
  }
  def.steps.push(step);
}

/** Áp danh sách thao tác lên bản sao định nghĩa. Ném OpError khi không làm được. */
export function applyOps(input: WorkflowDefinition, ops: WorkflowOp[]): WorkflowDefinition {
  const def = JSON.parse(JSON.stringify(input)) as WorkflowDefinition;
  def.steps ??= [];
  ops.forEach((o, i) => {
    const pre = `ops[${i}] (${(o as { op?: string }).op ?? "?"})`;
    try {
      switch (o.op) {
        case "set_step": {
          const f = findStep(def.steps, o.id);
          if (!f) throw new OpError(`Không có bước "${o.id}"`);
          f.list[f.index] = o.step;
          break;
        }
        case "update_step": {
          const f = findStep(def.steps, o.id);
          if (!f) throw new OpError(`Không có bước "${o.id}"`);
          for (const [k, v] of Object.entries(o.fields ?? {})) {
            if (k === "id" && v !== o.id) throw new OpError("Không đổi id bằng update_step — dùng set_step");
            if (v === null) delete f.step[k];
            else f.step[k] = v;
          }
          break;
        }
        case "insert":
          if (!o.step?.id) throw new OpError("Thiếu step.id");
          if (findStep(def.steps, o.step.id)) throw new OpError(`Đã có bước id "${o.step.id}"`);
          place(def, o.step, o);
          break;
        case "remove_step": {
          const f = findStep(def.steps, o.id);
          if (!f) throw new OpError(`Không có bước "${o.id}"`);
          f.list.splice(f.index, 1);
          break;
        }
        case "move_step": {
          const f = findStep(def.steps, o.id);
          if (!f) throw new OpError(`Không có bước "${o.id}"`);
          if (o.after === o.id || o.before === o.id || o.into?.id === o.id) throw new OpError("Không di chuyển bước vào chính nó");
          const [step] = f.list.splice(f.index, 1);
          if (o.into && findStep([step!], o.into.id)) throw new OpError("Không di chuyển bước vào bên trong chính nó");
          place(def, step!, o);
          break;
        }
        case "set_triggers":
          if (!Array.isArray(o.triggers)) throw new OpError("triggers phải là mảng");
          def.triggers = o.triggers;
          break;
        case "set":
          if (!["name", "description", "inputs", "settings"].includes(o.key)) throw new OpError(`key "${o.key}" không đổi được`);
          (def as unknown as Record<string, unknown>)[o.key] = o.value;
          break;
        default:
          throw new OpError(`op "${(o as { op?: string }).op}" không có — dùng set_step, update_step, insert, remove_step, move_step, set_triggers, set`);
      }
    } catch (err) {
      throw new OpError(`${pre}: ${(err as Error).message}`);
    }
  });
  return def;
}
