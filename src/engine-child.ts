import { CanvasServer } from './server.ts';

let server: CanvasServer | null = null;
process.on('message', (message: { id: number; name: string; args: Record<string, unknown> }) => {
  void (async () => {
    if (message.name === 'init') {
      server = new CanvasServer({
        directory: message.args.directory as string, port: message.args.port as number,
        onReferences: (references) => process.send?.({ event: 'references', references }),
        onGameEvent: (text) => process.send?.({ event: 'game', text }),
      });
      await server.start();
      return { url: server.url };
    }
    if (!server) throw new Error('画布尚未初始化');
    if (message.name === 'stop') { await server.stop(); return null; }
    return server.command(message.name, message.args);
  })().then((value) => {
    if (process.connected) process.send?.({ id: message.id, value });
  }).catch((error) => { if (process.connected) process.send?.({ id: message.id, error: String(error.message ?? error) }); });
});
process.on('disconnect', () => { void server?.abort().finally(() => process.exit(0)); });
