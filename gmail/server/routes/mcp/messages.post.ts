import { defineEventHandler, getQuery } from "h3"
import { transports } from "./sse.get"

export default defineEventHandler(async (event) => {
  const sessionId = getQuery(event).sessionId as string | undefined
  const transport = sessionId ? transports.get(sessionId) : undefined
  if (!transport) {
    event.node.res.writeHead(400)
    event.node.res.end("Unknown session")
    return
  }
  await transport.handlePostMessage(event.node.req, event.node.res)
})
