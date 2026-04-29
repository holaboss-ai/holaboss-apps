import { randomUUID } from "node:crypto"

import { getDb } from "./db"
import type {
  AgentActionRecord,
  Result,
  ToolSuccessMeta,
  ZoomInfoError,
} from "../lib/types"

type ToolFn<TArgs, T> = (
  args: TArgs,
) => Promise<Result<T & ToolSuccessMeta, ZoomInfoError>>

export function wrapTool<TArgs, T>(
  toolName: string,
  fn: ToolFn<TArgs, T>,
): ToolFn<TArgs, T> {
  return async (args: TArgs) => {
    const start = Date.now()
    let result: Result<T & ToolSuccessMeta, ZoomInfoError>
    try {
      result = await fn(args)
    } catch (e) {
      result = {
        ok: false,
        error: {
          code: "upstream_error",
          message: e instanceof Error ? e.message : String(e),
        },
      }
    }
    recordAction(toolName, args, result, Date.now() - start)
    return result
  }
}

function recordAction<TArgs, T>(
  toolName: string,
  args: TArgs,
  result: Result<T & ToolSuccessMeta, ZoomInfoError>,
  duration: number,
): void {
  const db = getDb()
  const row: AgentActionRecord = {
    id: randomUUID(),
    timestamp: Date.now(),
    tool_name: toolName,
    args_json: JSON.stringify(args ?? {}),
    outcome: result.ok ? "success" : "error",
    duration_ms: duration,
    zoominfo_object: result.ok ? result.data.zoominfo_object ?? null : null,
    zoominfo_record_id: result.ok ? result.data.zoominfo_record_id ?? null : null,
    zoominfo_deep_link: result.ok ? result.data.zoominfo_deep_link ?? null : null,
    result_summary: result.ok ? result.data.result_summary ?? null : null,
    error_code: result.ok ? null : result.error.code,
    error_message: result.ok ? null : result.error.message,
  }
  db.prepare(`
    INSERT INTO zoominfo_agent_actions (
      id, timestamp, tool_name, args_json, outcome, duration_ms,
      zoominfo_object, zoominfo_record_id, zoominfo_deep_link, result_summary,
      error_code, error_message
    ) VALUES (
      @id, @timestamp, @tool_name, @args_json, @outcome, @duration_ms,
      @zoominfo_object, @zoominfo_record_id, @zoominfo_deep_link, @result_summary,
      @error_code, @error_message
    )
  `).run(row)
}

export function listRecentActions(params: {
  since?: string
  limit?: number
}): Array<AgentActionRecord> {
  const db = getDb()
  const limit = params.limit ?? 100
  if (params.since) {
    return db
      .prepare(`
        SELECT * FROM zoominfo_agent_actions
        WHERE id > @since
        ORDER BY timestamp DESC
        LIMIT @limit
      `)
      .all({ since: params.since, limit }) as Array<AgentActionRecord>
  }
  return db
    .prepare(`
      SELECT * FROM zoominfo_agent_actions
      ORDER BY timestamp DESC
      LIMIT @limit
    `)
    .all({ limit }) as Array<AgentActionRecord>
}

export function clearActions(): number {
  const db = getDb()
  return db.prepare("DELETE FROM zoominfo_agent_actions").run().changes
}
