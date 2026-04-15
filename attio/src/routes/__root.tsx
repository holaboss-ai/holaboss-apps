import { createRootRoute, Outlet } from "@tanstack/react-router"
import "../styles.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Attio CRM · Holaboss" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="en">
      <head />
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Outlet />
      </body>
    </html>
  )
}