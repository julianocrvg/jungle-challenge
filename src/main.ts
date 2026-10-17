import { createApp } from './app';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
