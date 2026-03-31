const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? "";

function resolveBrokerUrl(): string {
  const explicit = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "";
  if (explicit) {
    // Fix port mismatch: if runtime port is known and differs from the URL, use the runtime port
    const runtimePort = process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? "";
    if (runtimePort) {
      try {
        const url = new URL(explicit);
        if (url.port !== runtimePort) {
          url.port = runtimePort;
          return url.toString().replace(/\/$/, "");
        }
      } catch {
        // ignore URL parse errors
      }
    }
    return explicit;
  }
  const port = process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? process.env.PORT ?? "";
  if (port) {
    return `http://127.0.0.1:${port}/api/v1/integrations`;
  }
  return "";
}

interface TokenExchangeResponse {
  token: string;
  provider: string;
  connection_id: string;
}

interface TokenExchangeError {
  error: string;
  message: string;
}

export async function getProviderToken(provider: string): Promise<string> {
  const brokerUrl = resolveBrokerUrl();
  if (!brokerUrl || !APP_GRANT) {
    return getFallbackToken(provider);
  }

  const brokerTokenUrl = `${brokerUrl}/broker/token`;
  try {
    const response = await fetch(brokerTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: APP_GRANT, provider })
    });

    if (response.ok) {
      const data = (await response.json()) as TokenExchangeResponse;
      return data.token;
    }

    let errorBody: TokenExchangeError | null = null;
    try {
      errorBody = (await response.json()) as TokenExchangeError;
    } catch {
      // ignore parse errors
    }

    const errorMessage = errorBody?.message ?? `broker returned ${response.status}`;
    throw new Error(`Integration broker error (${errorBody?.error ?? "unknown"}): ${errorMessage}`);
  } catch (error) {
    if (error instanceof TypeError && String(error.message).includes("fetch")) {
      return getFallbackToken(provider);
    }
    throw error;
  }
}

function getFallbackToken(provider: string): string {
  const envToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }

  throw new Error(
    `No ${provider} token available. Connect via Integrations or set PLATFORM_INTEGRATION_TOKEN.`
  );
}
