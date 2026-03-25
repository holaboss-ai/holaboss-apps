export interface SheetRow {
  rowNumber: number
  values: Record<string, string>
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "google",
  destination: "google",
  name: "Google Sheets",
}
