/**
 * What the current setup says about the school: its mail domain (links and addresses under it count as
 * the school's) and its webmail. Filled from the server's /v1/chat/setup, or by the phone backend.
 */
export type AppConfig = { schoolDomain: string; webmailUrl: string };

let current: AppConfig = { schoolDomain: '', webmailUrl: '' };

export function appConfig(): AppConfig {
  return current;
}

export function setAppConfig(change: Partial<AppConfig>): void {
  current = {
    schoolDomain: (change.schoolDomain ?? current.schoolDomain).toLowerCase(),
    webmailUrl: change.webmailUrl ?? current.webmailUrl,
  };
}
