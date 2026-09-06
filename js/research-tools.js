export const SAVED_ACCOUNTS_KEY = "ohp-map.saved-accounts.v1";
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]*$/;

export class SavedAccountsError extends Error {}

export function decodeSavedAccounts(value, byId) {
  if (value === null) return new Set();
  let saved;
  try {
    saved = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SavedAccountsError("The saved-account list could not be read.");
  }
  if (saved?.version !== 1 || !Array.isArray(saved.ids) ||
      saved.ids.some((id) => typeof id !== "string" || !ACCOUNT_ID.test(id))) {
    throw new SavedAccountsError("The saved-account list uses an unsupported format.");
  }
  return new Set(saved.ids.map((id) => byId.get(id)?.id || id));
}

export function readSavedAccounts(storage, byId) {
  return decodeSavedAccounts(storage.getItem(SAVED_ACCOUNTS_KEY), byId);
}

export function updateSavedAccount(storage, byId, id, saved) {
  const account = byId.get(id);
  if (!account) throw new SavedAccountsError("This account is not in the current collection.");
  const ids = readSavedAccounts(storage, byId);
  if (saved) ids.add(account.id);
  else ids.delete(account.id);
  storage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify({ version: 1, ids: [...ids] }));
  return ids;
}

export function isSavedAccountsFailure(error) {
  return error instanceof SavedAccountsError ||
    (error instanceof DOMException && ["SecurityError", "QuotaExceededError", "InvalidStateError",
      "NS_ERROR_DOM_QUOTA_REACHED"].includes(error.name));
}

export function accountLink(journey, address) {
  if (!ACCOUNT_ID.test(journey.id)) throw new Error("The account identifier is invalid.");
  const url = new URL(address);
  url.search = "";
  url.hash = `/survivor/${journey.id}`;
  return url.href;
}

export function accountCitation(journey, accessed = new Date()) {
  const source = new URL(journey.archiveUrl);
  if (source.protocol !== "https:" || source.hostname !== "ohp.crestwood.on.ca" ||
      source.username || source.password) throw new Error("The account has no supported original source URL.");
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "long", day: "numeric",
  }).format(accessed);
  const name = journey.name.replace(/\s+/g, " ").trim();
  return `Crestwood Oral History Project. "${name}." ${source.href} Accessed ${date}.`;
}

export async function copyText(text, clipboard) {
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch (error) {
    if (!(error instanceof DOMException) || !["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
    return false;
  }
}
