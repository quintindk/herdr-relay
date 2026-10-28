// Disposable smoke-only navigation driver. Production attachment logic is not
// bypassed: normal native creation events and the selected TUI route drive it.
import { Plugin } from '@opencode/plugin/tui';
import { existsSync } from 'node:fs';

export default Plugin.define({
  id: 'herdr.relay.smoke.new-chat',
  async setup(ctx) {
    let used = false;
    const timer = setInterval(async () => {
      if (used || !existsSync(ctx.options.trigger)) return;
      used = true;
      const location = ctx.location ?? ctx.data.location.default();
      ctx.ui.router.navigate({ type: 'home' });
      const session = await ctx.client.session.create({ location: { directory: location.directory }, title: 'Automatic replacement fixture' });
      ctx.ui.router.navigate({ type: 'session', sessionID: session.id });
    }, 100);
    return () => clearInterval(timer);
  },
});
