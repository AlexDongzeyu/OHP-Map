export const SAVED_ACCOUNTS_KEY = "ohp-map.saved-accounts.v1";
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_COLLECTION_LINK_LENGTH = 7000;

export class SavedAccountsError extends Error {}
export class CollectionLinkError extends Error {}
export class CitationError extends Error {}

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

export function addSavedAccounts(storage, byId, accountIds) {
  const accounts = accountIds.map(id => byId.get(id));
  if (!accounts.length || accounts.some(account => !account)) {
    throw new SavedAccountsError("Only available public accounts can be added to your saved list.");
  }
  const ids = readSavedAccounts(storage, byId);
  accounts.forEach(account => ids.add(account.id));
  storage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify({ version: 1, ids: [...ids] }));
  return ids;
}

export function decodeCollectionIds(value, byId) {
  if (typeof value !== "string" || !value || value.length > MAX_COLLECTION_LINK_LENGTH) {
    throw new CollectionLinkError("This reading-list link is empty or too long.");
  }
  const ids = value.split(",");
  if (ids.some(id => !ACCOUNT_ID.test(id))) {
    throw new CollectionLinkError("This reading-list link contains an invalid account identifier.");
  }
  return new Set(ids.map(id => byId.get(id)?.id || id));
}

export function collectionLink(accountIds, address) {
  const ids = [...new Set(accountIds)];
  if (!ids.length || ids.some(id => typeof id !== "string" || !ACCOUNT_ID.test(id))) {
    throw new CollectionLinkError("Choose available accounts before creating a reading-list link.");
  }
  const url = new URL(address);
  url.pathname = "/";
  url.search = "";
  url.hash = "/explore?" + new URLSearchParams({ list: ids.join(",") });
  if (url.href.length > MAX_COLLECTION_LINK_LENGTH) {
    throw new CollectionLinkError("This selection is too large for one reliable link. Narrow it with search or communities, or download its source citations.");
  }
  return url.href;
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
  url.hash = "";
  url.pathname = `/survivor/${journey.id}`;
  return url.href;
}

export function accountCitation(journey, accessed = new Date()) {
  let source;
  try { source = new URL(journey.archiveUrl); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new CitationError("The account has no supported original source URL.");
  }
  if (source.protocol !== "https:" || source.hostname !== "ohp.crestwood.on.ca" ||
      source.username || source.password) throw new CitationError("The account has no supported original source URL.");
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "long", day: "numeric",
  }).format(accessed);
  const name = journey.name.replace(/\s+/g, " ").trim();
  return `Crestwood Oral History Project. "${name}." ${source.href} Accessed ${date}.`;
}

export function collectionCitations(journeys, accessed = new Date()) {
  if (!journeys.length) throw new CitationError("There are no accounts in this selection to cite.");
  return `Crestwood Oral History Project - reading list\n${journeys.length} ${journeys.length === 1 ? "account" : "accounts"}\n\n` +
    journeys.map(journey => accountCitation(journey, accessed)).join("\n\n") +
    "\n\nThese citations refer to the original OHP pages, not verbatim transcripts. No interview dates are inferred. " +
    "Mapped references may require human review.\n";
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
