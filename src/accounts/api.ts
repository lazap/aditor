import { invoke } from "@tauri-apps/api/core";

export interface Account {
  uuid: string;
  email: string;
  /** What the user calls this account. Defaults to the email. */
  label: string;
  addedAt: number;
  isActive: boolean;
}

export interface Accounts {
  /** False for a setup we cannot switch safely -- a state, not an error. */
  supported: boolean;
  /** Why, when `supported` is false. Shown verbatim. */
  reason: string | null;
  activeUuid: string | null;
  activeEmail: string | null;
  /** False when the live login has never been saved here. */
  activeSaved: boolean;
  /** Where the live credential lives, named for the user. */
  store: string;
  /** How long a running agent can take to notice a switch. 0 = next message. */
  settleSeconds: number;
  accounts: Account[];
}

export const claudeAccounts = () => invoke<Accounts>("claude_accounts");

export const saveCurrentAccount = () => invoke<Account>("claude_account_save");

export const switchAccount = (uuid: string) =>
  invoke<void>("claude_account_switch", { uuid });

export const renameAccount = (uuid: string, label: string) =>
  invoke<void>("claude_account_rename", { uuid, label });

export const forgetAccount = (uuid: string) =>
  invoke<void>("claude_account_forget", { uuid });
