'use client';
import { useState } from 'react';
import { FileSpreadsheet, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  useRemote,
  LoadState,
  NoData,
  PageControls,
  Status,
  number,
} from './common';
interface ImportRun {
  id: string;
  file_name: string;
  status: string;
  total_rows: number;
  loaded_rows: number;
  rejected_rows: number;
  duplicate_rows: number;
  warning_rows: number;
  error_message: string | null;
}
interface Issue {
  id: number;
  row_number: number;
  external_id: string | null;
  severity: string;
  reason: string;
}
function Issues({ id, onBack }: { id: string; onBack: () => void }) {
  const [page, setPage] = useState(0);
  const state = useRemote<{ rows: Issue[]; total: number }>(
    `/api/portal?view=issues&id=${id}&page=${page}`,
  );
  return (
    <>
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        All imports
      </Button>
      <LoadState {...state} retry={state.reload} />
      {state.data && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>What happened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.rows.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.row_number || '—'}</TableCell>
                  <TableCell>{i.external_id ?? '—'}</TableCell>
                  <TableCell>
                    <Status value={i.severity} />
                  </TableCell>
                  <TableCell className="wrap-cell">{i.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!state.data.rows.length && (
            <NoData
              title="No issues recorded"
              description="This import did not produce any diagnostics."
            />
          )}
          <PageControls
            page={page}
            total={state.data.total}
            onChange={setPage}
          />
        </>
      )}
    </>
  );
}
export function Imports() {
  const state = useRemote<ImportRun[]>('/api/portal?view=imports');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DATA QUALITY</p>
          <h1>Import history</h1>
          <p className="muted">See what loaded, what didn’t, and why.</p>
        </div>
        <FileSpreadsheet size={28} />
      </div>
      <section className="surface">
        {selected ? (
          <Issues id={selected} onBack={() => setSelected(null)} />
        ) : (
          <>
            <LoadState {...state} retry={state.reload} />
            {state.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source file</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Loaded</TableHead>
                    <TableHead>Rejected</TableHead>
                    <TableHead>Duplicates</TableHead>
                    <TableHead>Warnings</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <button
                          className="text-link"
                          onClick={() => setSelected(run.id)}
                        >
                          {run.file_name}
                        </button>
                        <small>{number(run.total_rows)} source rows</small>
                        {run.error_message && (
                          <small className="error">{run.error_message}</small>
                        )}
                      </TableCell>
                      <TableCell>
                        <Status value={run.status} />
                      </TableCell>
                      <TableCell>{number(run.loaded_rows)}</TableCell>
                      <TableCell>{number(run.rejected_rows)}</TableCell>
                      <TableCell>{number(run.duplicate_rows)}</TableCell>
                      <TableCell>{number(run.warning_rows)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              state.data && (
                <NoData
                  title="No imports yet"
                  description="Your brand’s import runs and row-level diagnostics will appear here."
                />
              )
            )}
          </>
        )}
        <p className="method-note">
          Warnings may overlap loaded rows. Invalid fields are omitted with a
          reason; malformed or conflicting records are quarantined. Reimporting
          a completed file does not create duplicate records.
        </p>
      </section>
    </>
  );
}
