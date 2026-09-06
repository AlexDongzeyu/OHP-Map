import {
  INDEX_FORMAT, PROFILE_WRITE_BUDGET, catalogAliases, prepareArchive, profileKey, profileBackupKey, renderSitemap,
  seedCatalog, validCatalog,
} from "./publication.js";

export function pendingPublicationKey(indexKey) {
  return `${indexKey}:preparing`;
}

export async function publishArchive(env, doc, metadata, keys, {
  storage, resume = false, restart = false, previousVersion, seedCatalog: preparedSeed,
} = {}) {
  catalogAliases(doc.features);
  const pendingKey = pendingPublicationKey(keys.index);
  const completedKey = `${keys.index}:catalog`;
  const pending = (resume || restart) && storage ? await storage.get(pendingKey) : null;
  if (resume && (!pending || pending.metadata.version !== metadata.version)) {
    throw new Error("The pending archive publication no longer matches its full snapshot");
  }
  if (restart && (!pending || pending.metadata.version !== previousVersion)) {
    throw new Error("The pending archive changed before its seed could be reconciled");
  }
  const seed = preparedSeed ?? await seedCatalog(env);
  if (resume && pending.seed_version !== (seed?.version ?? null)) {
    throw new Error("The bundled seed changed; reconcile the pending archive before resuming");
  }
  const completed = storage && await storage.get(completedKey);
  const previous = completed ||
    (env.OHP_DATA.get && await env.OHP_DATA.get(keys.catalog, "json"));
  const priorRemote = new Set(validCatalog(previous) ? previous.remote || [] : []);
  const uploaded = { ...(pending?.uploaded || {}) };
  const archived = { ...(pending?.archived || {}) };
  let backups = {};
  let backupIds = [];
  let backupBytes = 0;
  async function flushBackups() {
    if (!backupIds.length) return;
    await storage.put(backups);
    for (const [id, hash] of backupIds) archived[id] = hash;
    backups = {};
    backupIds = [];
    backupBytes = 0;
  }
  const remote = [];
  let written = 0;
  let remaining = 0;
  let reused = 0;
  const state = { metadata, uploaded, archived, seed_version: seed?.version ?? null };
  const progress = () => ({
    version: metadata.version, written, remaining, seed_profiles: reused,
    seed_version: state.seed_version, rebased: restart,
  });
  // The old endpoint remains current even during a multi-hour compact bootstrap.
  // The index itself is never replaced with an incomplete subset.
  if (!resume) {
    if (restart && storage) {
      // KV and SQLite cannot commit together. Journal the replacement before its
      // full-body write so an interrupted rebase can recover either valid version.
      await storage.put(pendingKey, {
        ...pending, replacement: { metadata, seed_version: state.seed_version },
      });
    }
    await env.OHP_DATA.put(keys.full, JSON.stringify(doc), { metadata });
  }
  if (storage) await storage.put(pendingKey, state);
  try {
    const { index, catalog } = await prepareArchive(doc, metadata.version, async ({ id, hash, body }) => {
      // SQLite-local batched backups do not consume KV writes. They cover KV's
      // eventual propagation and old bundled hashes after a clean deployment.
      // No request needs to open or parse the full archive to recover a detail.
      if (storage && archived[id] !== hash && completed?.profiles[id] !== hash) {
        backups[profileBackupKey(id, hash)] = body;
        backupIds.push([id, hash]);
        backupBytes += body.length * 2;
        if (backupIds.length >= 64 || backupBytes >= 500_000) await flushBackups();
      }
      if (seed?.profiles[id] === hash) {
        reused++;
        return;
      }
      if (uploaded[id] === hash || (priorRemote.has(id) && previous.profiles[id] === hash)) {
        remote.push(id);
        return;
      }
      if (written >= PROFILE_WRITE_BUDGET) {
        remaining++;
        return;
      }
      await env.OHP_DATA.put(profileKey(id, hash), body, {
        metadata: { detail_format: INDEX_FORMAT, id, hash },
      });
      uploaded[id] = hash;
      remote.push(id);
      written++;
    });
    await flushBackups();
    if (remaining) {
      if (!storage) throw new Error("Large archive publications require Durable Object staging storage");
      await storage.put(pendingKey, state);
      return { complete: false, ...progress() };
    }
    catalog.remote = remote;
    const publishedMetadata = { ...metadata, index_format: INDEX_FORMAT };
    // All detail writes must finish before either discovery document can reference
    // them. Immutable keys have no expiry, so an older cached index stays usable.
    await env.OHP_DATA.put(keys.catalog, JSON.stringify(catalog), { metadata: publishedMetadata });
    await env.OHP_DATA.put(keys.sitemap, renderSitemap(catalog, env.SITE_ORIGIN), { metadata: publishedMetadata });
    await env.OHP_DATA.put(keys.index, JSON.stringify(index), { metadata: publishedMetadata });
    if (storage) {
      await storage.put(completedKey, catalog);
      await storage.delete(pendingKey);
    }
    return { complete: true, ...progress() };
  } catch (error) {
    // Keep successful writes on a failed batch; a retry must not rewrite them or
    // advance the public index past an unavailable profile.
    if (storage) await storage.put(pendingKey, state);
    throw error;
  }
}
