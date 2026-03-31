import { createFileRoute } from "@tanstack/react-router"

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"

const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ")

export const Route = createFileRoute("/api/auth/google")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env.GOOGLE_CLIENT_ID ?? ""
        if (!clientId) {
          return new Response("GOOGLE_CLIENT_ID not set", { status: 500 })
        }

        const url = new URL(request.url)
        const redirectUri = `${url.origin}/api/auth/callback`

        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
        })

        return new Response(null, {
          status: 302,
          headers: { Location: `${GOOGLE_AUTH_URL}?${params}` },
        })
      },
    },
  },
})
