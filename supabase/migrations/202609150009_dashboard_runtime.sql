-- Avoid per-request JIT compilation overhead on the interactive dashboard.
-- This leaves query results, SECURITY INVOKER and RLS unchanged.
alter function public.dashboard_metrics() set jit = off;
