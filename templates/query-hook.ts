// Append to: src/lib/queries.ts  (uses the file's existing qk, unwrap, selectOne).
// Reads go directly through supabase under RLS — no firm_id filter needed, RLS
// scopes rows to the caller's firm. Server-authoritative writes use a function.

// 1) add the query key to the `qk` object:
//    <name>: (id: string) => ['<name>', id] as const,

// 2) the hook:
export function use<Name>(id: string | undefined): UseQueryResult<<Row> | null> {
  return useQuery({
    queryKey: qk.<name>(id ?? ''),
    enabled: !!id,
    queryFn: () => selectOne<<Row>>('<table>', id!),
  });
}

// List variant:
export function use<Name>List(): UseQueryResult<<Row>[]> {
  return useQuery({
    queryKey: qk.<name>List(),
    queryFn: async () => unwrap<<Row>[]>(await supabase.from('<table>').select('*')),
  });
}
