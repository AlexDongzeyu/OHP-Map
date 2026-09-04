import subprocess

from pipeline import config


def test_worker_media_inventory_changes_reset_caption_status():
    script = r"""
      import { mergeMediaCoverage } from './worker/media.js';
      const complete = {
        video_count: 2,
        video_inventory: '2:aaaaaaaa',
        captioned_video_count: 2,
        transcript_status: 'complete',
      };
      const same = mergeMediaCoverage(complete, {
        video_count: 2,
        video_inventory: '2:aaaaaaaa',
        transcript_status: 'pending',
      });
      const replaced = mergeMediaCoverage(complete, {
        video_count: 2,
        video_inventory: '2:bbbbbbbb',
        transcript_status: 'pending',
      });
      const added = mergeMediaCoverage(complete, {
        video_count: 3,
        video_inventory: '3:cccccccc',
        transcript_status: 'pending',
      });
      const removed = mergeMediaCoverage(complete, {
        video_count: 0,
        video_inventory: '0:811c9dc5',
        transcript_status: 'none',
      });
      if (same.transcript_status !== 'complete' || same.captioned_video_count !== 2) process.exit(1);
      if (replaced.transcript_status !== 'pending' || replaced.captioned_video_count !== 2) process.exit(2);
      if (added.transcript_status !== 'pending' || added.captioned_video_count !== 2) process.exit(3);
      if (removed.transcript_status !== 'none' || removed.captioned_video_count !== 0) process.exit(4);
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=config.ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
