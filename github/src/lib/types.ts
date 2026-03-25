export interface PlatformConfig {
  provider: string
  destination: string
  name: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "github",
  destination: "github",
  name: "GitHub",
}
