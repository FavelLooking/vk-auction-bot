import { config } from '../../config.js';
import { createWallPost } from '../../vk.js';

/**
 * Publisher contract:
 * publish({ groupId, auctionPostId, scheduleTime, message, attachments, auctionUrl, expiresAt })
 *   -> Promise<{ status: 'pending' | 'published', postId?: number, reason?: string }>
 * A pending result is not a successful VK publication and must not trigger retries.
 */
export class PackageOnlyPublisher {
  name = 'package-only';

  async publish() {
    return { status: 'pending', reason: config.dryRun ? 'dry_run' : 'package-only mode; publication disabled' };
  }
}

export class GroupTokenReminderPublisher {
  name = 'group-token';

  async publish(payload) {
    const result = await createWallPost(payload);
    return { status: 'published', postId: result.post_id };
  }
}

// Compatibility reference only; normal configuration selects group-token.
export class ExistingVkWallPublisher extends GroupTokenReminderPublisher {
  name = 'existing-vk-wall';
}

export function getReminderPublisher() {
  if (config.dryRun || ['package-only', 'disabled'].includes(config.reminderPublisher)) {
    return new PackageOnlyPublisher();
  }
  if (config.reminderPublisher === 'group-token') {
    return new GroupTokenReminderPublisher();
  }
  throw new Error('Unknown reminder publisher');
}
