import { createServerFn } from "@tanstack/react-start"
import { getConnectionStatus } from "../server/connection"

export const fetchConnectionStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return getConnectionStatus()
  },
)