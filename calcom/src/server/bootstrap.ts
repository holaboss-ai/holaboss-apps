import { getDb } from "./db"

let bootstrapped = false

export function ensureBootstrapped(): void {
  if (bootstrapped) return
  getDb()
  bootstrapped = true
}