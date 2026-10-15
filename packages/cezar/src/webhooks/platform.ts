/** Ownership fencing verifies Linux process identity through /proc. */
export function webhookPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

export const WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE =
  'Webhooks are unsupported on this platform. Delivery requires a Linux server with /proc available for verified ownership.';
