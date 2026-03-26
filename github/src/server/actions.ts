import { createServerFn } from "@tanstack/react-start"

export const fetchStatus = createServerFn({ method: "GET" }).handler(async () => {
  return { ready: true, message: "Use the agent to read GitHub activity — commits, PRs, releases." }
})
