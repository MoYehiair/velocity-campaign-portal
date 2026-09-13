// Execute with a Supabase management access token, NOT the project's anon/service key.
import { setting } from '../lib/server/env';
const ref = new URL(setting('SUPABASE_URL')).hostname.split('.')[0];
const response = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/config/auth`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${setting('SUPABASE_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      site_url: setting('APP_URL'),
      uri_allow_list: `${setting('APP_URL')}/auth/callback`,
      disable_signup: true,
      external_google_enabled: true,
      external_google_client_id: setting('GOOGLE_CLIENT_ID'),
      external_google_secret: setting('GOOGLE_CLIENT_SECRET'),
    }),
  },
);
if (!response.ok)
  throw new Error(`Auth configuration failed: ${response.status}`);
console.log(
  'Public signups disabled; Google provider and callback configured.',
);
