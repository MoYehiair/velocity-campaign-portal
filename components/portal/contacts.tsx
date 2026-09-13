'use client';
import { useState } from 'react';
import { Search, Mail, MessageSquare } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useRemote, LoadState, NoData, PageControls, Status } from './common';
import type { Contact } from '@/lib/domain/types';
export function Contacts() {
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState('');
  const state = useRemote<{ rows: Contact[]; total: number }>(
    `/api/portal?view=contacts&page=${page}&search=${encodeURIComponent(query)}`,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR AUDIENCE</p>
          <h1>Contacts</h1>
          <p className="muted">Know who you can reach, and on which channel.</p>
        </div>
      </div>
      <section className="surface">
        <form
          className="search-row"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(0);
            setQuery(search);
          }}
        >
          <Search size={18} />
          <Input
            aria-label="Search contacts by name or email"
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
          />
          <Button variant="outline" type="submit">
            Search
          </Button>
        </form>
        <LoadState {...state} retry={state.reload} />
        {state.data && (
          <>
            {state.data.rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Contactable on</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.rows.map((c) => (
                    <TableRow key={c.external_id}>
                      <TableCell>
                        <strong>{c.full_name}</strong>
                        <small>
                          {c.email ?? c.phone ?? 'No valid contact details'}
                        </small>
                        <small>{c.external_id}</small>
                      </TableCell>
                      <TableCell>
                        {[c.city, c.country].filter(Boolean).join(', ') ||
                          'Unknown'}
                      </TableCell>
                      <TableCell>
                        <Status value={c.status} />
                      </TableCell>
                      <TableCell>
                        <div className="channel-pair">
                          {c.email_contactable && (
                            <span className="channel">
                              <Mail size={13} /> Email
                            </span>
                          )}
                          {c.sms_contactable && (
                            <span className="channel">
                              <MessageSquare size={13} /> SMS
                            </span>
                          )}
                          {!c.email_contactable && !c.sms_contactable && (
                            <span className="muted">Not contactable</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <NoData
                title={query ? 'No matching contacts' : 'No contacts imported'}
                description={
                  query
                    ? 'Try a different name or email.'
                    : 'Your brand’s contacts will appear after its data is imported.'
                }
              />
            )}
            <PageControls
              page={page}
              total={state.data.total}
              onChange={setPage}
            />
          </>
        )}
        <p className="method-note">
          Contactable requires active status, affirmative marketing consent, a
          valid channel destination, and no deletion, active suppression,
          bounce, complaint, or unsubscribe on that channel.
        </p>
      </section>
    </>
  );
}
