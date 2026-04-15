# Cal.com Module

A Holaboss module that gives the workspace agent Cal.com scheduling capabilities via bridge+Composio.

## What it does

Exposes 8 MCP tools for reading and managing Cal.com event types, bookings, and availability. All operations are pure proxy: Cal.com is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI with a live Upcoming Bookings panel.

## Tools

| Tool | Purpose |
|------|---------|
| `calcom_get_connection_status` | Check if Cal.com is connected |
| `calcom_list_event_types` | List the user's event types (slug, duration, booking URL, description) |
| `calcom_get_event_type` | Fetch a single event type's full details |
| `calcom_list_bookings` | List bookings filtered by status (upcoming/past/cancelled) or attendee email |
| `calcom_get_booking` | Fetch a single booking's full details |
| `calcom_cancel_booking` | Cancel a booking with a reason |
| `calcom_reschedule_booking` | Reschedule a booking to a new start time |
| `calcom_list_available_slots` | Check free slots for an event type within a date range |

## Architecture

Pure proxy via bridge + Composio. No local business data. Single SQLite audit log table. Same structural shape as the `attio` module. See `docs/superpowers/plans/2026-04-15-calcom-module.md` for the full plan.

## Development

```bash
pnpm install --maxsockets 1
pnpm run dev          # start web + MCP + services
pnpm test             # run unit + e2e (mock bridge)
pnpm run build        # production build
```

## Environment variables

- `HOLABOSS_APP_GRANT` — workspace grant token (set by sandbox runtime)
- `HOLABOSS_INTEGRATION_BROKER_URL` — broker URL (set by sandbox runtime)
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect Cal.com" link
- `DB_PATH` — SQLite file path (default: `./data/calcom.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
