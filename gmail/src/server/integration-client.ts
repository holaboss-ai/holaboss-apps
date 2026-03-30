const BROKER_URL = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "";
const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? "";

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
  if (!BROKER_URL || !APP_GRANT) {
    return getFallbackToken(provider);
  }

  const brokerTokenUrl = `${BROKER_URL}/broker/token`;
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
