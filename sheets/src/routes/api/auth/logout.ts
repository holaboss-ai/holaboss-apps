import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      GET: async () => {
        // Clear token so the demo shows the "Connect" screen again
        delete process.env.PLATFORM_INTEGRATION_TOKEN

        return new Response(null, {
          status: 302,
          headers: { Location: "/demo" },
        })
      },
    },
  },
})
