'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/browser';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination';
export const number = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString();
export function useRemote<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const lastPath = useRef(path);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    // oxlint-disable-next-line react/react-compiler -- Synchronize loading state with the external request lifecycle.
    setLoading(true);
    setError('');
    if (lastPath.current !== path) {
      setData(null);
      lastPath.current = path;
    }
    void api<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, version]);
  return { data, error, loading: loading && !data, reload };
}
export function LoadState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (error)
    return (
      <div className="error-panel" role="alert">
        <h3>We couldn’t load this view</h3>
        <p>{error}</p>
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <output aria-label="Loading" className="loading-grid">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-56 col-span-full" />
      </output>
    );
  return null;
}
export function NoData({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="empty-panel">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
export function PageControls({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="page-controls">
      <span>
        {total
          ? `${number(page * 50 + 1)}–${number(Math.min((page + 1) * 50, total))} of ${number(total)}`
          : '0 records'}
      </span>
      <Pagination className="w-auto mx-0">
        <PaginationContent>
          <PaginationItem>
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => onChange(page - 1)}
            >
              Previous
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * 50 >= total}
              onClick={() => onChange(page + 1)}
            >
              Next
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      {value.replaceAll('_', ' ')}
    </span>
  );
}
