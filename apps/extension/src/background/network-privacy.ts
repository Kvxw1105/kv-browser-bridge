export type WebRtcPrivacyState = {
  supported: boolean;
  requested: string;
  effective?: string;
  controlledBy?: string;
  error?: string;
};

const REQUESTED_POLICY = 'disable_non_proxied_udp';

export async function enforceNetworkPrivacy(): Promise<WebRtcPrivacyState> {
  const setting = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!setting) return { supported: false, requested: REQUESTED_POLICY, error: 'Chrome privacy.network.webRTCIPHandlingPolicy is unavailable.' };
  try {
    await setting.set({ value: REQUESTED_POLICY });
    const current = await setting.get({});
    return {
      supported: true,
      requested: REQUESTED_POLICY,
      effective: String(current.value ?? ''),
      controlledBy: current.levelOfControl,
    };
  } catch (error) {
    return {
      supported: true,
      requested: REQUESTED_POLICY,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readNetworkPrivacy(): Promise<WebRtcPrivacyState> {
  const setting = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!setting) return { supported: false, requested: REQUESTED_POLICY };
  try {
    const current = await setting.get({});
    return {
      supported: true,
      requested: REQUESTED_POLICY,
      effective: String(current.value ?? ''),
      controlledBy: current.levelOfControl,
    };
  } catch (error) {
    return { supported: true, requested: REQUESTED_POLICY, error: error instanceof Error ? error.message : String(error) };
  }
}
