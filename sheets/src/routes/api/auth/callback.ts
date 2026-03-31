import { createFileRoute } from "@tanstack/react-router"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const TOKEN_FILE = "/holaboss/state/integration-tokens.json"
const LOCAL_TOKEN_FILE = "./data/google-token.json"

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const code = url.searchParams.get("code")
        const error = url.searchParams.get("error")

        if (error) {
          return new Response(`Auth error: ${error}`, { status: 400 })
        }
        if (!code) {
          return new Response("Missing authorization code", { status: 400 })
        }

        const clientId = process.env.GOOGLE_CLIENT_ID ?? ""
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ""
        const redirectUri = `${url.origin}/api/auth/callback`

        const res = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        })

        if (!res.ok) {
          const text = await res.text()
          return new Response(`Token exchange failed: ${text}`, { status: 500 })
        }

        const tokens = await res.json() as { access_token: string; refresh_token?: string }

        // Store token — try platform path first, fall back to local
        const accessToken = tokens.access_token
        try {
          mkdirSync(dirname(TOKEN_FILE), { recursive: true })
          writeFileSync(TOKEN_FILE, JSON.stringify({ google: accessToken }))
        } catch {
          mkdirSync("./data", { recursive: true })
          writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify({ google: accessToken }))
        }

        // Set token in env for immediate use
        process.env.PLATFORM_INTEGRATION_TOKEN = accessToken

        return new Response(null, {
          status: 302,
          headers: { Location: "/demo" },
        })
      },
    },
  },
})
