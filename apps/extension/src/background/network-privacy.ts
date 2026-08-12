export type WebRtcPrivacyState = {
  supported: boolean;
  requested: string;
  effective?: string;
  controlledBy?: string;
  error?: string;
};

type PrivacySettingResult = {
  value?: unknown;
  levelOfControl?: string;
};

type PrivacySetting = {
  set(details: { value: string }, callback?: () => void): void;
  get(details: Record<string, never>, callback: (details: PrivacySettingResult) => void): void;
};

const REQUESTED_POLICY = 'disable_non_proxied_udp';

export async function enforceNetworkPrivacy(): Promise<WebRtcPrivacyState> {
  const setting = privacySetting();
  if (!setting) return { supported: false, requested: REQUESTED_POLICY, error: 'Chrome privacy.network.webRTCIPHandlingPolicy is unavailable.' };
  try {
    await setPrivacyValue(setting, REQUESTED_POLICY);
    const current = await getPrivacyValue(setting);
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
  const setting = privacySetting();
  if (!setting) return { supported: false, requested: REQUESTED_POLICY };
  try {
    const current = await getPrivacyValue(setting);
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

function privacySetting(): PrivacySetting | undefined {
  return chrome.privacy?.network?.webRTCIPHandlingPolicy as unknown as PrivacySetting | undefined;
}

function setPrivacyValue(setting: PrivacySetting, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setting.set({ value }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function getPrivacyValue(setting: PrivacySetting): Promise<PrivacySettingResult> {
  return new Promise((resolve, reject) => {
    setting.get({}, (details) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(details);
    });
  });
}
