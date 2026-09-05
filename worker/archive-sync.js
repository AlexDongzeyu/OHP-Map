import { PUBLIC_DATA_KEY, syncSurvivors } from "./sync.js";

const JOB_KEY = "refresh-request";
const PUBLICATION_KEY = "prepared-publication";
const LOCK_MS = 15 * 60 * 1000;

export class ArchiveSync {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!["/run", "/bootstrap"].includes(path)) return new Response("Unknown refresh action.\n", { status: 404 });
    if (request.method !== "POST") return new Response("Use POST.\n", { status: 405, headers: { allow: "POST" } });
    return this.ctx.blockConcurrencyWhile(async () => {
      if (path === "/bootstrap" && await this.ctx.storage.get(PUBLICATION_KEY) === PUBLIC_DATA_KEY) {
        return Response.json({ state: "already-prepared" });
      }
      const job = await this.ctx.storage.get(JOB_KEY);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm !== null || (job && Date.now() - job.requestedAt < LOCK_MS)) {
        return Response.json({ state: "already-queued" }, { status: 202 });
      }
      await this.ctx.storage.put(JOB_KEY, { requestedAt: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ state: "queued" }, { status: 202 });
    });
  }

  async alarm() {
    const status = await syncSurvivors(this.env);
    if (status.state === "already-running") {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    if (status.state !== "ready") throw new Error(`Archive refresh did not complete: ${status.state}`);
    await this.ctx.storage.put(PUBLICATION_KEY, PUBLIC_DATA_KEY);
    await this.ctx.storage.delete(JOB_KEY);
  }
}
