import { route, json, HttpError } from '@/lib/server/http';
import { constantTime } from '@/lib/server/crypto';
import { setting } from '@/lib/server/env';
import { runWorker } from '@/lib/server/worker';
export function POST(request: Request) {
  return route(async () => {
    if (
      !constantTime(
        request.headers.get('Authorization') ?? '',
        `Bearer ${setting('CRON_SECRET')}`,
      )
    )
      throw new HttpError(401, 'Unauthorized');
    return json(await runWorker());
  });
}
