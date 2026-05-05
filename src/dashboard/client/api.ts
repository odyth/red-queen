import type {
  AuditEntryWire,
  ConfigGetResponse,
  ConfigPutResponse,
  ConfigValidateResponse,
  PhaseDefinition,
  SkillEntry,
  SkillGetResponse,
  SkillMutateFail,
  SkillMutateOk,
  StatusPayload,
  TaskSummary,
  WorkflowGetResponse,
  WorkflowPutResponse,
  WorkflowValidateResponse,
} from "../shared/api-types.js";

// Return-only generics on purpose: callers pass the expected response
// shape so the rest of this module reads like a typed API contract.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

async function sendJson<T>(
  url: string,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as T;
  return { ok: r.ok, status: r.status, data };
}

async function sendText<T>(
  url: string,
  method: string,
  body: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "text/plain" },
    body,
  });
  const data = (await r.json()) as T;
  return { ok: r.ok, status: r.status, data };
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

export const api = {
  getStatus: () => getJson<StatusPayload>("/api/status"),
  getQueue: () => getJson<TaskSummary[]>("/api/queue"),
  getLogs: () => getJson<AuditEntryWire[]>("/api/logs"),

  getConfig: () => getJson<ConfigGetResponse>("/api/config"),
  validateConfig: (yaml: string) =>
    sendText<ConfigValidateResponse>("/api/config/validate", "POST", yaml),
  putConfig: (yaml: string) => sendText<ConfigPutResponse>("/api/config", "PUT", yaml),

  getSkills: () => getJson<SkillEntry[]>("/api/skills"),
  getSkill: (name: string) => getJson<SkillGetResponse>(`/api/skills/${encodeURIComponent(name)}`),
  putSkill: (name: string, content: string) =>
    sendJson<SkillMutateOk | SkillMutateFail>(`/api/skills/${encodeURIComponent(name)}`, "PUT", {
      content,
    }),
  deleteSkill: (name: string) =>
    fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }).then(async (r) => ({
      ok: r.ok,
      status: r.status,
      data: (await r.json()) as SkillMutateOk | SkillMutateFail,
    })),

  getWorkflow: () => getJson<WorkflowGetResponse>("/api/workflow"),
  validateWorkflow: (phases: PhaseDefinition[]) =>
    sendJson<WorkflowValidateResponse>("/api/workflow/validate", "POST", { phases }),
  putWorkflow: (phases: PhaseDefinition[]) =>
    sendJson<WorkflowPutResponse>("/api/workflow", "PUT", { phases }),

  serviceRestart: () => fetch("/api/service/restart", { method: "POST" }),
  serviceStop: () => fetch("/api/service/stop", { method: "POST" }),
};
