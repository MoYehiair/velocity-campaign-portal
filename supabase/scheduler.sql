-- Run separately AFTER deployment. This file does not contain real secrets.
-- Enable pg_cron and pg_net in the Supabase Extensions dashboard first.
-- Create Vault secrets named 'velocity_app_url' and 'velocity_cron_secret'.
-- The app URL must be public at the hosting layer; /api/worker authenticates its bearer secret.
select cron.schedule(
 'velocity-campaign-worker',
 '* * * * *',
 $$select net.http_post(
   url := (select decrypted_secret from vault.decrypted_secrets where name='velocity_app_url') || '/api/worker',
   headers := jsonb_build_object(
     'Content-Type','application/json',
     'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='velocity_cron_secret')
   ),
   body := '{}'::jsonb,
   timeout_milliseconds := 55000
 );$$
);
-- Verify cron.job_run_details and net._http_response after enabling the schedule.
-- A successful cron tick alone does not prove the HTTP worker succeeded.
