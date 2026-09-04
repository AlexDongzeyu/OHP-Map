export function mergeMediaCoverage(existing = {}, fresh = {}) {
  const videoCount = fresh.video_count || 0;
  const inventoryChanged = existing.video_inventory !== fresh.video_inventory;
  return {
    video_count: videoCount,
    video_inventory: fresh.video_inventory,
    captioned_video_count: Math.min(
      existing.captioned_video_count || 0,
      videoCount,
    ),
    transcript_status: inventoryChanged
      ? (videoCount ? "pending" : "none")
      : (existing.transcript_status || fresh.transcript_status || "none"),
  };
}
