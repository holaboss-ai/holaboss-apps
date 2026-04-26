import { createServerFn } from "@tanstack/react-start"
import { getConnectionStatus } from "./connection"

export const fetchConnectionStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return getConnectionStatus()
  },
)
