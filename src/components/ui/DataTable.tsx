import { useMemo, useState, type ReactNode } from 'react';
import { SkeletonLines } from './Skeleton';
import { EmptyState } from './EmptyState';

export interface Column<Row> {
  key: string;
  header: string;
  numeric?: boolean;
  // Cell renderer; defaults to String(row[key]).
  render?: (row: Row) => ReactNode;
  // Sort accessor; if omitted the column is not sortable.
  sortValue?: (row: Row) => number | string;
}

// Sortable table with sticky header and first-class loading / empty / error
// states (spec §7 — every async surface has all three).
export function DataTable<Row>({
  columns,
  rows,
  keyFor,
  onRowClick,
  loading,
  error,
  empty,
  initialSort,
}: {
  columns: Column<Row>[];
  rows: Row[];
  keyFor: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  error?: string | null;
  empty?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    initialSort ?? null,
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort, columns]);

  if (loading) {
    return (
      <div className="ui-table-wrap" style={{ padding: '1rem' }}>
        <SkeletonLines lines={5} />
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState icon="warning" title="Couldn’t load this">
        {error}
      </EmptyState>
    );
  }
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }

  const toggleSort = (key: string) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );

  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const isSorted = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={c.numeric ? 'num' : undefined}
                  aria-sort={
                    c.sortValue
                      ? isSorted
                        ? sort!.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                >
                  {c.sortValue ? (
                    <button
                      className="ui-table-sort"
                      onClick={() => toggleSort(c.key)}
                      aria-label={`Sort by ${c.header}`}
                    >
                      {c.header}
                      {isSorted && (
                        <span className="ui-table-sort-arrow" aria-hidden>
                          {sort!.dir === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={keyFor(row)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined}>
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
