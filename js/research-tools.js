import { isChapterId } from "./media.js";

export const SAVED_ACCOUNTS_KEY = "ohp-map.saved-accounts.v1";
export const MAX_SAVED_LIST_FILE_BYTES = 1_000_000;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_COLLECTION_LINK_LENGTH = 7000;
const MAX_SAVED_LIST_FILE_ACCOUNTS = 10_000;

export class SavedAccountsError extends Error {}
export class SavedListFileError extends Error {}
export class CollectionLinkError extends Error {}
export class CitationError extends Error {}
export class ChapterLinkError extends Error {}

function savedAccountIds(saved, byId) {
  if (saved?.version !== 1 || !Array.isArray(saved.ids) ||
      saved.ids.some((id) => typeof id !== "string" || !ACCOUNT_ID.test(id))) {
    throw new SavedAccountsError("The saved-account list uses an unsupported format.");
  }
  return new Set(saved.ids.map((id) => byId.get(id)?.id || id));
}

export function decodeSavedAccounts(value, byId) {
  if (value === null) return new Set();
  let saved;
  try {
    saved = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SavedAccountsError("The saved-account list could not be read.");
  }
  return savedAccountIds(saved, byId);
}

export function readSavedAccounts(storage, byId) {
  return decodeSavedAccounts(storage.getItem(SAVED_ACCOUNTS_KEY), byId);
}

export function decodeSavedListFile(text, byId) {
  if (typeof text !== "string") throw new SavedListFileError("Choose a saved-list backup file.");
  if (new TextEncoder().encode(text).length > MAX_SAVED_LIST_FILE_BYTES) {
    throw new SavedListFileError("This backup is larger than 1 MB. Choose a smaller saved-list backup.");
  }
  let file;
  try { file = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SavedListFileError("This file is not valid JSON. Choose a backup downloaded from Saved accounts.");
  }
  if (file?.format !== "ohp-saved-accounts" || file.version !== 1 || !Array.isArray(file.ids) ||
      Object.keys(file).some(key => !["format", "version", "ids"].includes(key))) {
    throw new SavedListFileError("This is not a supported OHP saved-list backup. Citation and source-review files cannot be restored here.");
  }
  if (file.ids.length > MAX_SAVED_LIST_FILE_ACCOUNTS) {
    throw new SavedListFileError("One backup can contain up to 10,000 accounts. This file has not been added.");
  }
  return savedAccountIds(file, byId);
}

export function savedListFile(accountIds) {
  const text = JSON.stringify({ format: "ohp-saved-accounts", version: 1, ids: [...new Set(accountIds)] }, null, 2) + "\n";
  decodeSavedListFile(text, new Map());
  return text;
}

export function restoreSavedList(storage, byId, accountIds) {
  const incoming = decodeSavedListFile(savedListFile(accountIds), byId);
  const ids = readSavedAccounts(storage, byId);
  const previous = ids.size;
  incoming.forEach(id => ids.add(id));
  // The complete merged list must remain exportable; never truncate a restore.
  savedListFile(ids);
  if (ids.size !== previous) {
    storage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify({ version: 1, ids: [...ids] }));
  }
  return { ids, added: ids.size - previous };
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

export function chapterLink(journey, id, address) {
  if (typeof journey?.id !== "string" || !ACCOUNT_ID.test(journey.id) ||
      !isChapterId(id) || !Array.isArray(journey.media?.videos) || !journey.media.videos.some(video => video.id === id)) {
    throw new ChapterLinkError("That chapter is not listed in this account. Open the original OHP page or choose an available chapter.");
  }
  const url = new URL(accountLink(journey, address));
  url.searchParams.set("chapter", id);
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
