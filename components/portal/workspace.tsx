'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Layers3,
  LayoutDashboard,
  Users,
  Send,
  FileSpreadsheet,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { brands, type Membership } from '@/lib/domain/types';
import { browserDatabase } from '@/lib/browser';
import { useRemote, LoadState } from './common';
import { Dashboard } from './dashboard';
import { Contacts } from './contacts';
import { Campaigns } from './campaigns';
import { Imports } from './imports';
const navigation = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'campaigns', label: 'Campaigns', icon: Send },
  { id: 'imports', label: 'Import history', icon: FileSpreadsheet },
] as const;
type View = (typeof navigation)[number]['id'];
export function Workspace() {
  const state = useRemote<Membership>('/api/portal?view=membership');
  const [view, setView] = useState<View>('dashboard'),
    [campaign, setCampaign] = useState<string | null>(null);
  const member = state.data;
  const brand = member ? brands[member.tenant_id] : null;
  // A small read/navigation tool uses exactly the same authorized views as the UI.
  useEffect(() => {
    const context = (
      document as unknown as {
        modelContext?: {
          registerTool: (tool: unknown, options: unknown) => Promise<void>;
        };
      }
    ).modelContext;
    if (!context || !member) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'open_campaign_workspace_view',
          description:
            'Open an existing view in the signed-in brand workspace. Does not send campaigns or change data.',
          inputSchema: {
            type: 'object',
            properties: {
              view: { type: 'string', enum: navigation.map((n) => n.id) },
            },
            required: ['view'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: (input: unknown) => {
            const value = input as { view?: string };
            if (!navigation.some((n) => n.id === value?.view))
              throw new Error('Unknown workspace view');
            setView(value.view as View);
            setCampaign(null);
            return { view: value.view, brand: member.tenant_id };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [member]);
  async function signOut() {
    const db = await browserDatabase();
    await db.auth.signOut();
    window.location.assign('/');
  }
  if (!member || !brand)
    return (
      <main className="center-page">
        <LoadState {...state} retry={state.reload} />
        {state.error && (
          <Link className="text-link" href="/">
            Return to sign in
          </Link>
        )}
      </main>
    );
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '240px' } as React.CSSProperties}
    >
      <Sidebar className="portal-sidebar">
        <SidebarHeader className="sidebar-brand">
          <div className="wordmark">
            <Layers3 size={24} />
            velocity
          </div>
          <span>CAMPAIGN PORTAL</span>
        </SidebarHeader>
        <SidebarContent>
          <div className="tenant-card">
            <span className="tenant-avatar">{brand.initials}</span>
            <div>
              <strong>{brand.name}</strong>
              <small>{brand.country}</small>
            </div>
          </div>
          <p className="sidebar-label">WORKSPACE</p>
          <SidebarMenu className="px-3">
            {navigation.map(({ id, label, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  isActive={view === id}
                  onClick={() => {
                    setView(id);
                    setCampaign(null);
                  }}
                  className="nav-button"
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="sidebar-security">
            <ShieldCheck size={20} />
            <p>
              Your brand’s space.
              <br />
              <span>Only your team has access.</span>
            </p>
          </div>
        </SidebarContent>
        <SidebarFooter className="sidebar-user">
          <div>
            <strong>
              {member.role === 'owner' ? 'Brand owner' : 'Brand analyst'}
            </strong>
            <small>{member.email}</small>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void signOut()}
            aria-label="Sign out"
          >
            <LogOut />
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="portal-inset">
        <header className="workspace-header">
          <div className="header-left">
            <SidebarTrigger />
            <span>{brand.name}</span>
            <span className="header-divider">/</span>
            <span>{navigation.find((n) => n.id === view)?.label}</span>
          </div>
          <span className="role-badge">
            {member.role === 'owner' ? 'Owner access' : 'Read-only access'}
          </span>
        </header>
        <main className="workspace-content">
          {view === 'dashboard' && (
            <Dashboard
              tenant={member.tenant_id}
              onCampaign={(id) => {
                setCampaign(id);
                setView('campaigns');
              }}
            />
          )}
          {view === 'contacts' && <Contacts />}
          {view === 'campaigns' && (
            <Campaigns
              owner={member.role === 'owner'}
              selected={campaign}
              onSelect={setCampaign}
            />
          )}{' '}
          {view === 'imports' && <Imports />}
        </main>
        <footer className="workspace-footer">
          <span>Velocity Growth · {brand.name}</span>
          <span>Campaign workspace</span>
        </footer>
      </SidebarInset>
    </SidebarProvider>
  );
}
