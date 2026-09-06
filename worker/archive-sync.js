import { INDEX_KEY, syncSurvivors } from "./sync.js";
import { DETAIL_PATTERN, profileBackupKey } from "./publication.js";

const JOB_KEY = "refresh-request";
const PUBLICATION_KEY = "prepared-publication";
const LOCK_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LAST_RUN_KEY = "last-refresh-start";

export class ArchiveSync {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const detail = path.match(DETAIL_PATTERN);
    if (detail) {
      if (!["GET", "HEAD"].includes(request.method)) {
        return new Response("Use GET or HEAD.\n", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const body = await this.ctx.storage.get(profileBackupKey(detail[1], detail[2]));
      if (typeof body !== "string") return new Response("Unknown public profile version.\n", { status: 404 });
      return new Response(request.method === "HEAD" ? null : body, {
        headers: { "content-type": "application/json; charset=utf-8", etag: `"${detail[2]}"` },
      });
    }
    if (!["/run", "/bootstrap"].includes(path)) return new Response("Unknown refresh action.\n", { status: 404 });
    if (request.method !== "POST") return new Response("Use POST.\n", { status: 405, headers: { allow: "POST" } });
    return this.ctx.blockConcurrencyWhile(async () => {
      if (path === "/bootstrap" && await this.ctx.storage.get(PUBLICATION_KEY) === INDEX_KEY) {
        return Response.json({ state: "already-prepared" });
      }
      const job = await this.ctx.storage.get(JOB_KEY);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm !== null || (job && Date.now() - job.requestedAt < LOCK_MS)) {
        return Response.json({ state: "already-queued" }, { status: 202 });
      }
      await this.ctx.storage.put(JOB_KEY, { requestedAt: Date.now() });
      const lastRun = await this.ctx.storage.get(LAST_RUN_KEY) || 0;
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, lastRun + HOUR_MS));
      return Response.json({ state: "queued" }, { status: 202 });
    });
  }

  async alarm() {
    const lastRun = await this.ctx.storage.get(LAST_RUN_KEY) || 0;
    if (Date.now() < lastRun + HOUR_MS) {
      await this.ctx.storage.setAlarm(lastRun + HOUR_MS);
      return;
    }
    await this.ctx.storage.put(LAST_RUN_KEY, Date.now());
    const status = await syncSurvivors(this.env, { publicationStorage: this.ctx.storage });
    if (status.state === "already-running") {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    if (status.state === "preparing-index") {
      await this.ctx.storage.put(JOB_KEY, { requestedAt: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
      return;
    }
    if (status.state !== "ready") throw new Error(`Archive refresh did not complete: ${status.state}`);
    await this.ctx.storage.put(PUBLICATION_KEY, INDEX_KEY);
    await this.ctx.storage.delete(JOB_KEY);
  }
}
