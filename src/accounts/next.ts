import { claudeAccounts, switchAccount } from "./api";

export interface SwitchResult {
  /** What the user calls the account we moved to. */
  label: string;
  /** How long the running agent may take to notice. 0 = next message. */
  settleSeconds: number;
}

/**
 * Move to the next saved Claude Code account, wrapping at the end.
 *
 * The switch itself is the backend's job and leaves the PTY, the session and
 * the conversation alone -- this only decides *which* account is next.
 *
 * Every refusal throws a sentence meant to be shown as-is. A shortcut fires
 * with no panel open and nothing under the cursor, so the checks the panel
 * makes visible have to be enforced here instead of merely displayed. The
 * unsaved-login one is not advisory: switching away from a live login that was
 * never saved drops its only copy.
 */
export async function switchToNextAccount(): Promise<SwitchResult> {
  const data = await claudeAccounts();

  if (!data.supported) {
    throw new Error(data.reason ?? "Account switching is not available here.");
  }
  if (data.accounts.length === 0) {
    throw new Error(
      "No saved accounts. Save the one you are signed in as from the agent panel first.",
    );
  }
  if (data.accounts.length === 1) {
    throw new Error(
      "Only one account saved. Sign in to another with ‘claude /login’ and save it too.",
    );
  }
  if (!data.activeSaved) {
    throw new Error(
      `Signed in as ${data.activeEmail ?? "an account"}, which is not saved here. Save it from the agent panel, or switching loses its login.`,
    );
  }

  // No active account among the saved ones means the live login is one we do
  // not hold, which `activeSaved` has already ruled out -- so this only ever
  // starts the cycle at the first entry.
  const at = data.accounts.findIndex((a) => a.isActive);
  const next = data.accounts[(at + 1) % data.accounts.length];

  await switchAccount(next.uuid);
  return { label: next.label, settleSeconds: data.settleSeconds };
}
