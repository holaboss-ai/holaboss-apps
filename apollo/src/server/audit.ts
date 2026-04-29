import { randomUUID } from "node:crypto"

import { getDb } from "./db"
import type {
  AgentActionRecord,
  ApolloError,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

type ToolFn<A, T> = (
  args: A,
) => Promise<Result<T & ToolSuccessMeta, ApolloError>>

export function wrapTool<A, T>(
  toolName: string,
  fn: ToolFn<A, T>,
): ToolFn<A, T> {
  return async (args: A) => {
    const start = Date.now()
    let result: Result<T & ToolSuccessMeta, ApolloError>
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

function recordAction<A, T>(
  toolName: string,
  args: A,
  result: Result<T & ToolSuccessMeta, ApolloError>,
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
    apollo_object: result.ok ? result.data.apollo_object ?? null : null,
    apollo_record_id: result.ok ? result.data.apollo_record_id ?? null : null,
    apollo_deep_link: result.ok ? result.data.apollo_deep_link ?? null : null,
    result_summary: result.ok ? result.data.result_summary ?? null : null,
    error_code: result.ok ? null : result.error.code,
    error_message: result.ok ? null : result.error.message,
  }
  db.prepare(`
    INSERT INTO apollo_agent_actions (
      id, timestamp, tool_name, args_json, outcome, duration_ms,
      apollo_object, apollo_record_id, apollo_deep_link, result_summary,
      error_code, error_message
    ) VALUES (
      @id, @timestamp, @tool_name, @args_json, @outcome, @duration_ms,
      @apollo_object, @apollo_record_id, @apollo_deep_link, @result_summary,
      @error_code, @error_message
    )
  `).run(row)
}

export function listRecentActions(params: {
  since?: string
  limit?: number
}): AgentActionRecord[] {
  const db = getDb()
  const limit = params.limit ?? 100
  if (params.since) {
    return db
      .prepare(`
        SELECT * FROM apollo_agent_actions
        WHERE id > @since
        ORDER BY timestamp DESC
        LIMIT @limit
      `)
      .all({ since: params.since, limit }) as AgentActionRecord[]
  }
  return db
    .prepare(`
      SELECT * FROM apollo_agent_actions
      ORDER BY timestamp DESC
      LIMIT @limit
    `)
    .all({ limit }) as AgentActionRecord[]
}

export function clearActions(): number {
  const db = getDb()
  return db.prepare("DELETE FROM apollo_agent_actions").run().changes
}
